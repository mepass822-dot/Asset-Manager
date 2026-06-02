import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import {
  CreateWalletBody,
  GetWalletParams,
  DeleteWalletParams,
  GetWalletBalanceParams,
} from "@workspace/api-zod";
import { encryptMnemonic, decryptMnemonic } from "../lib/crypto";
import {
  queryBalance,
  queryTransactions,
  queryStakingRewards,
  deriveMECAddressAsync,
  deriveMultipleAccounts,
  deriveAddressFromPrivateKey,
  isAddressVerifiedOnChain,
  PRIVATE_KEY_PREFIX,
  sendMEC,
  getPrivateKeyHex,
  normalizeMeAddress,
  gcAddressFromPrivkeyHex,
} from "../lib/blockchain";
import { whitelistTable } from "@workspace/db";

const meToGcAddress = normalizeMeAddress;

const router = Router();

router.get("/wallets", async (req, res): Promise<void> => {
  const wallets = await db
    .select({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      hdIndex: walletsTable.hdIndex,
      verified: walletsTable.verified,
      monitored: walletsTable.monitored,
      importSource: walletsTable.importSource,
      createdAt: walletsTable.createdAt,
    })
    .from(walletsTable)
    .orderBy(walletsTable.createdAt);

  const walletsWithGc = wallets.map((w) => {
    let gcAddress: string | null = null;
    try { gcAddress = normalizeMeAddress(w.address); } catch { /* ignore */ }
    return { ...w, gcAddress };
  });

  res.json(walletsWithGc);
});

// ─── Bulk set monitored flag ───────────────────────────────────────────────────
router.patch("/wallets/bulk-monitor", async (req, res): Promise<void> => {
  const { walletIds, monitored } = req.body as { walletIds: number[]; monitored: boolean };
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    res.status(400).json({ error: "walletIds must be a non-empty array" });
    return;
  }
  if (typeof monitored !== "boolean") {
    res.status(400).json({ error: "monitored must be a boolean" });
    return;
  }
  await db
    .update(walletsTable)
    .set({ monitored })
    .where(sql`${walletsTable.id} = ANY(${walletIds})`);
  res.json({ updated: walletIds.length, monitored });
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
    .values({ label, address, encryptedMnemonic, network, hdIndex, verified: true, importSource: "manual" })
    .returning({
      id: walletsTable.id,
      label: walletsTable.label,
      address: walletsTable.address,
      network: walletsTable.network,
      hdIndex: walletsTable.hdIndex,
      verified: walletsTable.verified,
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
      verified: walletsTable.verified,
      importSource: walletsTable.importSource,
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

router.get("/wallets/:id/transactions", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, id));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }

  const limit = Math.min(parseInt(String(req.query.limit ?? "25"), 10) || 25, 100);
  const transactions = await queryTransactions(wallet.address, wallet.network ?? "mainnet", limit);

  res.json({ walletId: wallet.id, address: wallet.address, transactions });
});

