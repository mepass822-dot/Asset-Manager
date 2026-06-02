import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, whitelistTable } from "@workspace/db";
import { CreateWhitelistEntryBody, DeleteWhitelistEntryParams } from "@workspace/api-zod";

const router = Router();

router.get("/whitelist", async (_req, res): Promise<void> => {
  const entries = await db
    .select()
    .from(whitelistTable)
    .orderBy(whitelistTable.createdAt);
  res.json(entries);
});

router.post("/whitelist", async (req, res): Promise<void> => {
  const body = CreateWhitelistEntryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const existing = await db
    .select()
    .from(whitelistTable)
    .where(eq(whitelistTable.address, body.data.address));
  if (existing.length > 0) {
    res.status(409).json({ error: "Address is already whitelisted" });
    return;
  }

  const [entry] = await db
    .insert(whitelistTable)
    .values(body.data)
    .returning();
  res.status(201).json(entry);
});

router.delete("/whitelist/:id", async (req, res): Promise<void> => {
  const params = DeleteWhitelistEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(whitelistTable).where(eq(whitelistTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
