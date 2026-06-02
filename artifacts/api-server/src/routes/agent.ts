import { Router } from "express";
import { eq, desc, count, and, sql } from "drizzle-orm";
import { db, walletsTable, agentLogsTable, rulesTable, whitelistTable, sweepConfigTable } from "@workspace/db";
import { RunAgentBody, AgentChatBody, ListAgentLogsQueryParams } from "@workspace/api-zod";
import { decryptMnemonic } from "../lib/crypto";
import { queryBalance, queryStakingRewards, sendMEC, getPrivateKeyHex } from "../lib/blockchain";
import { agentDecide, chatWithNvidia } from "../lib/nvidia";
import { logger } from "../lib/logger";
import { getSchedulerStatus, startScheduler, stopScheduler } from "../lib/scheduler";

const router = Router();

const getNvidiaKey = () => process.env["NVIDIA_API_KEY"] ?? "";

// ─── Sweep Config ─────────────────────────────────────────────────────────────

async function getOrCreateSweepConfig() {
  const rows = await db.select().from(sweepConfigTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(sweepConfigTable).values({}).returning();
  return created;
}

router.get("/agent/sweep-config", async (_req, res): Promise<void> => {
  const cfg = await getOrCreateSweepConfig();
  res.json(cfg);
});

router.post("/agent/sweep-config", async (req, res): Promise<void> => {
  const { masterAddress, enabled, autoClaimStaking, dividendWindowDays, minSweepAmountMec } = req.body as {
    masterAddress?: string;
    enabled?: boolean;
    autoClaimStaking?: boolean;
    dividendWindowDays?: number;
    minSweepAmountMec?: string;
  };

  const existing = await getOrCreateSweepConfig();

  const [updated] = await db
    .update(sweepConfigTable)
    .set({
      masterAddress: masterAddress ?? existing.masterAddress,
      enabled: enabled ?? existing.enabled,
      autoClaimStaking: autoClaimStaking ?? existing.autoClaimStaking,
      dividendWindowDays: dividendWindowDays ?? existing.dividendWindowDays,
      minSweepAmountMec: minSweepAmountMec ?? existing.minSweepAmountMec,
    })
    .where(eq(sweepConfigTable.id, existing.id))
    .returning();

  res.json(updated);
});

// ─── Agent Run ────────────────────────────────────────────────────────────────

router.post("/agent/run", async (req, res): Promise<void> => {
  const parsed = RunAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { walletIds, masterPassword, dryRun } = parsed.data;

  const wallets = await db
    .select()
    .from(walletsTable)
    .where(sql`${walletsTable.id} = ANY(${walletIds})`);

  const rules = await db
    .select()
    .from(rulesTable)
    .where(eq(rulesTable.enabled, true));

  const sweepCfg = await getOrCreateSweepConfig();
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;

  const walletSummaries = await Promise.all(
    wallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network);
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

  const createdLogs: typeof agentLogsTable.$inferSelect[] = [];

  // Load whitelist once — used to validate all transfer destinations
  const whitelistEntries = await db.select().from(whitelistTable);
  const whitelistAddresses = new Set(whitelistEntries.map((e) => e.address));

  const apiKey = getNvidiaKey();
  if (!apiKey) {
    const log = await db
      .insert(agentLogsTable)
      .values({
        action: "agent_run",
        status: "error",
        message: "NVIDIA_API_KEY is not configured. Please add it in environment secrets.",
      })
      .returning();
    createdLogs.push(...log);
    res.json({ executed: 0, skipped: walletIds.length, logs: createdLogs.map(mapLog) });
    return;
  }

  let decisions: Awaited<ReturnType<typeof agentDecide>> = [];
  try {
    decisions = await agentDecide(
      walletSummaries,
      rules.map((r) => ({
        name: r.name,
        ruleType: r.ruleType,
        conditionJson: r.conditionJson,
        actionJson: r.actionJson,
      })),
      apiKey,
      {
        isDividendWindow: inDividendWindow,
        dayOfMonth,
        masterAddress: sweepCfg.masterAddress,
        autoSweepEnabled: sweepCfg.enabled,
        minSweepMEC: parseFloat(sweepCfg.minSweepAmountMec),
      }
    );
  } catch (err) {
    logger.error({ err }, "NVIDIA agent decision failed");
    const log = await db
      .insert(agentLogsTable)
      .values({
        action: "agent_run",
        status: "error",
        message: `AI agent error: ${err instanceof Error ? err.message : String(err)}`,
      })
      .returning();
    res.json({ executed: 0, skipped: walletIds.length, logs: log.map(mapLog) });
    return;
  }

  let executed = 0;
  const skipped = walletIds.length - decisions.length;

  for (const decision of decisions) {
    const wallet = wallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;

    // Hard guard: never execute transfers on unverified wallets
    if (!wallet.verified) {
      const log = await db
        .insert(agentLogsTable)
        .values({
          walletId: wallet.id,
          action: decision.action,
          status: "blocked",
          message: `[BLOCKED] Wallet "${wallet.label}" is UNVERIFIED — no transfers allowed. ${decision.reason}`,
        })
        .returning();
      createdLogs.push(...log);
      continue;
    }

    if (dryRun) {
      const log = await db
        .insert(agentLogsTable)
        .values({
          walletId: wallet.id,
          action: decision.action,
          status: "dry_run",
          amount: decision.amount ?? null,
          message: `[DRY RUN] ${decision.reason}`,
        })
        .returning();
      createdLogs.push(...log);
      executed++;
      continue;
    }

    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword);

      const isTransfer = /sweep|withdraw|send|transfer|claim/i.test(decision.action);
      const toAddress: string | undefined =
        decision.toAddress ?? (decision as any).destination;

      // Security guardrail: destination must be on whitelist (if whitelist is non-empty)
      if (isTransfer && toAddress && whitelistAddresses.size > 0 && !whitelistAddresses.has(toAddress)) {
        const log = await db
          .insert(agentLogsTable)
          .values({
            walletId: wallet.id,
            action: decision.action,
            status: "blocked",
            amount: decision.amount ?? null,
            message: `Security policy: destination ${toAddress} is not on the whitelist. Add it in the Whitelist page before the agent can send funds there.`,
          })
          .returning();
        createdLogs.push(...log);
        continue;
      }

      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const amountMEC = parseFloat(String(decision.amount));
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC, memo: `agent: ${decision.reason}` });
        const log = await db
          .insert(agentLogsTable)
          .values({
            walletId: wallet.id,
            action: decision.action,
            status: "success",
            amount: decision.amount ?? null,
            txHash: result.txHash,
            message: `${decision.reason} | TX: ${result.txHash} (block ${result.height})`,
          })
          .returning();
        createdLogs.push(...log);
      } else {
        const log = await db
          .insert(agentLogsTable)
          .values({
            walletId: wallet.id,
            action: decision.action,
            status: "success",
            amount: decision.amount ?? null,
            message: decision.reason,
          })
          .returning();
        createdLogs.push(...log);
      }
      executed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isWrongPwd = msg.includes("decrypt") || msg.includes("password") || msg.includes("decipher");
      const log = await db
        .insert(agentLogsTable)
        .values({
          walletId: wallet.id,
          action: decision.action,
          status: "error",
          message: isWrongPwd ? "Failed to decrypt wallet — incorrect password" : `Send failed: ${msg}`,
        })
        .returning();
      createdLogs.push(...log);
    }
  }

  res.json({ executed, skipped, logs: createdLogs.map(mapLog) });
});

