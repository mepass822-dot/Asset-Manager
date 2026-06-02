import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { walletsTable } from "./wallets";

export const agentLogsTable = pgTable("agent_logs", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").references(() => walletsTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  status: text("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  amount: text("amount"),
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAgentLogSchema = createInsertSchema(agentLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentLog = z.infer<typeof insertAgentLogSchema>;
export type AgentLog = typeof agentLogsTable.$inferSelect;
