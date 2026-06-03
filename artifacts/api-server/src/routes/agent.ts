import { Router } from "express";
import {
  getAllItems, pushItem, getItem, walletsRef, rulesRef, logsRef, whitelistRef,
  insertLog, getSweepConfig, setSweepConfig,
  type Wallet, type Rule, type AgentLog, type WhitelistEntry, type WithId, now,
} from "../lib/firebase-db";
import { AgentChatBody } from "@workspace/api-zod";
import { decryptMnemonic } from "../lib/crypto";
import { queryBalance, queryStakingRewards, sendMEC, getPrivateKeyHex, claimAllStakingRewards, sweepToMaster } from "../lib/blockchain";
import { agentDecide, chatWithNvidia } from "../lib/nvidia";
import { logger } from "../lib/logger";
import { getSchedulerStatus, startScheduler, stopScheduler } from "../lib/scheduler";

const router = Router();
const getNvidiaKey = () => process.env["NVIDIA_API_KEY"] ?? "";

// ── Sweep Config ──────────────────────────────────────────────────────────────

router.get("/agent/sweep-config", async (_req, res): Promise<void> => {
  const cfg = await getSweepConfig();
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
  const updated = await setSweepConfig({ masterAddress, enabled, autoClaimStaking, dividendWindowDays, minSweepAmountMec });
  res.json(updated);
});

// ── Agent Run ─────────────────────────────────────────────────────────────────

router.post("/agent/run", async (req, res): Promise<void> => {
  const { walletIds, masterPassword, dryRun } = req.body as {
    walletIds: string[];
    masterPassword: string;
    dryRun?: boolean;
  };

  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    res.status(400).json({ error: "walletIds must be a non-empty array" });
    return;
  }
  if (!masterPassword) {
    res.status(400).json({ error: "masterPassword is required" });
    return;
  }

  const allWallets = await getAllItems<Wallet>(walletsRef());
  const wallets = allWallets.filter((w) => walletIds.includes(w.id));
  const rules = await getAllItems<Rule>(rulesRef());
  const enabledRules = rules.filter((r) => r.enabled);
  const sweepCfg = await getSweepConfig();
  const dayOfMonth = new Date().getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;

  const walletSummaries = await Promise.all(
    wallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network).catch(() => ({ balance: "0", denom: "MEC" }));
      let stakingRewards = "0 MEC";
      try { const sr = await queryStakingRewards(w.address, w.network); stakingRewards = `${sr.totalMEC} MEC`; } catch { /* ignore */ }
      return { label: w.label, address: w.address, balance: `${bal.balance} ${bal.denom}`, stakingRewards, verified: w.verified };
    })
  );

  const createdLogs: WithId<AgentLog>[] = [];
  const whitelistEntries = await getAllItems<WhitelistEntry>(whitelistRef());
  const whitelistAddresses = new Set(whitelistEntries.map((e) => e.address));

  const apiKey = getNvidiaKey();
  if (!apiKey) {
    const log = await insertLog({ walletId: null, action: "agent_run", status: "error", txHash: null, amount: null, message: "NVIDIA_API_KEY is not configured. Please add it in environment secrets." });
    createdLogs.push(log);
    res.json({ executed: 0, skipped: walletIds.length, logs: createdLogs.map(mapLog) });
    return;
  }

  let decisions: Awaited<ReturnType<typeof agentDecide>> = [];
  try {
    decisions = await agentDecide(
      walletSummaries,
      enabledRules.map((r) => ({ name: r.name, ruleType: r.ruleType, conditionJson: r.conditionJson, actionJson: r.actionJson })),
      apiKey,
      { isDividendWindow: inDividendWindow, dayOfMonth, masterAddress: sweepCfg.masterAddress, autoSweepEnabled: sweepCfg.enabled, minSweepMEC: parseFloat(sweepCfg.minSweepAmountMec) }
    );
  } catch (err) {
    logger.error({ err }, "NVIDIA agent decision failed");
    const log = await insertLog({ walletId: null, action: "agent_run", status: "error", txHash: null, amount: null, message: `AI agent error: ${err instanceof Error ? err.message : String(err)}` });
    res.json({ executed: 0, skipped: walletIds.length, logs: [mapLog(log)] });
    return;
  }

  let executed = 0;
  const skipped = walletIds.length - decisions.length;

  for (const decision of decisions) {
    const wallet = wallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;

    if (!wallet.verified) {
      const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "blocked", txHash: null, amount: decision.amount ?? null, message: `[BLOCKED] Wallet "${wallet.label}" is UNVERIFIED — no transfers allowed. ${decision.reason}` });
      createdLogs.push(log);
      continue;
    }

    if (dryRun) {
      const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "dry_run", txHash: null, amount: decision.amount ?? null, message: `[DRY RUN] ${decision.reason}` });
      createdLogs.push(log);
      executed++;
      continue;
    }

    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword);
      const isTransfer = /sweep|withdraw|send|transfer|claim/i.test(decision.action);
      const toAddress: string | undefined = decision.toAddress ?? (decision as any).destination;

      if (isTransfer && toAddress && whitelistAddresses.size > 0 && !whitelistAddresses.has(toAddress)) {
        const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "blocked", txHash: null, amount: decision.amount ?? null, message: `Security policy: destination ${toAddress} is not on the whitelist.` });
        createdLogs.push(log);
        continue;
      }

      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC: parseFloat(String(decision.amount)), memo: `agent: ${decision.reason}` });
        const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "success", txHash: result.txHash, amount: decision.amount ?? null, message: `${decision.reason} | TX: ${result.txHash} (block ${result.height})` });
        createdLogs.push(log);
      } else {
        const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "success", txHash: null, amount: decision.amount ?? null, message: decision.reason });
        createdLogs.push(log);
      }
      executed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isWrongPwd = msg.includes("decrypt") || msg.includes("password") || msg.includes("decipher");
      const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "error", txHash: null, amount: null, message: isWrongPwd ? "Failed to decrypt wallet — incorrect password" : `Send failed: ${msg}` });
      createdLogs.push(log);
    }
  }

  res.json({ executed, skipped, logs: createdLogs.map(mapLog) });
});

