import { Router } from "express";
import {
  getAllItems, pushItem, deleteItem, getItem,
  whitelistRef, type WhitelistEntry, now,
} from "../lib/firebase-db";

const router = Router();

router.get("/whitelist", async (_req, res): Promise<void> => {
  const entries = await getAllItems<WhitelistEntry>(whitelistRef());
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json(entries);
});

router.post("/whitelist", async (req, res): Promise<void> => {
  const { address, label } = req.body as { address: string; label?: string };
  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const all = await getAllItems<WhitelistEntry>(whitelistRef());
  if (all.some((e) => e.address === address)) {
    res.status(409).json({ error: "Address is already whitelisted" });
    return;
  }

  const entry = await pushItem<WhitelistEntry>(whitelistRef(), {
    address,
    label: label ?? null,
    createdAt: now(),
  });

  res.status(201).json(entry);
});

router.delete("/whitelist/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await getItem<WhitelistEntry>(whitelistRef(), id);
  if (!existing) { res.status(404).json({ error: "Entry not found" }); return; }

  await deleteItem(whitelistRef(), id);
  res.sendStatus(204);
});

export default router;
