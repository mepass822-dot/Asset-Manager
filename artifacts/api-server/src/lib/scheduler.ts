import { getAllItems, walletsRef, rulesRef, logsRef, whitelistRef, insertLog, getSweepConfig, type Wallet, type Rule, type WhitelistEntry } from "./firebase-db";
import { decryptMnemonic } from "./crypto";
import { queryBalance, queryStakingRewards, claimAllStakingRewards, sweepToMaster, getPrivateKeyHex, sendMEC } from "./blockchain";
import { agentDecide } from "./nvidia";
import { logger } from "./logger";

export interface SchedulerConfig {
  intervalMs: number;
  walletIds: string[];
  masterPassword: string;
  dryRun: boolean;
}

export interface SchedulerStatus {
  enabled: boolean;
  intervalMs: number | null;
  walletIds: string[];
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
  const sweepCfg = await getSweepConfig();

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const inDividendWindow = dayOfMonth >= 1 && dayOfMonth <= sweepCfg.dividendWindowDays;
  const minSweepMEC = parseFloat(sweepCfg.minSweepAmountMec ?? "0.001");

  if (!apiKey) {
    await insertLog({ walletId: null, action: "scheduled_run", status: "error", txHash: null, amount: null, message: "Scheduler: NVIDIA_API_KEY not configured" });
    return { executed: 0, skipped: cfg.walletIds.length };
  }

  const allWallets = await getAllItems<Wallet>(walletsRef());
  const selectedWallets = cfg.walletIds.length > 0
    ? allWallets.filter((w) => cfg.walletIds.includes(w.id))
    : allWallets;

  const verifiedWallets = selectedWallets.filter((w) => w.verified);
  const unverifiedWallets = selectedWallets.filter((w) => !w.verified);

  const rules = await getAllItems<Rule>(rulesRef());
  const enabledRules = rules.filter((r) => r.enabled);

  let executed = 0;

