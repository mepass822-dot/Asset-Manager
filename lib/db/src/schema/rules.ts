import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rulesTable = pgTable("rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ruleType: text("rule_type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  conditionJson: text("condition_json"),
  actionJson: text("action_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRuleSchema = createInsertSchema(rulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRule = z.infer<typeof insertRuleSchema>;
export type Rule = typeof rulesTable.$inferSelect;
