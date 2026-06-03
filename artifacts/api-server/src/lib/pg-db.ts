import {
  db,
  walletsTable, rulesTable, agentLogsTable, whitelistTable, sweepConfigTable,
  type InsertWallet, type InsertRule, type InsertAgentLog, type InsertWhitelist,
} from "@workspace/db";
import { eq, desc, asc } from "drizzle-orm";

export type { InsertWallet, InsertRule, InsertAgentLog, InsertWhitelist };

export type Wallet = typeof walletsTable.$inferSelect;
export type Rule = typeof rulesTable.$inferSelect;
export type AgentLog = typeof agentLogsTable.$inferSelect;
export type WhitelistEntry = typeof whitelistTable.$inferSelect;
export type SweepConfig = typeof sweepConfigTable.$inferSelect;

export function now(): string {
  return new Date().toISOString();
}

// ── Wallets ───────────────────────────────────────────────────────────────────

export async function getAllWallets(): Promise<Wallet[]> {
  return db.select().from(walletsTable).orderBy(asc(walletsTable.createdAt));
}

export async function getWalletById(id: number): Promise<Wallet | null> {
  const rows = await db.select().from(walletsTable).where(eq(walletsTable.id, id));
  return rows[0] ?? null;
}

export async function insertWallet(data: Omit<InsertWallet, "id" | "createdAt" | "updatedAt">): Promise<Wallet> {
  const rows = await db.insert(walletsTable).values(data).returning();
  return rows[0];
}

export async function updateWallet(id: number, data: Partial<Omit<InsertWallet, "id" | "createdAt">>): Promise<void> {
  await db.update(walletsTable).set({ ...data, updatedAt: new Date() }).where(eq(walletsTable.id, id));
}

export async function deleteWallet(id: number): Promise<void> {
  await db.delete(walletsTable).where(eq(walletsTable.id, id));
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export async function getAllRules(): Promise<Rule[]> {
  return db.select().from(rulesTable).orderBy(asc(rulesTable.createdAt));
}

export async function getRuleById(id: number): Promise<Rule | null> {
  const rows = await db.select().from(rulesTable).where(eq(rulesTable.id, id));
  return rows[0] ?? null;
}

export async function insertRule(data: Omit<InsertRule, "id" | "createdAt" | "updatedAt">): Promise<Rule> {
  const rows = await db.insert(rulesTable).values(data).returning();
  return rows[0];
}

export async function updateRule(id: number, data: Partial<Omit<InsertRule, "id" | "createdAt">>): Promise<void> {
  await db.update(rulesTable).set({ ...data, updatedAt: new Date() }).where(eq(rulesTable.id, id));
}

export async function deleteRule(id: number): Promise<void> {
  await db.delete(rulesTable).where(eq(rulesTable.id, id));
}

// ── Agent Logs ────────────────────────────────────────────────────────────────

export async function getAllLogs(limit = 50, walletId?: number): Promise<AgentLog[]> {
  if (walletId !== undefined) {
    return db.select().from(agentLogsTable)
      .where(eq(agentLogsTable.walletId, walletId))
      .orderBy(desc(agentLogsTable.createdAt))
      .limit(limit);
  }
  return db.select().from(agentLogsTable)
    .orderBy(desc(agentLogsTable.createdAt))
    .limit(limit);
}

export async function insertLog(data: {
  walletId: number | null;
  action: string;
  status: string;
  txHash: string | null;
  amount: string | null;
  message: string;
}): Promise<AgentLog> {
  const rows = await db.insert(agentLogsTable).values(data).returning();
  return rows[0];
}

export async function clearAllLogs(): Promise<void> {
  await db.delete(agentLogsTable);
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

export async function getAllWhitelist(): Promise<WhitelistEntry[]> {
  return db.select().from(whitelistTable).orderBy(asc(whitelistTable.createdAt));
}

export async function getWhitelistEntryById(id: number): Promise<WhitelistEntry | null> {
  const rows = await db.select().from(whitelistTable).where(eq(whitelistTable.id, id));
  return rows[0] ?? null;
}

export async function insertWhitelistEntry(data: { address: string; label: string }): Promise<WhitelistEntry> {
  const rows = await db.insert(whitelistTable).values(data).returning();
  return rows[0];
}

export async function deleteWhitelistEntry(id: number): Promise<void> {
  await db.delete(whitelistTable).where(eq(whitelistTable.id, id));
}

// ── Sweep Config ──────────────────────────────────────────────────────────────

const SWEEP_DEFAULTS = {
  masterAddress: "me1h4fc80gz38ms8tejlj37rxmf7uh6xe25fk0tfx",
  enabled: false,
  autoClaimStaking: false,
  dividendWindowDays: 7,
  minSweepAmountMec: "0.001",
};

export async function getSweepConfig(): Promise<SweepConfig> {
  const rows = await db.select().from(sweepConfigTable).limit(1);
  if (rows.length === 0) {
    const inserted = await db.insert(sweepConfigTable).values(SWEEP_DEFAULTS).returning();
    return inserted[0];
  }
  return rows[0];
}

export async function setSweepConfig(updates: Partial<Omit<SweepConfig, "id" | "updatedAt">>): Promise<SweepConfig> {
  const current = await getSweepConfig();
  const updated = await db.update(sweepConfigTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(sweepConfigTable.id, current.id))
    .returning();
  return updated[0];
}
