import { Router } from "express";
import {
  getAllItems, walletsRef, rulesRef, logsRef, whitelistRef,
  insertLog, getSweepConfig, setSweepConfig,
  getNvidiaKeyFromDB, setNvidiaKeyInDB, clearPath,
  type Wallet, type Rule, type AgentLog, type WhitelistEntry, type WithId,
} from "../lib/firebase-db";
import { AgentChatBody } from "@workspace/api-zod";
import { decryptMnemonic } from "../lib/crypto";
import {
  queryBalance, queryStakingRewards, sendMEC, getPrivateKeyHex,
  claimAllStakingRewards, sweepToMaster,
} from "../lib/blockchain";
import { agentDecide, chatWithNvidia } from "../lib/nvidia";
import { logger } from "../lib/logger";
import { getSchedulerStatus, startScheduler, stopScheduler } from "../lib/scheduler";

const router = Router();

async function getEffectiveNvidiaKey(): Promise<string> {
  const envKey = process.env["NVIDIA_API_KEY"] ?? "";
  if (envKey) return envKey;
  const dbKey = await getNvidiaKeyFromDB();
  return dbKey ?? "";
}

// ── Sweep Config ──────────────────────────────────────────────────────────────

router.get("/agent/sweep-config", async (_req, res): Promise<void> => {
  const cfg = await getSweepConfig();
  res.json(cfg);
});

router.post("/agent/sweep-config", async (req, res): Promise<void> => {
  const { masterAddress, enabled, autoClaimStaking, dividendWindowDays, minSweepAmountMec } = req.body as {
    masterAddress?: string; enabled?: boolean; autoClaimStaking?: boolean;
    dividendWindowDays?: number; minSweepAmountMec?: string;
  };
  const updated = await setSweepConfig({ masterAddress, enabled, autoClaimStaking, dividendWindowDays, minSweepAmountMec });
  res.json(updated);
});

// ── NVIDIA API Key ────────────────────────────────────────────────────────────

router.get("/agent/nvidia-key", async (_req, res): Promise<void> => {
  const envKey = process.env["NVIDIA_API_KEY"] ?? "";
  if (envKey) {
    res.json({ configured: true, source: "env", masked: `${envKey.slice(0, 8)}${"•".repeat(Math.max(0, envKey.length - 12))}${envKey.slice(-4)}` });
    return;
  }
  const dbKey = await getNvidiaKeyFromDB();
  if (dbKey) {
    res.json({ configured: true, source: "db", masked: `${dbKey.slice(0, 8)}${"•".repeat(Math.max(0, dbKey.length - 12))}${dbKey.slice(-4)}` });
  } else {
    res.json({ configured: false, source: "none", masked: "" });
  }
});

router.post("/agent/nvidia-key", async (req, res): Promise<void> => {
  const { apiKey } = req.body as { apiKey?: string };
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
    res.status(400).json({ error: "apiKey must be at least 10 characters" }); return;
  }
  await setNvidiaKeyInDB(apiKey.trim());
  res.json({ ok: true });
});

// ── Agent Run ─────────────────────────────────────────────────────────────────

