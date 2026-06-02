import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";

export const sweepConfigTable = pgTable("sweep_config", {
  id: serial("id").primaryKey(),
  masterAddress: text("master_address").notNull().default("me1h4fc80gz38ms8tejlj37rxmf7uh6xe25fk0tfx"),
  enabled: boolean("enabled").notNull().default(false),
  autoClaimStaking: boolean("auto_claim_staking").notNull().default(false),
  dividendWindowDays: integer("dividend_window_days").notNull().default(7),
  minSweepAmountMec: text("min_sweep_amount_mec").notNull().default("0.001"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type SweepConfig = typeof sweepConfigTable.$inferSelect;
