import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import {
  CreateWalletBody,
  GetWalletParams,
  DeleteWalletParams,
  GetWalletBalanceParams,
} from "@workspace/api-zod";
import { encryptMnemonic } from "../lib/crypto";
import { queryBalance, deriveMECAddressAsync, deriveMultipleAccounts } from "../lib/blockchain";

const router = Router();

router.get("/wallets", async (req, res): Promise<void> => {
  const wallets = await db
    .select({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      hdIndex: walletsTable.hdIndex,
      createdAt: walletsTable.createdAt,
    })
    .from(walletsTable)
    .orderBy(walletsTable.createdAt);
  res.json(wallets);
});

router.post("/wallets", async (req, res): Promise<void> => {
  const parsed = CreateWalletBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { label, mnemonic, password, network } = parsed.data;

  let address: string;
  let hdIndex = 0;
  try {
    const derived = await deriveMECAddressAsync(mnemonic, 0);
    address = derived.address;
  } catch {
    res.status(400).json({ error: "Invalid mnemonic phrase" });
    return;
  }

  const encryptedMnemonic = encryptMnemonic(mnemonic, password);

  const [wallet] = await db
    .insert(walletsTable)
    .values({ label, address, encryptedMnemonic, network, hdIndex })
    .returning({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      hdIndex: walletsTable.hdIndex,
      createdAt: walletsTable.createdAt,
    });

  req.log.info({ walletId: wallet.id, label }, "Wallet added");
  res.status(201).json(wallet);
});

router.get("/wallets/:id", async (req, res): Promise<void> => {
  const params = GetWalletParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [wallet] = await db
    .select({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      hdIndex: walletsTable.hdIndex,
      createdAt: walletsTable.createdAt,
    })
    .from(walletsTable)
    .where(eq(walletsTable.id, params.data.id));

  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }

  res.json(wallet);
});

router.delete("/wallets/:id", async (req, res): Promise<void> => {
  const params = DeleteWalletParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(walletsTable)
    .where(eq(walletsTable.id, params.data.id))
    .returning({ id: walletsTable.id });

  if (!deleted) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/wallets/:id/balance", async (req, res): Promise<void> => {
  const params = GetWalletBalanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.id, params.data.id));

  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }

  const balanceInfo = await queryBalance(wallet.address, wallet.network);

  res.json({
    walletId: wallet.id,
    address: wallet.address,
    balance: balanceInfo.balance,
    denom: balanceInfo.denom,
    usdValue: null,
  });
});

// Preview derived accounts from a mnemonic without saving them
router.post("/wallets/derive-accounts", async (req, res): Promise<void> => {
  const { mnemonic, count = 5 } = req.body as { mnemonic: string; count?: number };

  if (!mnemonic || typeof mnemonic !== "string") {
    res.status(400).json({ error: "mnemonic is required" });
    return;
  }

  const safeCount = Math.min(Math.max(1, Number(count) || 5), 20);

  try {
    const accounts = await deriveMultipleAccounts(mnemonic.trim(), safeCount);
    res.json({ accounts });
  } catch {
    res.status(400).json({ error: "Invalid mnemonic phrase" });
  }
});

// Import wallets from the Meta Earth Chrome extension
router.post("/wallets/import-extension", async (req, res): Promise<void> => {
  const { wallets } = req.body as {
    wallets: Array<{
      label: string;
      mnemonic: string;
      address?: string;
      hdIndex?: number;
      password: string;
      network: string;
    }>;
  };

  if (!Array.isArray(wallets) || wallets.length === 0) {
    res.status(400).json({ error: "No wallets provided" });
    return;
  }

  let imported = 0;
  let skipped = 0;

  for (const w of wallets) {
    if (!w.mnemonic || !w.password) { skipped++; continue; }
    try {
      const hdIndex = typeof w.hdIndex === "number" ? w.hdIndex : 0;

      // Derive real address from mnemonic at the correct HD index
      let address: string;
      try {
        const derived = await deriveMECAddressAsync(w.mnemonic, hdIndex);
        address = derived.address;
      } catch {
        // Fall back to provided address if derivation fails
        if (w.address) {
          address = w.address;
        } else {
          skipped++;
          continue;
        }
      }

      const existing = await db
        .select({ id: walletsTable.id })
        .from(walletsTable)
        .where(eq(walletsTable.address, address));

      if (existing.length > 0) { skipped++; continue; }

      const encryptedMnemonic = encryptMnemonic(w.mnemonic, w.password);
      const label = w.label || `Account ${hdIndex} (${address.slice(0, 8)})`;

      await db.insert(walletsTable).values({
        label,
        address,
        encryptedMnemonic,
        network: w.network || "mainnet",
        hdIndex,
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  req.log.info({ imported, skipped }, "Extension import complete");
  res.json({ imported, skipped });
});

export default router;