router.post("/agent/run", async (req, res): Promise<void> => {
  const { walletIds, masterPassword, dryRun } = req.body as {
    walletIds: string[]; masterPassword: string; dryRun?: boolean;
  };
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    res.status(400).json({ error: "walletIds must be a non-empty array" }); return;
  }
  if (!masterPassword) { res.status(400).json({ error: "masterPassword is required" }); return; }

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

  const apiKey = await getEffectiveNvidiaKey();
  if (!apiKey) {
    const log = await insertLog({ walletId: null, action: "agent_run", status: "error", txHash: null, amount: null, message: "NVIDIA_API_KEY is not configured." });
    createdLogs.push(log);
    res.json({ executed: 0, skipped: walletIds.length, logs: createdLogs.map(mapLog) }); return;
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
    res.json({ executed: 0, skipped: walletIds.length, logs: [mapLog(log)] }); return;
  }

  let executed = 0;
  const skipped = walletIds.length - decisions.length;

  for (const decision of decisions) {
    const wallet = wallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;
    if (!wallet.verified) {
      const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "blocked", txHash: null, amount: decision.amount ?? null, message: `[BLOCKED] Wallet "${wallet.label}" is UNVERIFIED` });
      createdLogs.push(log); continue;
    }
    if (dryRun) {
      const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "dry_run", txHash: null, amount: decision.amount ?? null, message: `[DRY RUN] ${decision.reason}` });
      createdLogs.push(log); executed++; continue;
    }
    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword);
      const isTransfer = /sweep|withdraw|send|transfer|claim/i.test(decision.action);
      const toAddress: string | undefined = decision.toAddress ?? (decision as any).destination;
      if (isTransfer && toAddress && whitelistAddresses.size > 0 && !whitelistAddresses.has(toAddress)) {
        const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "blocked", txHash: null, amount: decision.amount ?? null, message: `Security policy: destination ${toAddress} is not on the whitelist.` });
        createdLogs.push(log); continue;
      }
      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC: parseFloat(String(decision.amount)), memo: `agent: ${decision.reason}` });
        const log = await insertLog({ walletId: wallet.id, action: decision.action, status: "success", txHash: result.txHash, amount: decision.amount ?? null, message: `${decision.reason} | TX: ${result.txHash}` });
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

router.get("/agent/scheduler", (_req, res): void => { res.json(getSchedulerStatus()); });

router.post("/agent/scheduler", async (req, res): Promise<void> => {
  const { intervalMs, walletIds, useMonitoredWallets, masterPassword, dryRun } = req.body as {
    intervalMs: number; walletIds?: string[]; useMonitoredWallets?: boolean;
    masterPassword: string; dryRun?: boolean;
  };
  if (!intervalMs || intervalMs < 60_000) { res.status(400).json({ error: "intervalMs must be at least 60000" }); return; }
  if (!masterPassword) { res.status(400).json({ error: "masterPassword is required" }); return; }
  let resolvedWalletIds: string[] = walletIds ?? [];
  if (useMonitoredWallets) {
    const all = await getAllItems<Wallet>(walletsRef());
    resolvedWalletIds = all.filter((w) => w.monitored).map((w) => w.id);
  }
  if (resolvedWalletIds.length === 0) {
    res.status(400).json({ error: "No wallets selected." }); return;
  }
  startScheduler({ intervalMs, walletIds: resolvedWalletIds, masterPassword, dryRun: dryRun ?? true });
  res.json(getSchedulerStatus());
});

router.delete("/agent/scheduler", (_req, res): void => { stopScheduler(); res.json(getSchedulerStatus()); });

// ── Agent Chat ────────────────────────────────────────────────────────────────

export interface ActionProposalWallet {
  id: string;
  label: string;
  address: string;
  balance: string;
  stakingRewards: string;
}

export interface ActionProposal {
  type: "sweep_all" | "claim_staking" | "claim_then_sweep";
  description: string;
  wallets: ActionProposalWallet[];
  masterAddress: string;
  totalEstimatedMEC: string;
  requiresPassword: true;
}

function extractProposal(text: string): { reply: string; raw: string | null } {
  const start = text.indexOf("<PROPOSAL>");
  const end = text.indexOf("</PROPOSAL>");
  if (start === -1 || end === -1) return { reply: text.trim(), raw: null };
  const raw = text.slice(start + 10, end).trim();
  const reply = (text.slice(0, start) + text.slice(end + 11)).replace(/\n{3,}/g, "\n\n").trim();
  return { reply, raw };
}