router.get("/agent/scheduler", (_req, res): void => {
  res.json(getSchedulerStatus());
});

router.post("/agent/scheduler", (req, res): void => {
  const { intervalMs, walletIds, masterPassword, dryRun } = req.body as {
    intervalMs: number;
    walletIds: number[];
    masterPassword: string;
    dryRun?: boolean;
  };

  if (!intervalMs || intervalMs < 60_000) {
    res.status(400).json({ error: "intervalMs must be at least 60000 (1 minute)" });
    return;
  }
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    res.status(400).json({ error: "walletIds must be a non-empty array" });
    return;
  }
  if (!masterPassword) {
    res.status(400).json({ error: "masterPassword is required" });
    return;
  }

  startScheduler({ intervalMs, walletIds, masterPassword, dryRun: dryRun ?? true });
  res.json(getSchedulerStatus());
});

router.delete("/agent/scheduler", (_req, res): void => {
  stopScheduler();
  res.json(getSchedulerStatus());
});

router.post("/agent/chat", async (req, res): Promise<void> => {
  const parsed = AgentChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { message, walletContext } = parsed.data;
  const apiKey = getNvidiaKey();

  if (!apiKey) {
    res.json({
      reply: "NVIDIA_API_KEY is not configured. Please add it as an environment secret to enable the AI agent chat.",
      suggestedActions: ["Add NVIDIA_API_KEY to environment secrets"],
    });
    return;
  }

  let context = "";
  if (walletContext) {
    const wallets = await db.select({
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      verified: walletsTable.verified,
    }).from(walletsTable);
    context = `\n\nWallet context:\n${JSON.stringify(wallets, null, 2)}`;
  }

  const systemPrompt = `You are an AI assistant for the Meta Earth Wallet Agent — an autonomous system that manages multiple MEC (Meta Earth Coin) cryptocurrency wallets on the me-chain blockchain.

Chain facts: 1 MEC = 100,000,000 umec, addresses use "me1..." prefix, coin type 118 (Cosmos standard), mainnet REST at port 11317.

You help the user understand their wallets, plan withdrawals (including monthly dividend sweeps to the master address), configure automation rules, manage staking rewards, and monitor activity.

Key features of this system:
- Monthly dividends arrive randomly in days 1-7 of each month — the agent monitors and sweeps automatically
- Staking/block rewards can be claimed and swept to the master address
- Verified wallets are on-chain active accounts; unverified wallets are monitored only
- Sweep destination: me1h4fc80gz38ms8tejlj37rxmf7uh6xe25fk0tfx (master address)

Be concise, professional, and helpful. When suggesting actions, be specific.${context}`;

  try {
    const reply = await chatWithNvidia(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      apiKey
    );

    const suggestedActions: string[] = [];
    if (reply.toLowerCase().includes("sweep") || reply.toLowerCase().includes("dividend")) suggestedActions.push("Configure sweep settings");
    if (reply.toLowerCase().includes("withdraw")) suggestedActions.push("Run agent with withdrawal rule");
    if (reply.toLowerCase().includes("rule")) suggestedActions.push("Create automation rule");
    if (reply.toLowerCase().includes("balance")) suggestedActions.push("Check wallet balances");
    if (reply.toLowerCase().includes("staking") || reply.toLowerCase().includes("reward")) suggestedActions.push("Check staking rewards");

    res.json({ reply, suggestedActions });
  } catch (err) {
    res.status(500).json({ error: `AI error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.get("/agent/logs", async (req, res): Promise<void> => {
  const query = ListAgentLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { walletId, limit } = query.data;
  const take = limit ?? 50;

  const logs = await db
    .select({
      id: agentLogsTable.id,
      walletId: agentLogsTable.walletId,
      walletLabel: walletsTable.label,
      action: agentLogsTable.action,
      status: agentLogsTable.status,
      txHash: agentLogsTable.txHash,
      amount: agentLogsTable.amount,
      message: agentLogsTable.message,
      createdAt: agentLogsTable.createdAt,
    })
    .from(agentLogsTable)
    .leftJoin(walletsTable, eq(agentLogsTable.walletId, walletsTable.id))
    .where(walletId ? eq(agentLogsTable.walletId, walletId) : undefined)
    .orderBy(desc(agentLogsTable.createdAt))
    .limit(take);

  res.json(logs);
});

router.get("/agent/stats", async (_req, res): Promise<void> => {
  const [walletCount] = await db.select({ count: count() }).from(walletsTable);
  const [verifiedCount] = await db
    .select({ count: count() })
    .from(walletsTable)
    .where(eq(walletsTable.verified, true));
  const [ruleCount] = await db
    .select({ count: count() })
    .from(rulesTable)
    .where(eq(rulesTable.enabled, true));

  const [totalLogs] = await db
    .select({ count: count() })
    .from(agentLogsTable)
    .where(sql`${agentLogsTable.action} != 'agent_run'`);

  const [successLogs] = await db
    .select({ count: count() })
    .from(agentLogsTable)
    .where(and(
      sql`${agentLogsTable.action} != 'agent_run'`,
      eq(agentLogsTable.status, "success")
    ));

  const [lastLog] = await db
    .select({ createdAt: agentLogsTable.createdAt })
    .from(agentLogsTable)
    .orderBy(desc(agentLogsTable.createdAt))
    .limit(1);

  const total = Number(totalLogs?.count ?? 0);
  const successful = Number(successLogs?.count ?? 0);

  res.json({
    totalWallets: Number(walletCount?.count ?? 0),
    verifiedWallets: Number(verifiedCount?.count ?? 0),
    totalWithdrawals: total,
    successfulWithdrawals: successful,
    failedWithdrawals: total - successful,
    activeRules: Number(ruleCount?.count ?? 0),
    lastRunAt: lastLog?.createdAt?.toISOString() ?? null,
  });
});

function mapLog(log: typeof agentLogsTable.$inferSelect & { walletLabel?: string | null }) {
  return {
    id: log.id,
    walletId: log.walletId,
    walletLabel: (log as { walletLabel?: string | null }).walletLabel ?? null,
    action: log.action,
    status: log.status,
    txHash: log.txHash,
    amount: log.amount,
    message: log.message,
    createdAt: log.createdAt,
  };
}

export default router;
