import { Router } from "express";
import { eq, desc, count, and, sql } from "drizzle-orm";
import { db, walletsTable, agentLogsTable, rulesTable, whitelistTable, sweepConfigTable } from "@workspace/db";
import { RunAgentBody, AgentChatBody, ListAgentLogsQueryParams } from "@workspace/api-zod";
import { decryptMnemonic } from "../lib/crypto";
import { queryBalance, queryStakingRewards, sendMEC, getPrivateKeyHex, claimAllStakingRewards, sweepToMaster } from "../lib/blockchain";
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

router.post("/agent/scheduler", async (req, res): Promise<void> => {
  const { intervalMs, walletIds, useMonitoredWallets, masterPassword, dryRun } = req.body as {
    intervalMs: number;
    walletIds?: number[];
    useMonitoredWallets?: boolean;
    masterPassword: string;
    dryRun?: boolean;
  };

  if (!intervalMs || intervalMs < 60_000) {
    res.status(400).json({ error: "intervalMs must be at least 60000 (1 minute)" });
    return;
  }
  if (!masterPassword) {
    res.status(400).json({ error: "masterPassword is required" });
    return;
  }

  let resolvedWalletIds: number[] = walletIds ?? [];
  if (useMonitoredWallets) {
    const monitored = await db
      .select({ id: walletsTable.id })
      .from(walletsTable)
      .where(eq(walletsTable.monitored, true));
    resolvedWalletIds = monitored.map((w) => w.id);
  }

  if (resolvedWalletIds.length === 0) {
    res.status(400).json({ error: "No wallets selected. Either specify walletIds or mark wallets as monitored." });
    return;
  }

  startScheduler({ intervalMs, walletIds: resolvedWalletIds, masterPassword, dryRun: dryRun ?? true });
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
  // Accept optional conversation history for multi-turn context
  const history: Array<{ role: "user" | "assistant"; content: string }> =
    Array.isArray((req.body as { history?: unknown }).history) ? (req.body as { history: Array<{ role: "user" | "assistant"; content: string }> }).history : [];

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
    // Also pull recent agent stats for richer context
    const [stats] = await db.select({ count: sql<number>`count(*)::int` }).from(walletsTable).where(eq(walletsTable.verified, true));
    const sweepCfg = await getOrCreateSweepConfig();
    context = `\n\nLive wallet context (${wallets.length} total, ${stats.count} verified):\n${JSON.stringify(wallets, null, 2)}\n\nSweep config: master=${sweepCfg.masterAddress}, autoSweep=${sweepCfg.enabled}, minMEC=${sweepCfg.minSweepAmountMec}`;
  }

  const systemPrompt = `You are an AI assistant for the Meta Earth Wallet Agent — an autonomous system that manages multiple MEC (Meta Earth Coin) cryptocurrency wallets on the me-chain blockchain.

Chain facts: 1 MEC = 100,000,000 umec, addresses use "me1..." prefix, coin type 118 (Cosmos standard), mainnet REST at port 11317.

You help the user understand their wallets, plan withdrawals (including monthly dividend sweeps to the master address), configure automation rules, manage staking rewards, and monitor activity.

Key features of this system:
- Monthly dividends arrive randomly in days 1-7 of each month — the agent monitors and sweeps automatically
- Staking/block rewards can be claimed and swept to the master address
- Verified wallets are on-chain active accounts; unverified wallets are monitored only
- The whitelist restricts where funds can be sent — the AI agent respects this at all times
- Automation rules (JSON conditions/actions) guide the AI's decisions each scheduled run

Be concise, professional, and helpful. When suggesting actions, be specific.${context}`;

  // Build the full message thread including prior conversation turns
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20), // keep last 20 turns to stay within context limits
    { role: "user", content: message },
  ];

  try {
    const reply = await chatWithNvidia(messages, apiKey);

    const suggestedActions: string[] = [];
    const low = reply.toLowerCase();
    if (low.includes("sweep") || low.includes("dividend")) suggestedActions.push("Configure sweep settings");
    if (low.includes("withdraw")) suggestedActions.push("Run agent with withdrawal rule");
    if (low.includes("rule")) suggestedActions.push("Create automation rule");
    if (low.includes("balance")) suggestedActions.push("Check wallet balances");
    if (low.includes("staking") || low.includes("reward")) suggestedActions.push("Check staking rewards");
    if (low.includes("whitelist")) suggestedActions.push("Manage whitelist addresses");

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

router.delete("/agent/logs", async (_req, res): Promise<void> => {
  await db.delete(agentLogsTable);
  res.json({ cleared: true });
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

// ─── Verify Encryption Password ───────────────────────────────────────────────
// Pre-flight check: tries to decrypt one verified wallet with the given password.
// Returns { valid: true, walletCount } on success so the UI can gate the sweep button.
router.post("/agent/verify-password", async (req, res): Promise<void> => {
  const { password } = req.body as { password: string };
  if (!password) {
    res.status(400).json({ error: "password is required" });
    return;
  }
  const wallets = await db.select().from(walletsTable).where(eq(walletsTable.verified, true)).limit(1);
  if (wallets.length === 0) {
    res.status(400).json({ error: "No verified wallets found" });
    return;
  }
  try {
    decryptMnemonic(wallets[0].encryptedMnemonic, password);
  } catch {
    res.status(400).json({ valid: false, error: "Incorrect password — this is the Encryption Password you set when importing your wallets." });
    return;
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(walletsTable).where(eq(walletsTable.verified, true));
  res.json({ valid: true, walletCount: count });
});

// ─── Sweep Now ────────────────────────────────────────────────────────────────
// Deterministic sweep pipeline: no AI required. Checks balances, claims staking
// rewards (if enabled), and sweeps to master address for all selected wallets.
router.post("/agent/sweep-now", async (req, res): Promise<void> => {
  const { walletIds, masterPassword, dryRun = false } = req.body as {
    walletIds?: number[];
    masterPassword: string;
    dryRun?: boolean;
  };

  if (!masterPassword) {
    res.status(400).json({ error: "masterPassword is required" });
    return;
  }

  const sweepCfg = await getOrCreateSweepConfig();
  const minSweepMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;

  // Resolve wallets: use provided IDs, or fall back to all verified wallets
  let wallets;
  if (walletIds && walletIds.length > 0) {
    wallets = await db
      .select()
      .from(walletsTable)
      .where(sql`${walletsTable.id} = ANY(${walletIds})`);
  } else {
    wallets = await db.select().from(walletsTable).where(eq(walletsTable.verified, true));
  }

  const verifiedWallets = wallets.filter((w) => w.verified);

  if (verifiedWallets.length === 0) {
    res.status(400).json({ error: "No verified wallets found to sweep." });
    return;
  }

  const logs: ReturnType<typeof mapLog>[] = [];
  let swept = 0;
  let skipped = 0;

  for (const wallet of verifiedWallets) {
    // ── Dry Run ──────────────────────────────────────────────────────────────
    if (dryRun) {
      const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0", denom: "MEC" }));
      const balanceMEC = parseFloat(bal.balance);
      if (balanceMEC >= minSweepMEC) {
        const [log] = await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: inDividendWindow ? "sweep_dividend" : "sweep_balance",
          status: "dry_run",
          amount: bal.balance,
          message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}${inDividendWindow ? ` (dividend window day ${dayOfMonth})` : ""}`,
        }).returning();
        logs.push(mapLog(log));
        swept++;
      } else {
        skipped++;
      }
      continue;
    }

    // ── Live Sweep ────────────────────────────────────────────────────────────
    let secret: string;
    try {
      secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword);
    } catch {
      const [log] = await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: "sweep_balance",
        status: "error",
        message: `Failed to decrypt wallet — incorrect password`,
      }).returning();
      logs.push(mapLog(log));
      skipped++;
      continue;
    }

    let privkeyHex: string;
    try {
      privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
    } catch (err) {
      const [log] = await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: "sweep_balance",
        status: "error",
        message: `Key derivation failed: ${err instanceof Error ? err.message : String(err)}`,
      }).returning();
      logs.push(mapLog(log));
      skipped++;
      continue;
    }

    // Phase 1a: Claim staking rewards if enabled
    if (sweepCfg.autoClaimStaking) {
      try {
        const stakingRewards = await queryStakingRewards(wallet.address, wallet.network);
        const totalRewardMEC = parseFloat(stakingRewards.totalMEC);
        if (totalRewardMEC >= minSweepMEC) {
          const claimResult = await claimAllStakingRewards({ privkeyHex, delegatorAddress: wallet.address, network: wallet.network });
          const [log] = await db.insert(agentLogsTable).values({
            walletId: wallet.id,
            action: "claim_staking_rewards",
            status: "success",
            amount: stakingRewards.totalMEC,
            txHash: claimResult.txHash,
            message: `Claimed ${stakingRewards.totalMEC} MEC staking rewards | TX: ${claimResult.txHash}`,
          }).returning();
          logs.push(mapLog(log));
          // Wait for chain state to settle
          await new Promise((r) => setTimeout(r, 6000));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("No withdrawable")) {
          const [log] = await db.insert(agentLogsTable).values({
            walletId: wallet.id,
            action: "claim_staking_rewards",
            status: "error",
            message: `Staking claim skipped: ${msg}`,
          }).returning();
          logs.push(mapLog(log));
        }
      }
    }

    // Phase 1b: Sweep balance to master
    try {
      const bal = await queryBalance(wallet.address, wallet.network);
      const balanceMEC = parseFloat(bal.balance);
      if (balanceMEC < minSweepMEC) {
        skipped++;
        continue;
      }
      const sweepResult = await sweepToMaster({
        privkeyHex,
        fromAddress: wallet.address,
        masterAddress: sweepCfg.masterAddress,
        network: wallet.network,
        memo: inDividendWindow ? `dividend-sweep day-${dayOfMonth}` : "manual-sweep",
      });
      const [log] = await db.insert(agentLogsTable).values({
        walletId: wallet.id,
        action: inDividendWindow ? "sweep_dividend" : "sweep_balance",
        status: "success",
        amount: sweepResult.amountMEC.toFixed(8),
        txHash: sweepResult.txHash,
        message: `Swept ${sweepResult.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${sweepResult.txHash}`,
      }).returning();
      logs.push(mapLog(log));
      swept++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Insufficient balance")) {
        const [log] = await db.insert(agentLogsTable).values({
          walletId: wallet.id,
          action: "sweep_balance",
          status: "error",
          message: `Sweep failed: ${msg}`,
        }).returning();
        logs.push(mapLog(log));
      }
      skipped++;
    }
  }

  req.log.info({ swept, skipped, dryRun }, "Sweep-now complete");
  res.json({ swept, skipped, dryRun, masterAddress: sweepCfg.masterAddress, logs });
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