function detectActionIntent(message: string): ActionProposal["type"] | null {
  const m = message.toLowerCase();
  const hasClaim = /\bclaim\b|\bharvest\b|\bcollect\b/.test(m);
  const hasSweep = /\bsweep\b|\bwithdraw\b|\bmove\b|\btransfer\b|\bempty\b|\bsend all\b/.test(m);
  const hasStaking = /\bstaking\b|\breward\b|\bblock reward\b/.test(m);
  if (hasClaim && hasSweep) return "claim_then_sweep";
  if (hasClaim && hasStaking) return "claim_staking";
  if (hasSweep) return "sweep_all";
  return null;
}

async function buildProposal(
  type: ActionProposal["type"],
  description: string,
  allWallets: WithId<Wallet>[],
  sweepCfg: Awaited<ReturnType<typeof getSweepConfig>>
): Promise<ActionProposal> {
  const verified = allWallets.filter((w) => w.verified);
  const minMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");

  const walletData = await Promise.all(
    verified.map(async (w) => {
      const bal = await queryBalance(w.address, w.network).catch(() => ({ balance: "0" }));
      let stakingRewards = "0";
      if (type === "claim_staking" || type === "claim_then_sweep") {
        try { const sr = await queryStakingRewards(w.address, w.network); stakingRewards = sr.totalMEC; } catch { /* ignore */ }
      }
      return { id: w.id, label: w.label, address: w.address, balance: bal.balance, stakingRewards };
    })
  );

  const relevant = walletData.filter((w) => {
    if (type === "claim_staking") return parseFloat(w.stakingRewards) >= minMEC;
    return parseFloat(w.balance) >= minMEC || (type === "claim_then_sweep" && parseFloat(w.stakingRewards) >= minMEC);
  });

  const totalMEC = relevant.reduce((sum, w) => {
    if (type === "claim_staking") return sum + (parseFloat(w.stakingRewards) || 0);
    if (type === "claim_then_sweep") return sum + (parseFloat(w.balance) || 0) + (parseFloat(w.stakingRewards) || 0);
    return sum + (parseFloat(w.balance) || 0);
  }, 0);

  return { type, description, wallets: relevant, masterAddress: sweepCfg.masterAddress, totalEstimatedMEC: totalMEC.toFixed(8), requiresPassword: true };
}