// ── Scheduler ─────────────────────────────────────────────────────────────────

router.get("/agent/scheduler", (_req, res): void => {
  res.json(getSchedulerStatus());
});

router.post("/agent/scheduler", async (req, res): Promise<void> => {
  const { intervalMs, walletIds, useMonitoredWallets, masterPassword, dryRun } = req.body as {
    intervalMs: number;
    walletIds?: string[];
    useMonitoredWallets?: boolean;
    masterPassword: string;
    dryRun?: boolean;
  };

  if (!intervalMs || intervalMs < 60_000) { res.status(400).json({ error: "intervalMs must be at least 60000 (1 minute)" }); return; }
  if (!masterPassword) { res.status(400).json({ error: "masterPassword is required" }); return; }

  let resolvedWalletIds: string[] = walletIds ?? [];
  if (useMonitoredWallets) {
    const all = await getAllItems<Wallet>(walletsRef());
    resolvedWalletIds = all.filter((w) => w.monitored).map((w) => w.id);
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

// ── Agent Chat ────────────────────────────────────────────────────────────────

router.post("/agent/chat", async (req, res): Promise<void> => {
  const parsed = AgentChatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { message, walletContext } = parsed.data;
  const history: Array<{ role: "user" | "assistant"; content: string }> =
    Array.isArray((req.body as any).history) ? (req.body as any).history : [];

  const apiKey = getNvidiaKey();
  if (!apiKey) {
    res.json({ reply: "NVIDIA_API_KEY is not configured. Please add it as an environment secret to enable the AI agent chat.", suggestedActions: ["Add NVIDIA_API_KEY to environment secrets"] });
    return;
  }

  let context = "";
  if (walletContext) {
    const wallets = await getAllItems<Wallet>(walletsRef());
    const sweepCfg = await getSweepConfig();
    const verifiedCount = wallets.filter((w) => w.verified).length;
    context = `\n\nLive wallet context (${wallets.length} total, ${verifiedCount} verified):\n${JSON.stringify(wallets.map(({ encryptedMnemonic: _, ...w }) => w), null, 2)}\n\nSweep config: master=${sweepCfg.masterAddress}, autoSweep=${sweepCfg.enabled}, minMEC=${sweepCfg.minSweepAmountMec}`;
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

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20),
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

// ── Agent Logs ────────────────────────────────────────────────────────────────

router.get("/agent/logs", async (req, res): Promise<void> => {
  const walletId = req.query.walletId as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

  const allWallets = await getAllItems<Wallet>(walletsRef());
  const walletMap = new Map(allWallets.map((w) => [w.id, w.label]));

  let logs = await getAllItems<AgentLog>(logsRef());
  if (walletId) logs = logs.filter((l) => l.walletId === walletId);
  logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  logs = logs.slice(0, limit);

  res.json(logs.map((l) => ({ ...mapLog(l), walletLabel: l.walletId ? (walletMap.get(l.walletId) ?? null) : null })));
});

router.delete("/agent/logs", async (_req, res): Promise<void> => {
  await logsRef().remove();
  res.json({ cleared: true });
});

// ── Agent Stats ───────────────────────────────────────────────────────────────

router.get("/agent/stats", async (_req, res): Promise<void> => {
  const [wallets, rules, logs] = await Promise.all([
    getAllItems<Wallet>(walletsRef()),
    getAllItems<Rule>(rulesRef()),
    getAllItems<AgentLog>(logsRef()),
  ]);

  const nonRunLogs = logs.filter((l) => l.action !== "agent_run");
  const successLogs = nonRunLogs.filter((l) => l.status === "success");
  const lastLog = logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  res.json({
    totalWallets: wallets.length,
    verifiedWallets: wallets.filter((w) => w.verified).length,
    totalWithdrawals: nonRunLogs.length,
    successfulWithdrawals: successLogs.length,
    failedWithdrawals: nonRunLogs.length - successLogs.length,
    activeRules: rules.filter((r) => r.enabled).length,
    lastRunAt: lastLog?.createdAt ?? null,
  });
});

// ── Verify Password ───────────────────────────────────────────────────────────

router.post("/agent/verify-password", async (req, res): Promise<void> => {
  const { password } = req.body as { password: string };
  if (!password) { res.status(400).json({ error: "password is required" }); return; }

  const wallets = await getAllItems<Wallet>(walletsRef());
  const verified = wallets.filter((w) => w.verified);
  if (verified.length === 0) { res.status(400).json({ error: "No verified wallets found" }); return; }

  try {
    decryptMnemonic(verified[0].encryptedMnemonic, password);
  } catch {
    res.status(400).json({ valid: false, error: "Incorrect password — this is the Encryption Password you set when importing your wallets." });
    return;
  }

  res.json({ valid: true, walletCount: verified.length });
});

// ── Sweep Now ─────────────────────────────────────────────────────────────────

router.post("/agent/sweep-now", async (req, res): Promise<void> => {
  const { walletIds, masterPassword, dryRun = false } = req.body as { walletIds?: string[]; masterPassword: string; dryRun?: boolean };
  if (!masterPassword) { res.status(400).json({ error: "masterPassword is required" }); return; }

  const sweepCfg = await getSweepConfig();
  const minSweepMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");
  const dayOfMonth = new Date().getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;

  const allWallets = await getAllItems<Wallet>(walletsRef());
  const wallets = walletIds && walletIds.length > 0
    ? allWallets.filter((w) => walletIds.includes(w.id))
    : allWallets.filter((w) => w.verified);

  const verifiedWallets = wallets.filter((w) => w.verified);
  if (verifiedWallets.length === 0) { res.status(400).json({ error: "No verified wallets found to sweep." }); return; }

  const logs: ReturnType<typeof mapLog>[] = [];
  let swept = 0;
  let skipped = 0;

  for (const wallet of verifiedWallets) {
    if (dryRun) {
      const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0", denom: "MEC" }));
      if (parseFloat(bal.balance) >= minSweepMEC) {
        const log = await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "dry_run", txHash: null, amount: bal.balance, message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}${inDividendWindow ? ` (dividend window day ${dayOfMonth})` : ""}` });
        logs.push(mapLog(log));
        swept++;
      } else { skipped++; }
      continue;
    }

    let secret: string;
    try { secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword); }
    catch {
      const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: "Failed to decrypt wallet — incorrect password" });
      logs.push(mapLog(log)); skipped++; continue;
    }

    let privkeyHex: string;
    try { privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0); }
    catch (err) {
      const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `Key derivation failed: ${err instanceof Error ? err.message : String(err)}` });
      logs.push(mapLog(log)); skipped++; continue;
    }

    if (sweepCfg.autoClaimStaking) {
      try {
        const stakingRewards = await queryStakingRewards(wallet.address, wallet.network);
        if (parseFloat(stakingRewards.totalMEC) >= minSweepMEC) {
          const claimResult = await claimAllStakingRewards({ privkeyHex, delegatorAddress: wallet.address, network: wallet.network });
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "success", txHash: claimResult.txHash, amount: stakingRewards.totalMEC, message: `Claimed ${stakingRewards.totalMEC} MEC staking rewards | TX: ${claimResult.txHash}` });
          logs.push(mapLog(log));
          await new Promise((r) => setTimeout(r, 6000));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("No withdrawable")) {
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "error", txHash: null, amount: null, message: `Staking claim skipped: ${msg}` });
          logs.push(mapLog(log));
        }
      }
    }

    try {
      const bal = await queryBalance(wallet.address, wallet.network);
      if (parseFloat(bal.balance) < minSweepMEC) { skipped++; continue; }
      const sweepResult = await sweepToMaster({ privkeyHex, fromAddress: wallet.address, masterAddress: sweepCfg.masterAddress, network: wallet.network, memo: inDividendWindow ? `dividend-sweep day-${dayOfMonth}` : "manual-sweep" });
      const log = await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "success", txHash: sweepResult.txHash, amount: sweepResult.amountMEC.toFixed(8), message: `Swept ${sweepResult.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${sweepResult.txHash}` });
      logs.push(mapLog(log)); swept++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Insufficient balance")) {
        const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `Sweep failed: ${msg}` });
        logs.push(mapLog(log));
      }
      skipped++;
    }
  }

  res.json({ swept, skipped, dryRun, masterAddress: sweepCfg.masterAddress, logs });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapLog(log: WithId<AgentLog> & { walletLabel?: string | null }) {
  return {
    id: log.id,
    walletId: log.walletId,
    walletLabel: log.walletLabel ?? null,
    action: log.action,
    status: log.status,
    txHash: log.txHash,
    amount: log.amount,
    message: log.message,
    createdAt: log.createdAt,
  };
}

export default router;