router.get("/wallets/:id/staking-rewards", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.id, id));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }

  try {
    const rewards = await queryStakingRewards(wallet.address, wallet.network ?? "mainnet");
    res.json({ walletId: wallet.id, address: wallet.address, ...rewards });
  } catch (err) {
    res.status(500).json({ error: `Failed to query staking rewards: ${err instanceof Error ? err.message : String(err)}` });
  }
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

  // Security guardrail: if a whitelist exists, only allow whitelisted destinations
  const whitelistEntries = await db.select().from(whitelistTable);
  if (whitelistEntries.length > 0) {
    const allowed = whitelistEntries.some((e) => e.address === toAddress);
    if (!allowed) {
      res.status(403).json({
        error: `Destination address ${toAddress} is not on the whitelist. Add it in the Whitelist page before sending funds there.`,
      });
      return;
    }
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

  const storedGc = meToGcAddress(wallet.address);
  const derivedGc = await gcAddressFromPrivkeyHex(privkeyHex);
  if (storedGc !== derivedGc) {
    req.log.error({ walletId: id, storedGc, derivedGc }, "Key derivation mismatch — wrong HD path or coin type");
    res.status(400).json({
      error: `Key mismatch: the stored address is ${wallet.address} (on-chain: ${storedGc}), but the private key derived from your mnemonic corresponds to a different address (${derivedGc}). This wallet may have been imported with a different HD path or coin type than what the agent uses (coin type 118, path m/44'/118'/0'/0/${wallet.hdIndex ?? 0}).`,
    });
    return;
  }

  try {
    const bal = await queryBalance(wallet.address, wallet.network ?? "mainnet");
    const numBal = parseFloat(bal.balance);
    if (!isNaN(numBal) && numBal === 0) {
      res.status(400).json({
        error: `Wallet has no on-chain balance. The address ${wallet.address} has 0 MEC. Please send MEC to this address before initiating a transfer.`,
      });
      return;
    }
  } catch { /* if balance check fails, proceed */ }

  try {
    const result = await sendMEC({ privkeyHex, fromAddress: wallet.address, toAddress, amountMEC, network: wallet.network ?? "mainnet", memo });
    req.log.info({ walletId: id, txHash: result.txHash, amountMEC, toAddress }, "MEC sent");
    res.json({ txHash: result.txHash, height: result.height, fromAddress: wallet.address, toAddress, amountMEC });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ walletId: id, err: msg }, "Send failed");
    if (msg.includes("does not exist on chain") || msg.includes("not found")) {
      res.status(400).json({ error: `The wallet address has no on-chain history. Send MEC to ${wallet.address} first, then retry.` });
      return;
    }
    if (msg.includes("insufficient funds")) {
      res.status(400).json({ error: `Insufficient funds. Check that your wallet has enough MEC to cover the amount plus the 0.0001 MEC network fee.` });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// ─── Bulk Mnemonic Import ──────────────────────────────────────────────────

/**
 * POST /api/wallets/bulk-import
 * Accepts a block of text containing one mnemonic phrase per line (12 or 24 words).
 * For each phrase: derives the ME address, checks on-chain verification status,
 * and imports into the DB. Verified and unverified wallets are stored separately
 * and clearly labelled — they are never mixed in the active pool.
 *
 * Body: { mnemonics: string, password: string, network?: string }
 *   - mnemonics: raw text with one phrase per line (or comma/semicolon separated)
 *   - password: encryption password for storing the secrets
 *   - network: "mainnet" (default) | "testnet"
 */
router.post("/wallets/bulk-import", async (req, res): Promise<void> => {
  const { mnemonics, password, network = "mainnet" } = req.body as {
    mnemonics: string;
    password: string;
    network?: string;
  };

  if (!mnemonics || typeof mnemonics !== "string") {
    res.status(400).json({ error: "mnemonics (text) is required" });
    return;
  }
  if (!password) {
    res.status(400).json({ error: "password is required" });
    return;
  }

  // Parse: split on newlines; also handle comma/semicolon as delimiters
  const lines = mnemonics
    .split(/[\n;]/)
    .map((l) => l.replace(/,/g, " ").trim())
    .filter(Boolean);

  // A valid BIP39 mnemonic is either 12 or 24 space-separated words
  const isValidMnemonic = (s: string) => {
    const words = s.trim().split(/\s+/);
    return words.length === 12 || words.length === 24;
  };

  const phrases = lines.filter(isValidMnemonic);
  if (phrases.length === 0) {
    res.status(400).json({ error: "No valid mnemonic phrases found (must be 12 or 24 words each, one per line)" });
    return;
  }

  const results = {
    verified: [] as Array<{ address: string; label: string; walletId: number }>,
    unverified: [] as Array<{ address: string; label: string; walletId: number }>,
    skipped: [] as Array<{ reason: string; phrase: string }>,
  };

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    try {
      // Derive address
      const derived = await deriveMECAddressAsync(phrase, 0);
      const address = derived.address;

      // Check for duplicate
      const existing = await db
        .select({ id: walletsTable.id })
        .from(walletsTable)
        .where(eq(walletsTable.address, address));
      if (existing.length > 0) {
        results.skipped.push({ reason: "duplicate", phrase: `${phrase.slice(0, 20)}...` });
        continue;
      }

      // Check on-chain verification status
      const verified = await isAddressVerifiedOnChain(address, network);

      const label = verified
        ? `Import #${i + 1} (${address.slice(0, 10)})`
        : `Import #${i + 1} [UNVERIFIED] (${address.slice(0, 10)})`;

      const encryptedMnemonic = encryptMnemonic(phrase, password);

      const [inserted] = await db
        .insert(walletsTable)
        .values({
          label,
          address,
          encryptedMnemonic,
          network,
          hdIndex: 0,
          verified,
          importSource: "bulk_import",
        })
        .returning({ id: walletsTable.id, address: walletsTable.address, label: walletsTable.label });

      if (verified) {
        results.verified.push({ address: inserted.address, label: inserted.label, walletId: inserted.id });
      } else {
        results.unverified.push({ address: inserted.address, label: inserted.label, walletId: inserted.id });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.skipped.push({ reason: msg, phrase: `${phrase.slice(0, 20)}...` });
    }
  }

  req.log.info({
    verified: results.verified.length,
    unverified: results.unverified.length,
    skipped: results.skipped.length,
  }, "Bulk mnemonic import complete");

  res.json({
    total: phrases.length,
    verified: results.verified.length,
    unverified: results.unverified.length,
    skipped: results.skipped.length,
    wallets: { verified: results.verified, unverified: results.unverified },
    skippedDetails: results.skipped,
  });
});

// Bulk private-key import — one raw private key per line (hex / 0x-hex / base64)
router.post("/wallets/bulk-import-keys", async (req, res): Promise<void> => {
  const { keys, password, network = "mainnet" } = req.body as {
    keys: string;
    password: string;
    network?: string;
  };

  if (!keys || typeof keys !== "string") {
    res.status(400).json({ error: "keys (text block) is required" });
    return;
  }
  if (!password) {
    res.status(400).json({ error: "password is required" });
    return;
  }

  const lines = keys
    .split(/[\n;]/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    res.status(400).json({ error: "No private keys found" });
    return;
  }

  const results = {
    verified:   [] as Array<{ address: string; label: string; walletId: number }>,
    unverified: [] as Array<{ address: string; label: string; walletId: number }>,
    skipped:    [] as Array<{ reason: string; key: string }>,
  };

  for (let i = 0; i < lines.length; i++) {
    const rawKey = lines[i];
    const displayKey = rawKey.slice(0, 12) + "…";
    try {
      const { address, privkeyHex } = await deriveAddressFromPrivateKey(rawKey);

      const existing = await db
        .select({ id: walletsTable.id })
        .from(walletsTable)
        .where(eq(walletsTable.address, address));
      if (existing.length > 0) {
        results.skipped.push({ reason: "duplicate", key: displayKey });
        continue;
      }

      const verified = await isAddressVerifiedOnChain(address, network);
      const label = verified
        ? `Key #${i + 1} (${address.slice(0, 10)})`
        : `Key #${i + 1} [UNVERIFIED] (${address.slice(0, 10)})`;

      const encryptedMnemonic = encryptMnemonic(PRIVATE_KEY_PREFIX + privkeyHex, password);

      const [inserted] = await db
        .insert(walletsTable)
        .values({ label, address, encryptedMnemonic, network, hdIndex: 0, verified, importSource: "bulk_key_import" })
        .returning({ id: walletsTable.id, address: walletsTable.address, label: walletsTable.label });

      if (verified) {
        results.verified.push({ address: inserted.address, label: inserted.label, walletId: inserted.id });
      } else {
        results.unverified.push({ address: inserted.address, label: inserted.label, walletId: inserted.id });
      }
    } catch (err) {
      results.skipped.push({ reason: err instanceof Error ? err.message : String(err), key: displayKey });
    }
  }

  req.log.info(
    { verified: results.verified.length, unverified: results.unverified.length, skipped: results.skipped.length },
    "Bulk private key import complete",
  );

  res.json({
    total: lines.length,
    verified: results.verified.length,
    unverified: results.unverified.length,
    skipped: results.skipped.length,
    wallets: { verified: results.verified, unverified: results.unverified },
    skippedDetails: results.skipped,
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
        if (w.address) {
          address = w.address;
          secretToEncrypt = w.mnemonic!;
        } else {
          try {
            const derived = await deriveMECAddressAsync(w.mnemonic!, hdIndex);
            address = derived.address;
            secretToEncrypt = w.mnemonic!;
          } catch {
            skipped++; continue;
          }
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
        verified: true,
        importSource: "extension",
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  req.log.info({ imported, skipped }, "Extension import complete");
  res.json({ imported, skipped });
});

// ─── Re-encrypt All Wallets ────────────────────────────────────────────────────
// Changes the encryption password for every wallet in the database.
// Decrypts each wallet with `oldPassword`, re-encrypts with `newPassword`.
router.post("/wallets/re-encrypt", async (req, res): Promise<void> => {
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string };
  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: "oldPassword and newPassword are required" });
    return;
  }
  if (oldPassword === newPassword) {
    res.status(400).json({ error: "New password must be different from the current password" });
    return;
  }

  const wallets = await db.select().from(walletsTable);
  let reencrypted = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const wallet of wallets) {
    try {
      const secret = decryptMnemonic(wallet.encryptedMnemonic, oldPassword);
      const newEncrypted = encryptMnemonic(secret, newPassword);
      await db.update(walletsTable).set({ encryptedMnemonic: newEncrypted }).where(eq(walletsTable.id, wallet.id));
      reencrypted++;
    } catch {
      failed++;
      errors.push(`${wallet.label} (${wallet.address.slice(0, 12)}…)`);
    }
  }

  res.json({ reencrypted, failed, errors });
});

export default router;