router.post("/agent/chat", async (req, res): Promise<void> => {
  const parsed = AgentChatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { message, walletContext } = parsed.data;
  const history: Array<{ role: "user" | "assistant"; content: string }> =
    Array.isArray((req.body as any).history) ? (req.body as any).history : [];

  const apiKey = await getEffectiveNvidiaKey();
  if (!apiKey) {
    res.json({ reply: "NVIDIA_API_KEY is not configured. Please add it in Agent Settings.", suggestedActions: [], actionProposal: null });
    return;
  }

  const allWallets = await getAllItems<Wallet>(walletsRef());
  const sweepCfg = await getSweepConfig();
  const verifiedCount = allWallets.filter((w) => w.verified).length;

  let context = "";
  if (walletContext) {
    const balances = await Promise.all(
      allWallets.filter((w) => w.verified).map(async (w) => {
        const bal = await queryBalance(w.address, w.network).catch(() => ({ balance: "0" }));
        return { label: w.label, address: w.address, balance: bal.balance, verified: w.verified, network: w.network };
      })
    );
    context = `\n\nLive wallet data (${allWallets.length} total, ${verifiedCount} verified):\n${JSON.stringify(balances, null, 2)}\n\nSweep config: masterAddress=${sweepCfg.masterAddress}, minSweepMEC=${sweepCfg.minSweepAmountMec}, autoSweepEnabled=${sweepCfg.enabled}`;
  }

  const systemPrompt = `You are the execution-capable AI brain of the Meta Earth Wallet Agent — an autonomous system managing MEC cryptocurrency wallets on the me-chain blockchain.

Chain: 1 MEC = 100,000,000 umec | addresses: me1... | coin type 118 | master: ${sweepCfg.masterAddress}

## YOU CAN EXECUTE REAL ON-CHAIN ACTIONS

When the user asks you to execute any of these actions, respond helpfully AND include a structured proposal block:

<PROPOSAL>
{"type":"sweep_all","description":"Brief description of what will execute"}
</PROPOSAL>

**When to use each type:**
- "sweep_all" → user wants to withdraw / sweep / move / empty / transfer ALL balances to master
- "claim_staking" → user wants to claim / harvest / collect staking or block rewards  
- "claim_then_sweep" → user wants to claim rewards AND sweep balance to master

**Rules you enforce:**
- Only VERIFIED wallets can transfer (unverified = monitor only, no exceptions)
- Whitelist applies — master address must be whitelisted
- Network fee: 0.0001 MEC | Min sweep: ${sweepCfg.minSweepAmountMec} MEC
- Monthly dividends arrive days 1–7; always recommend sweeping during this window

**For informational questions** — answer normally, NO proposal block.
**For action requests** — always explain what you'll do, then add the proposal block at the end.

Be direct and concise. When the user gives a command like "withdraw all balances", don't ask for confirmation — just explain what will happen and include the proposal. The UI will handle password confirmation.${context}`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    ...history.slice(-20),
    { role: "user", content: message },
  ];

  try {
    const rawReply = await chatWithNvidia(messages, apiKey);
    const { reply, raw } = extractProposal(rawReply);

    let intentType: ActionProposal["type"] | null = null;
    let intentDescription = "";

    if (raw) {
      try {
        const p = JSON.parse(raw) as { type: ActionProposal["type"]; description: string };
        intentType = p.type;
        intentDescription = p.description;
      } catch { /* malformed — fall through to keyword detection */ }
    }

    // Fallback: keyword detect even if AI didn't emit a proposal block
    if (!intentType) {
      intentType = detectActionIntent(message);
      if (intentType) {
        intentDescription = {
          sweep_all: "Sweep all verified wallet balances to the master address",
          claim_staking: "Claim all pending staking rewards",
          claim_then_sweep: "Claim staking rewards then sweep all balances to master",
        }[intentType];
      }
    }

    let actionProposal: ActionProposal | null = null;
    if (intentType) {
      try {
        actionProposal = await buildProposal(intentType, intentDescription, allWallets, sweepCfg);
      } catch (err) {
        logger.warn({ err }, "Failed to build action proposal");
      }
    }

    const suggestedActions: string[] = [];
    if (!actionProposal) {
      const low = reply.toLowerCase();
      if (low.includes("sweep") || low.includes("dividend")) suggestedActions.push("Withdraw all balances to master");
      if (low.includes("staking") || low.includes("reward")) suggestedActions.push("Claim staking rewards");
      if (low.includes("claim") && low.includes("sweep")) suggestedActions.push("Claim then sweep all balances");
      if (low.includes("balance")) suggestedActions.push("Check wallet balances");
      if (low.includes("rule")) suggestedActions.push("Create automation rule");
      if (low.includes("whitelist")) suggestedActions.push("Manage whitelist addresses");
    }

    res.json({ reply, suggestedActions, actionProposal });
  } catch (err) {
    res.status(500).json({ error: `AI error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ── Execute Action (confirmed from chat) ─────────────────────────────────────

router.post("/agent/execute-action", async (req, res): Promise<void> => {
  const { type, password, dryRun = false } = req.body as {
    type: ActionProposal["type"]; password: string; dryRun?: boolean;
  };
  if (!type) { res.status(400).json({ error: "type is required" }); return; }
  if (!password) { res.status(400).json({ error: "password is required" }); return; }

  const sweepCfg = await getSweepConfig();
  const minSweepMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");
  const allWallets = await getAllItems<Wallet>(walletsRef());
  const verifiedWallets = allWallets.filter((w) => w.verified);

  if (verifiedWallets.length === 0) {
    res.status(400).json({ error: "No verified wallets found." }); return;
  }

  // Verify password first
  try { decryptMnemonic(verifiedWallets[0].encryptedMnemonic, password); }
  catch { res.status(400).json({ error: "Incorrect encryption password." }); return; }

  const logs: ReturnType<typeof mapLog>[] = [];
  let executed = 0;
  let skipped = 0;
  const dayOfMonth = new Date().getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;

  for (const wallet of verifiedWallets) {
    // Dry run preview
    if (dryRun) {
      if (type === "sweep_all" || type === "claim_then_sweep") {
        const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0" }));
        if (parseFloat(bal.balance) >= minSweepMEC) {
          const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "dry_run", txHash: null, amount: bal.balance, message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}` });
          logs.push(mapLog(log)); executed++;
        } else { skipped++; }
      }
      if (type === "claim_staking" || type === "claim_then_sweep") {
        const sr = await queryStakingRewards(wallet.address, wallet.network).catch(() => ({ totalMEC: "0" }));
        if (parseFloat(sr.totalMEC) >= minSweepMEC) {
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "dry_run", txHash: null, amount: sr.totalMEC, message: `[DRY RUN] Would claim ${sr.totalMEC} MEC staking rewards` });
          logs.push(mapLog(log)); executed++;
        }
      }
      continue;
    }

    // Decrypt wallet secret
    let secret: string;
    try { secret = decryptMnemonic(wallet.encryptedMnemonic, password); }
    catch {
      const log = await insertLog({ walletId: wallet.id, action: type, status: "error", txHash: null, amount: null, message: "Failed to decrypt wallet — incorrect password" });
      logs.push(mapLog(log)); skipped++; continue;
    }

    let privkeyHex: string;
    try { privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0); }
    catch (err) {
      const log = await insertLog({ walletId: wallet.id, action: type, status: "error", txHash: null, amount: null, message: `Key derivation failed: ${err instanceof Error ? err.message : String(err)}` });
      logs.push(mapLog(log)); skipped++; continue;
    }

    // Step 1 — Claim staking rewards
    if (type === "claim_staking" || type === "claim_then_sweep") {
      try {
        const sr = await queryStakingRewards(wallet.address, wallet.network);
        if (parseFloat(sr.totalMEC) >= minSweepMEC) {
          const result = await claimAllStakingRewards({ privkeyHex, delegatorAddress: wallet.address, network: wallet.network });
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "success", txHash: result.txHash, amount: sr.totalMEC, message: `Claimed ${sr.totalMEC} MEC staking rewards | TX: ${result.txHash}` });
          logs.push(mapLog(log)); executed++;
          if (type === "claim_then_sweep") await new Promise((r) => setTimeout(r, 6000));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("No withdrawable")) {
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "error", txHash: null, amount: null, message: `Claim failed: ${msg}` });
          logs.push(mapLog(log));
        }
      }
      if (type === "claim_staking") continue;
    }

    // Step 2 — Sweep balance to master
    try {
      const bal = await queryBalance(wallet.address, wallet.network);
      if (parseFloat(bal.balance) < minSweepMEC) { skipped++; continue; }
      const result = await sweepToMaster({
        privkeyHex, fromAddress: wallet.address, masterAddress: sweepCfg.masterAddress,
        network: wallet.network, memo: inDividendWindow ? `chat-sweep dividend-day-${dayOfMonth}` : "chat-sweep",
      });
      const log = await insertLog({
        walletId: wallet.id,
        action: inDividendWindow ? "sweep_dividend" : "sweep_balance",
        status: "success", txHash: result.txHash, amount: result.amountMEC.toFixed(8),
        message: `Swept ${result.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${result.txHash}`,
      });
      logs.push(mapLog(log)); executed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Insufficient balance")) {
        const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `Sweep failed: ${msg}` });
        logs.push(mapLog(log));
      }
      skipped++;
    }
  }

  res.json({ executed, skipped, dryRun, masterAddress: sweepCfg.masterAddress, logs });
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
  await clearPath(logsRef());
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
    totalWallets: wallets.length, verifiedWallets: wallets.filter((w) => w.verified).length,
    totalWithdrawals: nonRunLogs.length, successfulWithdrawals: successLogs.length,
    failedWithdrawals: nonRunLogs.length - successLogs.length,
    activeRules: rules.filter((r) => r.enabled).length, lastRunAt: lastLog?.createdAt ?? null,
  });
});

