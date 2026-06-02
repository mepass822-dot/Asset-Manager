import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const walletsTable = pgTable("wallets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  address: text("address").notNull(),
  encryptedMnemonic: text("encrypted_mnemonic").notNull(),
  network: text("network").notNull().default("mainnet"),
  hdIndex: integer("hd_index").notNull().default(0),
  verified: boolean("verified").notNull().default(true),
  monitored: boolean("monitored").notNull().default(false),
  importSource: text("import_source").notNull().default("manual"),
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
