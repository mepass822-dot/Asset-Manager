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
import { queryBalance, deriveMECAddressAsync, deriveMultipleAccounts, deriveAddressFromPrivateKey, PRIVATE_KEY_PREFIX, sendMEC, getPrivateKeyHex, meToGcAddress, gcAddressFromPrivkeyHex } from "../lib/blockchain";

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

  // Attach the on-chain gc1... address alongside each wallet
  const walletsWithGc = wallets.map((w) => {
    let gcAddress: string | null = null;
    try { gcAddress = meToGcAddress(w.address); } catch { /* ignore */ }
    return { ...w, gcAddress };
  });

  res.json(walletsWithGc);
});

router.post("/wallets", async (req, res): Promise<void> => {
  const parsed = CreateWalletBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { label, mnemonic, privateKey, password, network } = parsed.data;

  let address: string;
  let hdIndex = 0;
  let secretToEncrypt: string;

  if (privateKey) {
    try {
      const derived = await deriveAddressFromPrivateKey(privateKey);
      address = derived.address;
      secretToEncrypt = PRIVATE_KEY_PREFIX + derived.privkeyHex;
    } catch (err) {
      res.status(400).json({ error: `Invalid private key: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  } else if (mnemonic) {
    try {
      const derived = await deriveMECAddressAsync(mnemonic, 0);
      address = derived.address;
      secretToEncrypt = mnemonic;
    } catch {
      res.status(400).json({ error: "Invalid mnemonic phrase" });
      return;
    }
  } else {
    res.status(400).json({ error: "Either mnemonic or privateKey is required" });
    return;
  }

  const encryptedMnemonic = encryptMnemonic(secretToEncrypt, password);

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

// Send MEC from a wallet to a destination address
router.post("/wallets/:id/send", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid wallet id" }); return; }

  const { toAddress, amountMEC, masterPassword, memo } = req.body as {
    toAddress: string;
    amountMEC: number;
    masterPassword: string;
    memo?: string;
  };

  if (!toAddress || !amountMEC || !masterPassword) {
    res.status(400).json({ error: "toAddress, amountMEC, and masterPassword are required" });
    return;
  }
  if (!toAddress.startsWith("me1") && !toAddress.startsWith("gc1")) {
    res.status(400).json({ error: "toAddress must be a valid me1... or gc1... address" });
    return;
  }
  if (amountMEC <= 0) {
    res.status(400).json({ error: "amountMEC must be greater than 0" });
    return;
  }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, id));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }

  let secret: string;
  try {
    secret = decryptMnemonic(wallet.encryptedMnemonic, masterPassword);
  } catch {
    res.status(401).json({ error: "Incorrect password — could not decrypt wallet" });
    return;
  }

  let privkeyHex: string;
  try {
    privkeyHex = await getPrivateKeyHex(secret, wallet.hdIndex ?? 0);
  } catch (err) {
    res.status(400).json({ error: `Key derivation failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // Verify the derived key actually corresponds to the stored address
  const storedGc = meToGcAddress(wallet.address);
  const derivedGc = await gcAddressFromPrivkeyHex(privkeyHex);
  if (storedGc !== derivedGc) {
    req.log.error({ walletId: id, storedGc, derivedGc }, "Key derivation mismatch — wrong HD path or coin type");
    res.status(400).json({
      error: `Key mismatch: the stored address is ${wallet.address} (on-chain: ${storedGc}), but the private key derived from your mnemonic corresponds to a different address (${derivedGc}). This wallet may have been imported with a different HD path or coin type than what the agent uses (coin type 118, path m/44'/118'/0'/0/${wallet.hdIndex ?? 0}).`,
    });
    return;
  }

  // Pre-flight: check on-chain balance before attempting the send
  try {
    const bal = await queryBalance(wallet.address, wallet.network ?? "mainnet");
    const numBal = parseFloat(bal.balance);
    if (!isNaN(numBal) && numBal === 0) {
      res.status(400).json({
        error: `Wallet has no on-chain balance. The address ${wallet.address} (on-chain: ${storedGc}) has 0 MEC on the gc_20-1 chain. Please send MEC to this address before initiating a transfer.`,
      });
      return;
    }
  } catch { /* if balance check fails, proceed and let the chain error speak */ }

  try {
    const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC, memo });
    req.log.info({ walletId: id, txHash: result.txHash, amountMEC, toAddress }, "MEC sent");
    res.json({ txHash: result.txHash, height: result.height, fromAddress: wallet.address, toAddress, amountMEC });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ walletId: id, err: msg }, "Send failed");

    // Translate common chain errors into plain English
    if (msg.includes("does not exist on chain") || msg.includes("not found")) {
      res.status(400).json({
        error: `The wallet address has no on-chain history. Send MEC to ${wallet.address} (on-chain gc1 address: ${storedGc}) first, then retry the transfer.`,
      });
      return;
    }
    if (msg.includes("insufficient funds")) {
      res.status(400).json({ error: `Insufficient funds. Check that your wallet has enough MEC to cover the amount plus the 1 GC network fee.` });
      return;
    }
    res.status(500).json({ error: msg });
  }
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
      mnemonic?: string;
      privateKey?: string;
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
    if ((!w.mnemonic && !w.privateKey) || !w.password) { skipped++; continue; }
    try {
      const hdIndex = typeof w.hdIndex === "number" ? w.hdIndex : 0;

      let address: string;
      let secretToEncrypt: string;

      if (w.privateKey) {
        // Private key import path
        try {
          const derived = await deriveAddressFromPrivateKey(w.privateKey);
          address = derived.address;
          secretToEncrypt = PRIVATE_KEY_PREFIX + derived.privkeyHex;
        } catch {
          if (w.address) {
            address = w.address;
            secretToEncrypt = PRIVATE_KEY_PREFIX + w.privateKey.trim().replace(/^0x/i, "");
          } else { skipped++; continue; }
        }
      } else {
        // Mnemonic import path
        try {
          const derived = await deriveMECAddressAsync(w.mnemonic!, hdIndex);
          address = derived.address;
          secretToEncrypt = w.mnemonic!;
        } catch {
          if (w.address) {
            address = w.address;
            secretToEncrypt = w.mnemonic!;
          } else { skipped++; continue; }
        }
      }

      const existing = await db
        .select({ id: walletsTable.id })
        .from(walletsTable)
        .where(eq(walletsTable.address, address));

      if (existing.length > 0) { skipped++; continue; }

      const encryptedMnemonic = encryptMnemonic(secretToEncrypt, w.password);
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