// ── Verify Password ───────────────────────────────────────────────────────────

router.post("/agent/verify-password", async (req, res): Promise<void> => {
  const { password } = req.body as { password: string };
  if (!password) { res.status(400).json({ error: "password is required" }); return; }
  const wallets = await getAllItems<Wallet>(walletsRef());
  const verified = wallets.filter((w) => w.verified);
  if (verified.length === 0) { res.status(400).json({ error: "No verified wallets found" }); return; }
  try { decryptMnemonic(verified[0].encryptedMnemonic, password); }
  catch { res.status(400).json({ valid: false, error: "Incorrect password." }); return; }
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
  let swept = 0; let skipped = 0;

  for (const wallet of verifiedWallets) {
    if (dryRun) {
      const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0", denom: "MEC" }));
      if (parseFloat(bal.balance) >= minSweepMEC) {
        const log = await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "dry_run", txHash: null, amount: bal.balance, message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}` });
        logs.push(mapLog(log)); swept++;
      } else { skipped++; }
      continue;
    }
    let secret: string;
    try { secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword); }
    catch { const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: "Failed to decrypt wallet — incorrect password" }); logs.push(mapLog(log)); skipped++; continue; }
    let privkeyHex: string;
    try { privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0); }
    catch (err) { const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `Key derivation failed: ${err instanceof Error ? err.message : String(err)}` }); logs.push(mapLog(log)); skipped++; continue; }

    if (sweepCfg.autoClaimStaking) {
      try {
        const sr = await queryStakingRewards(wallet.address, wallet.network);
        if (parseFloat(sr.totalMEC) >= minSweepMEC) {
          const claimResult = await claimAllStakingRewards({ privkeyHex, delegatorAddress: wallet.address, network: wallet.network });
          const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "success", txHash: claimResult.txHash, amount: sr.totalMEC, message: `Claimed ${sr.totalMEC} MEC staking rewards | TX: ${claimResult.txHash}` });
          logs.push(mapLog(log)); await new Promise((r) => setTimeout(r, 6000));
        }
      } catch (err) { const msg = err instanceof Error ? err.message : String(err); if (!msg.includes("No withdrawable")) { const log = await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "error", txHash: null, amount: null, message: `Staking claim skipped: ${msg}` }); logs.push(mapLog(log)); } }
    }

    try {
      const bal = await queryBalance(wallet.address, wallet.network);
      if (parseFloat(bal.balance) < minSweepMEC) { skipped++; continue; }
      const sweepResult = await sweepToMaster({ privkeyHex, fromAddress: wallet.address, masterAddress: sweepCfg.masterAddress, network: wallet.network, memo: inDividendWindow ? `dividend-sweep day-${dayOfMonth}` : "manual-sweep" });
      const log = await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "success", txHash: sweepResult.txHash, amount: sweepResult.amountMEC.toFixed(8), message: `Swept ${sweepResult.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${sweepResult.txHash}` });
      logs.push(mapLog(log)); swept++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Insufficient balance")) { const log = await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `Sweep failed: ${msg}` }); logs.push(mapLog(log)); }
      skipped++;
    }
  }

  res.json({ swept, skipped, dryRun, masterAddress: sweepCfg.masterAddress, logs });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapLog(log: WithId<AgentLog> & { walletLabel?: string | null }) {
  return {
    id: log.id, walletId: log.walletId, walletLabel: log.walletLabel ?? null,
    action: log.action, status: log.status, txHash: log.txHash,
    amount: log.amount, message: log.message, createdAt: log.createdAt,
  };
}

export default router;
