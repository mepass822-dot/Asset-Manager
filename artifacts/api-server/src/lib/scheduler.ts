import { db, walletsTable, rulesTable, agentLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { decryptMnemonic } from "./crypto";
import { queryBalance, sendMEC, getPrivateKeyHex } from "./blockchain";
import { agentDecide } from "./nvidia";
import { logger } from "./logger";

export interface SchedulerConfig {
  intervalMs: number;
  walletIds: number[];
  masterPassword: string;
  dryRun: boolean;
}

export interface SchedulerStatus {
  enabled: boolean;
  intervalMs: number | null;
  walletIds: number[];
  dryRun: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: { executed: number; skipped: number } | null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let config: SchedulerConfig | null = null;
let nextRunAt: Date | null = null;
let lastRunAt: Date | null = null;
let lastRunResult: { executed: number; skipped: number } | null = null;

export function getSchedulerStatus(): SchedulerStatus {
  return {
    enabled: timer !== null,
    intervalMs: config?.intervalMs ?? null,
    walletIds: config?.walletIds ?? [],
    dryRun: config?.dryRun ?? true,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastRunResult,
  };
}

export function startScheduler(cfg: SchedulerConfig): void {
  stopScheduler();
  config = cfg;

  const run = async () => {
    lastRunAt = new Date();
    nextRunAt = new Date(Date.now() + cfg.intervalMs);
    logger.info({ walletIds: cfg.walletIds, dryRun: cfg.dryRun }, "Scheduled agent run starting");

    try {
      const result = await runAgentOnce(cfg);
      lastRunResult = { executed: result.executed, skipped: result.skipped };
      logger.info({ executed: result.executed, skipped: result.skipped }, "Scheduled agent run complete");
    } catch (err) {
      logger.error({ err }, "Scheduled agent run failed");
      lastRunResult = { executed: 0, skipped: cfg.walletIds.length };
    }
  };

  nextRunAt = new Date(Date.now() + cfg.intervalMs);
  timer = setInterval(run, cfg.intervalMs);
  logger.info({ intervalMs: cfg.intervalMs, walletIds: cfg.walletIds }, "Scheduler started");
}

export function stopScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    nextRunAt = null;
    logger.info("Scheduler stopped");
  }
}

async function runAgentOnce(cfg: SchedulerConfig): Promise<{ executed: number; skipped: number }> {
  const apiKey = process.env["NVIDIA_API_KEY"] ?? "";
  if (!apiKey) {
    await db.insert(agentLogsTable).values({
      action: "scheduled_run",
      status: "error",
      message: "Scheduler: NVIDIA_API_KEY not configured",
    });
    return { executed: 0, skipped: cfg.walletIds.length };
  }

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(sql`${walletsTable.id} = ANY(${cfg.walletIds})`);

  const rules = await db.select().from(rulesTable).where(eq(rulesTable.enabled, true));

  const walletSummaries = await Promise.all(
    wallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network);
      return { label: w.label, address: w.address, balance: `${bal.balance} ${bal.denom}` };
    })
  );

  let decisions: Awaited<ReturnType<typeof agentDecide>> = [];
  try {
    decisions = await agentDecide(
      walletSummaries,
      rules.map((r) => ({ name: r.name, ruleType: r.ruleType, conditionJson: r.conditionJson, actionJson: r.actionJson })),
      apiKey
    );
  } catch (err) {
    await db.insert(agentLogsTable).values({
      action: "scheduled_run",
      status: "error",
      message: `Scheduler AI error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { executed: 0, skipped: cfg.walletIds.length };
  }

  let executed = 0;
  const skipped = cfg.walletIds.length - decisions.length;

  for (const decision of decisions) {
    const wallet = wallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;

    if (cfg.dryRun) {
      await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: decision.action,
        status: "dry_run",
        amount: decision.amount ?? null,
        message: `[SCHEDULED DRY RUN] ${decision.reason}`,
      });
      executed++;
      continue;
    }

    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, cfg.masterPassword);
      const isTransfer = /withdraw|send|transfer/i.test(decision.action);
      const toAddress: string | undefined = (decision as { toAddress?: string }).toAddress;

      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const amountMEC = parseFloat(String(decision.amount));
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC, memo: `scheduler: ${decision.reason}` });
        await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: decision.action,
          status: "success",
          amount: decision.amount ?? null,
          txHash: result.txHash,
          message: `[SCHEDULED] ${decision.reason} | TX: ${result.txHash}`,
        });
      } else {
        await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: decision.action,
          status: "success",
          amount: decision.amount ?? null,
          message: `[SCHEDULED] ${decision.reason}`,
        });
      }
      executed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: decision.action,
        status: "error",
        message: `[SCHEDULED] ${msg}`,
      });
    }
  }

  return { executed, skipped };
}
