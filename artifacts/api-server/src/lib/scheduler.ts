import { db, walletsTable, rulesTable, agentLogsTable, sweepConfigTable, whitelistTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { decryptMnemonic } from "./crypto";
import { queryBalance, queryStakingRewards, claimAllStakingRewards, sweepToMaster, getPrivateKeyHex, sendMEC } from "./blockchain";
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

// ─── Sweep Config Helpers ──────────────────────────────────────────────────

async function getSweepConfig() {
  const rows = await db.select().from(sweepConfigTable).limit(1);
  if (rows.length > 0) return rows[0];
  // Auto-create default config
  const [created] = await db.insert(sweepConfigTable).values({}).returning();
  return created;
}

// ─── Dividend Window Detection ─────────────────────────────────────────────

function isDividendWindow(dayOfMonth: number, windowDays: number): boolean {
  return dayOfMonth >= 1 && dayOfMonth <= windowDays;
}

// ─── Main Scheduler Loop ───────────────────────────────────────────────────

async function runAgentOnce(cfg: SchedulerConfig): Promise<{ executed: number; skipped: number }> {
  const apiKey = process.env["NVIDIA_API_KEY"] ?? "";
  const sweepCfg = await getSweepConfig();

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const inDividendWindow = isDividendWindow(dayOfMonth, sweepCfg.dividendWindowDays);
  const minSweepMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");

  if (!apiKey) {
    await db.insert(agentLogsTable).values({
      action: "scheduled_run",
      status: "error",
      message: "Scheduler: NVIDIA_API_KEY not configured",
    });
    return { executed: 0, skipped: cfg.walletIds.length };
  }

  // Only fetch verified wallets for the sweep pipeline
  const allWallets = await db
    .select()
    .from(walletsTable)
    .where(sql`${walletsTable.id} = ANY(${cfg.walletIds})`);

  const verifiedWallets = allWallets.filter((w) => w.verified);
  const unverifiedWallets = allWallets.filter((w) => !w.verified);

  const rules = await db.select().from(rulesTable).where(eq(rulesTable.enabled, true));

  let executed = 0;

  // ── Phase 1: Deterministic sweep pipeline (runs before AI) ──────────────
  // This handles dividends + staking rewards without waiting for AI decisions.
  if (sweepCfg.enabled && !cfg.dryRun) {
    for (const wallet of verifiedWallets) {
      try {
        const secret = decryptMnemonic(wallet.encryptedMnemonic, cfg.masterPassword);
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);

        // ── Phase 1a: Staking rewards claim ────────────────────────────────
        if (sweepCfg.autoClaimStaking) {
          try {
            const stakingRewards = await queryStakingRewards(wallet.address, wallet.network);
            const totalRewardMEC = parseFloat(stakingRewards.totalMEC);

            if (totalRewardMEC >= minSweepMEC) {
              logger.info({ wallet: wallet.label, rewardMEC: stakingRewards.totalMEC }, "Claiming staking rewards");
              const claimResult = await claimAllStakingRewards({
                privkeyHex,
                delegatorAddress: wallet.address,
                network: wallet.network,
              });
              await db.insert(agentLogsTable).values({
                walletId: wallet.id,
                action: "claim_staking_rewards",
                status: "success",
                amount: stakingRewards.totalMEC,
                txHash: claimResult.txHash,
                message: `[AUTO] Claimed ${stakingRewards.totalMEC} MEC staking rewards | TX: ${claimResult.txHash}`,
              });
              executed++;
              // Allow chain state to settle before sweeping
              await new Promise((r) => setTimeout(r, 6000));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ wallet: wallet.label, err: msg }, "Staking reward claim skipped");
            await db.insert(agentLogsTable).values({
              walletId: wallet.id,
              action: "claim_staking_rewards",
              status: "error",
              message: `[AUTO] Staking claim skipped: ${msg}`,
            });
          }
        }

        // ── Phase 1b: Balance sweep (dividend or claimed rewards) ──────────
        // During dividend window OR whenever auto-sweep is on and balance > threshold
        const shouldSweepNow = inDividendWindow || sweepCfg.autoClaimStaking;
        if (shouldSweepNow) {
          try {
            const bal = await queryBalance(wallet.address, wallet.network);
            const balanceMEC = parseFloat(bal.balance);

            if (balanceMEC >= minSweepMEC) {
              const sweepResult = await sweepToMaster({
                privkeyHex,
                fromAddress: wallet.address,
                masterAddress: sweepCfg.masterAddress,
                network: wallet.network,
                memo: inDividendWindow ? `dividend-sweep day-${dayOfMonth}` : "auto-sweep",
              });
              await db.insert(agentLogsTable).values({
                walletId: wallet.id,
                action: inDividendWindow ? "sweep_dividend" : "sweep_balance",
                status: "success",
                amount: sweepResult.amountMEC.toFixed(8),
                txHash: sweepResult.txHash,
                message: `[AUTO] Swept ${sweepResult.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${sweepResult.txHash}`,
              });
              executed++;
            } else {
              logger.debug({ wallet: wallet.label, balance: bal.balance }, "Balance below sweep threshold, skipping");
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("Insufficient balance")) {
              await db.insert(agentLogsTable).values({
                walletId: wallet.id,
                action: "sweep_balance",
                status: "error",
                message: `[AUTO] Sweep failed: ${msg}`,
              });
            }
          }
        }
      } catch (outerErr) {
        const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        logger.error({ wallet: wallet.label, err: msg }, "Deterministic pipeline error");
      }
    }
  } else if (sweepCfg.enabled && cfg.dryRun) {
    // Dry-run: log what would happen without executing
    for (const wallet of verifiedWallets) {
      const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0", denom: "MEC" }));
      const balanceMEC = parseFloat(bal.balance);
      if (balanceMEC >= minSweepMEC) {
        await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: inDividendWindow ? "sweep_dividend" : "sweep_balance",
          status: "dry_run",
          amount: bal.balance,
          message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}${inDividendWindow ? ` (dividend window day ${dayOfMonth})` : ""}`,
        });
        executed++;
      }
    }
  }

  // ── Phase 2: AI agent evaluation ─────────────────────────────────────────
  const walletSummaries = await Promise.all(
    allWallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network).catch(() => ({ balance: "0", denom: "MEC" }));
      let stakingRewards = "0 MEC";
      try {
        const sr = await queryStakingRewards(w.address, w.network);
        stakingRewards = `${sr.totalMEC} MEC`;
      } catch { /* ignore */ }
      return {
        label: w.label,
        address: w.address,
        balance: `${bal.balance} ${bal.denom}`,
        stakingRewards,
        verified: w.verified,
      };
    })
  );

  let decisions: Awaited<ReturnType<typeof agentDecide>> = [];
  try {
    decisions = await agentDecide(
      walletSummaries,
      rules.map((r) => ({ name: r.name, ruleType: r.ruleType, conditionJson: r.conditionJson, actionJson: r.actionJson })),
      apiKey,
      {
        isDividendWindow: inDividendWindow,
        dayOfMonth,
        masterAddress: sweepCfg.masterAddress,
        autoSweepEnabled: sweepCfg.enabled,
        minSweepMEC,
      }
    );
  } catch (err) {
    await db.insert(agentLogsTable).values({
      action: "scheduled_run",
      status: "error",
      message: `Scheduler AI error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { executed, skipped: cfg.walletIds.length - executed };
  }

  // Load whitelist once — used to gate all AI-decided transfers
  const whitelistEntries = await db.select({ address: whitelistTable.address }).from(whitelistTable);
  const whitelist = new Set(whitelistEntries.map((e) => e.address.toLowerCase()));
  const whitelistActive = whitelist.size > 0;

  // Execute AI decisions (only for verified wallets, skip unverified)
  const unverifiedAddresses = new Set(unverifiedWallets.map((w) => w.address));

  for (const decision of decisions) {
    const wallet = allWallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;

    // Strict: never execute transfers on unverified wallets
    if (!wallet.verified) {
      await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: decision.action,
        status: "error",
        message: `[BLOCKED] Wallet is unverified — no transfers allowed. ${decision.reason}`,
      });
      continue;
    }

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
      const isTransfer = /sweep|withdraw|send|transfer|claim/i.test(decision.action);
      const toAddress: string | undefined = decision.toAddress;

      // ── Whitelist enforcement ─────────────────────────────────────────────
      // If the whitelist is active and the destination is not on it, block.
      if (isTransfer && toAddress && whitelistActive && !whitelist.has(toAddress.toLowerCase())) {
        await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: decision.action,
          status: "blocked",
          amount: decision.amount ?? null,
          message: `[WHITELIST BLOCKED] Destination ${toAddress} is not on the approved whitelist. ${decision.reason}`,
        });
        continue;
      }

      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const amountMEC = parseFloat(String(decision.amount));
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC, memo: `agent: ${decision.reason}` });
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

  const skipped = cfg.walletIds.length - executed;
  return { executed, skipped: Math.max(0, skipped) };
}
