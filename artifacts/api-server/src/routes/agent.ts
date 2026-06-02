import { Router } from "express";
import { eq, desc, count, and, sql } from "drizzle-orm";
import { db, walletsTable, agentLogsTable, rulesTable } from "@workspace/db";
import { RunAgentBody, AgentChatBody, ListAgentLogsQueryParams } from "@workspace/api-zod";
import { decryptMnemonic } from "../lib/crypto";
import { queryBalance, sendMEC, getPrivateKeyHex } from "../lib/blockchain";
import { agentDecide, chatWithNvidia } from "../lib/nvidia";
import { logger } from "../lib/logger";
import { getSchedulerStatus, startScheduler, stopScheduler } from "../lib/scheduler";

const router = Router();

const getNvidiaKey = () => process.env["NVIDIA_API_KEY"] ?? "";

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

  const walletSummaries = await Promise.all(
    wallets.map(async (w) => {
      const bal = await queryBalance(w.address, w.network);
      return { label: w.label, address: w.address, balance: `${bal.balance} ${bal.denom}` };
    })
  );

  const createdLogs: typeof agentLogsTable.$inferSelect[] = [];

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
    decisions = await agentDecide(walletSummaries, rules.map((r) => ({
      name: r.name,
      ruleType: r.ruleType,
      conditionJson: r.conditionJson,
      actionJson: r.actionJson,
    })), apiKey);
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

      // If the decision is a withdraw/send action and specifies a destination, broadcast it
      const isTransfer = /withdraw|send|transfer/i.test(decision.action);
      const toAddress: string | undefined = (decision as { toAddress?: string }).toAddress;

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
        // Non-transfer action (stake, review, etc.) — log as executed without broadcasting
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
    }).from(walletsTable);
    context = `\n\nWallet context:\n${JSON.stringify(wallets, null, 2)}`;
  }

  const systemPrompt = `You are an AI assistant for the Meta Earth Wallet Agent — an autonomous system that manages multiple MEC (Meta Earth Coin) cryptocurrency wallets.
You help the user understand their wallets, plan withdrawals, configure automation rules, and monitor activity.
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
    if (reply.toLowerCase().includes("withdraw")) suggestedActions.push("Run agent with withdrawal rule");
    if (reply.toLowerCase().includes("rule")) suggestedActions.push("Create automation rule");
    if (reply.toLowerCase().includes("balance")) suggestedActions.push("Check wallet balances");

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
