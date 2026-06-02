import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull(),
  encryptedMnemonic: text("encrypted_mnemonic").notNull(),
  network: text("network").notNull().default("mainnet"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof walletsTable.$inferSelect;