  // ── Phase 1: Deterministic sweep pipeline ───────────────────────────────────
  if (sweepCfg.enabled && !cfg.dryRun) {
    for (const wallet of verifiedWallets) {
      try {
        const secret = decryptMnemonic(wallet.encryptedMnemonic, cfg.masterPassword);
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);

        if (sweepCfg.autoClaimStaking) {
          try {
            const stakingRewards = await queryStakingRewards(wallet.address, wallet.network);
            if (parseFloat(stakingRewards.totalMEC) >= minSweepMEC) {
              logger.info({ wallet: wallet.label, rewardMEC: stakingRewards.totalMEC }, "Claiming staking rewards");
              const claimResult = await claimAllStakingRewards({ privkeyHex, delegatorAddress: wallet.address, network: wallet.network });
              await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "success", amount: stakingRewards.totalMEC, txHash: claimResult.txHash, message: `[AUTO] Claimed ${stakingRewards.totalMEC} MEC staking rewards | TX: ${claimResult.txHash}` });
              executed++;
              await new Promise((r) => setTimeout(r, 6000));
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ wallet: wallet.label, err: msg }, "Staking reward claim skipped");
            await insertLog({ walletId: wallet.id, action: "claim_staking_rewards", status: "error", txHash: null, amount: null, message: `[AUTO] Staking claim skipped: ${msg}` });
          }
        }

        const shouldSweepNow = inDividendWindow || sweepCfg.autoClaimStaking;
        if (shouldSweepNow) {
          try {
            const bal = await queryBalance(wallet.address, wallet.network);
            const balanceMEC = parseFloat(bal.balance);
            if (balanceMEC >= minSweepMEC) {
              const sweepResult = await sweepToMaster({ privkeyHex, fromAddress: wallet.address, masterAddress: sweepCfg.masterAddress, network: wallet.network, memo: inDividendWindow ? `dividend-sweep day-${dayOfMonth}` : "auto-sweep" });
              await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "success", amount: sweepResult.amountMEC.toFixed(8), txHash: sweepResult.txHash, message: `[AUTO] Swept ${sweepResult.amountMEC.toFixed(8)} MEC → ${sweepCfg.masterAddress} | TX: ${sweepResult.txHash}` });
              executed++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("Insufficient balance")) {
              await insertLog({ walletId: wallet.id, action: "sweep_balance", status: "error", txHash: null, amount: null, message: `[AUTO] Sweep failed: ${msg}` });
            }
          }
        }
      } catch (outerErr) {
        logger.error({ wallet: wallet.label, err: outerErr instanceof Error ? outerErr.message : String(outerErr) }, "Deterministic pipeline error");
      }
    }
  } else if (sweepCfg.enabled && cfg.dryRun) {
    for (const wallet of verifiedWallets) {
      const bal = await queryBalance(wallet.address, wallet.network).catch(() => ({ balance: "0", denom: "MEC" }));
      const balanceMEC = parseFloat(bal.balance);
      if (balanceMEC >= minSweepMEC) {
        await insertLog({ walletId: wallet.id, action: inDividendWindow ? "sweep_dividend" : "sweep_balance", status: "dry_run", amount: bal.balance, txHash: null, message: `[DRY RUN] Would sweep ${bal.balance} MEC → ${sweepCfg.masterAddress}${inDividendWindow ? ` (dividend window day ${dayOfMonth})` : ""}` });
        executed++;
      }
    }
  }

  // ── Phase 2: AI agent evaluation ─────────────────────────────────────────────
  const walletSummaries = await Promise.all(
    selectedWallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network).catch(() => ({ balance: "0", denom: "MEC" }));
      let stakingRewards = "0 MEC";
      try { const sr = await queryStakingRewards(w.address, w.network); stakingRewards = `${sr.totalMEC} MEC`; } catch { /* ignore */ }
      return { label: w.label, address: w.address, balance: `${bal.balance} ${bal.denom}`, stakingRewards, verified: w.verified };
    })
  );

  let decisions: Awaited<ReturnType<typeof agentDecide>> = [];
  try {
    decisions = await agentDecide(
      walletSummaries,
      enabledRules.map((r) => ({ name: r.name, ruleType: r.ruleType, conditionJson: r.conditionJson, actionJson: r.actionJson })),
      apiKey,
      { isDividendWindow: inDividendWindow, dayOfMonth, masterAddress: sweepCfg.masterAddress, autoSweepEnabled: sweepCfg.enabled, minSweepMEC }
    );
  } catch (err) {
    await insertLog({ walletId: null, action: "scheduled_run", status: "error", txHash: null, amount: null, message: `Scheduler AI error: ${err instanceof Error ? err.message : String(err)}` });
    return { executed, skipped: Math.max(0, selectedWallets.length - executed) };
  }

  const whitelistEntries = await getAllItems<WhitelistEntry>(whitelistRef());
  const whitelist = new Set(whitelistEntries.map((e) => e.address.toLowerCase()));
  const whitelistActive = whitelist.size > 0;

  for (const decision of decisions) {
    const wallet = selectedWallets.find((w) => w.label === decision.walletLabel);
    if (!wallet) continue;

    if (!wallet.verified) {
      await insertLog({ walletId: wallet.id, action: decision.action, status: "error", txHash: null, amount: decision.amount ?? null, message: `[BLOCKED] Wallet is unverified — no transfers allowed. ${decision.reason}` });
      continue;
    }

    if (cfg.dryRun) {
      await insertLog({ walletId: wallet.id, action: decision.action, status: "dry_run", txHash: null, amount: decision.amount ?? null, message: `[SCHEDULED DRY RUN] ${decision.reason}` });
      executed++;
      continue;
    }

    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, cfg.masterPassword);
      const isTransfer = /sweep|withdraw|send|transfer|claim/i.test(decision.action);
      const toAddress: string | undefined = decision.toAddress;

      if (isTransfer && toAddress && whitelistActive && !whitelist.has(toAddress.toLowerCase())) {
        await insertLog({ walletId: wallet.id, action: decision.action, status: "blocked", amount: decision.amount ?? null, txHash: null, message: `[WHITELIST BLOCKED] Destination ${toAddress} is not on the approved whitelist. ${decision.reason}` });
        continue;
      }

      if (isTransfer && toAddress && decision.amount) {
        const privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
        const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC: parseFloat(String(decision.amount)), memo: `agent: ${decision.reason}` });
        await insertLog({ walletId: wallet.id, action: decision.action, status: "success", amount: decision.amount ?? null, txHash: result.txHash, message: `[SCHEDULED] ${decision.reason} | TX: ${result.txHash}` });
      } else {
        await insertLog({ walletId: wallet.id, action: decision.action, status: "success", amount: decision.amount ?? null, txHash: null, message: `[SCHEDULED] ${decision.reason}` });
      }
      executed++;
    } catch (err) {
      await insertLog({ walletId: wallet.id, action: decision.action, status: "error", txHash: null, amount: decision.amount ?? null, message: `[SCHEDULED] ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return { executed, skipped: Math.max(0, selectedWallets.length - executed) };
}
