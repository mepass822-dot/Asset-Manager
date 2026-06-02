import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import {
  CreateWalletBody,
  GetWalletParams,
  DeleteWalletParams,
  GetWalletBalanceParams,
} from "@workspace/api-zod";
import { encryptMnemonic, decryptMnemonic } from "../lib/crypto";
import { queryBalance, deriveMECAddress } from "../lib/blockchain";

const router = Router();

router.get("/wallets", async (req, res): Promise<void> => {
  const wallets = await db
    .select({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
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

  const address = deriveMECAddress(mnemonic);
  const encryptedMnemonic = encryptMnemonic(mnemonic, password);

  const [wallet] = await db
    .insert(walletsTable)
    .values({ label, address, encryptedMnemonic, network })
    .returning({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
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

router.post("/wallets/import-extension", async (req, res): Promise<void> => {
  const { wallets } = req.body as {
    wallets: Array<{
      label: string;
      mnemonic: string;
      priv?: string;
      address?: string;
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
      const address = w.address || deriveMECAddress(w.mnemonic);
      const existing = await db
        .select({ id: walletsTable.id })
        .from(walletsTable)
        .where(eq(walletsTable.address, address));

      if (existing.length > 0) { skipped++; continue; }

      const encryptedMnemonic = encryptMnemonic(w.mnemonic, w.password);
      const label = w.label || `Imported ${address.slice(0, 8)}`;
      await db.insert(walletsTable).values({
        label,
        address,
        encryptedMnemonic,
        network: w.network || "mainnet",
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
