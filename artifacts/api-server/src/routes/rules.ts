import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, rulesTable } from "@workspace/db";
import {
  CreateRuleBody,
  UpdateRuleParams,
  UpdateRuleBody,
  DeleteRuleParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/rules", async (_req, res): Promise<void> => {
  const rules = await db
    .select()
    .from(rulesTable)
    .orderBy(rulesTable.createdAt);
  res.json(rules);
});

router.post("/rules", async (req, res): Promise<void> => {
  const parsed = CreateRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [rule] = await db
    .insert(rulesTable)
    .values({
      name: parsed.data.name,
      ruleType: parsed.data.ruleType,
      enabled: parsed.data.enabled ?? true,
      conditionJson: parsed.data.conditionJson ?? null,
      actionJson: parsed.data.actionJson ?? null,
    })
    .returning();

  res.status(201).json(rule);
});

router.patch("/rules/:id", async (req, res): Promise<void> => {
  const params = UpdateRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.enabled != null) updates.enabled = parsed.data.enabled;
  if (parsed.data.conditionJson != null) updates.conditionJson = parsed.data.conditionJson;
  if (parsed.data.actionJson != null) updates.actionJson = parsed.data.actionJson;

  const [rule] = await db
    .update(rulesTable)
    .set(updates)
    .where(eq(rulesTable.id, params.data.id))
    .returning();

  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  res.json(rule);
});

router.delete("/rules/:id", async (req, res): Promise<void> => {
  const params = DeleteRuleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(rulesTable)
    .where(eq(rulesTable.id, params.data.id))
    .returning({ id: rulesTable.id });

  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
