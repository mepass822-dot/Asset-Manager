import { Router } from "express";
import {
  getAllItems, pushItem, getItem, updateItem, deleteItem,
  rulesRef, type Rule, now,
} from "../lib/firebase-db";

const router = Router();

router.get("/rules", async (_req, res): Promise<void> => {
  const rules = await getAllItems<Rule>(rulesRef());
  rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json(rules);
});

router.post("/rules", async (req, res): Promise<void> => {
  const { name, ruleType, enabled, conditionJson, actionJson } = req.body as {
    name: string;
    ruleType: string;
    enabled?: boolean;
    conditionJson?: string | null;
    actionJson?: string | null;
  };

  if (!name || !ruleType) {
    res.status(400).json({ error: "name and ruleType are required" });
    return;
  }

  const ts = now();
  const rule = await pushItem<Rule>(rulesRef(), {
    name,
    ruleType,
    enabled: enabled ?? true,
    conditionJson: conditionJson ?? null,
    actionJson: actionJson ?? null,
    createdAt: ts,
    updatedAt: ts,
  });

  res.status(201).json(rule);
});

router.patch("/rules/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await getItem<Rule>(rulesRef(), id);
  if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

  const { name, enabled, conditionJson, actionJson } = req.body as Partial<Rule>;
  const updates: Partial<Rule> = { updatedAt: now() };
  if (name != null) updates.name = name;
  if (enabled != null) updates.enabled = enabled;
  if (conditionJson != null) updates.conditionJson = conditionJson;
  if (actionJson != null) updates.actionJson = actionJson;

  await updateItem(rulesRef(), id, updates);
  res.json({ ...existing, ...updates });
});

router.delete("/rules/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await getItem<Rule>(rulesRef(), id);
  if (!existing) { res.status(404).json({ error: "Rule not found" }); return; }

  await deleteItem(rulesRef(), id);
  res.sendStatus(204);
});

export default router;
