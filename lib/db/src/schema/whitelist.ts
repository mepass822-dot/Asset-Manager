import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const whitelistTable = pgTable("whitelist", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWhitelistSchema = createInsertSchema(whitelistTable).omit({
  id: true,
  createdAt: true,
});

export type InsertWhitelist = z.infer<typeof insertWhitelistSchema>;
export type WhitelistEntry = typeof whitelistTable.$inferSelect;
