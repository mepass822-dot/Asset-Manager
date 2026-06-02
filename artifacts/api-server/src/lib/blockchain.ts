import axios from "axios";
import { Secp256k1, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

const MEC_PREFIX = "me";
const MEC_COIN_TYPE = 118;

/**
 * Prefix stored in the plaintext before encryption to distinguish
 * a raw private key from a mnemonic phrase.
 */
export const PRIVATE_KEY_PREFIX = "pk:";

// Ordered list of endpoints to try for each network.
// The chain native denom is "ugc" (micro-GC), displayed as MEC to users.
// Direct RPC REST (118.175.0.247:1317) is the most reliable source.
const MAINNET_ENDPOINTS = [
  { base: "http://118.175.0.247:1317",            path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`,       type: "cosmos" as const },
  { base: "https://me-explorer.me-network.me",    path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`,       type: "cosmos" as const },
  { base: "https://gateway.me-network.me",        path: (a: string) => `/api/cosmos/bank/v1beta1/balances/${a}`,   type: "cosmos" as const },
  { base: "https://nexus.me-network.me",          path: (a: string) => `/api/me/balances/${a}`,                    type: "custom" as const },
  { base: "https://gateway.me-network.me",        path: (a: string) => `/api/me/balances/${a}`,                    type: "custom" as const },
];

const TESTNET_ENDPOINTS = [
  { base: "https://nexus-beta.explorer-testnet.me", path: (a: string) => `/api/me/balances/${a}`,                  type: "custom" as const },
  { base: "https://explorer-beta.explorer-testnet.me", path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`, type: "cosmos" as const },
];

export interface BalanceResult {
  address: string;
  balance: string;
  denom: string;
  error?: string;
}

export interface DerivedAccount {
  address: string;
  hdIndex: number;
  hdPath: string;
}

function parseCosmosBalance(data: unknown, address: string): BalanceResult | null {
  const balances: Array<{ denom: string; amount: string }> =
    (data as { balances?: Array<{ denom: string; amount: string }> })?.balances ?? [];
  // Chain native denom is "ugc"; also accept "umec" as fallback
  const mec = balances.find((b) => b.denom === "ugc")
    ?? balances.find((b) => b.denom === "umec")
    ?? balances[0];
  if (mec) {
    const amount = (parseFloat(mec.amount) / 1_000_000).toFixed(6);
    return { address, balance: amount, denom: "MEC" };
  }
  return { address, balance: "0.000000", denom: "MEC" };
}

function parseCustomBalance(data: unknown, address: string): BalanceResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // {balance: "123456", denom: "umec"} or {amount: "123456"}
  const raw = d["balance"] ?? d["amount"] ?? d["umec"];
  if (typeof raw === "string" || typeof raw === "number") {
    const amount = (parseFloat(String(raw)) / 1_000_000).toFixed(6);
    return { address, balance: amount, denom: "MEC" };
  }

  // {balances: [{denom, amount}]}
  if (Array.isArray(d["balances"])) {
    return parseCosmosBalance(data, address);
  }

  // {data: {balance: ...}}
  if (d["data"] && typeof d["data"] === "object") {
    return parseCustomBalance(d["data"], address);
  }

  return null;
}

export async function queryBalance(address: string, network: string): Promise<BalanceResult> {
  const endpoints = network === "testnet" ? TESTNET_ENDPOINTS : MAINNET_ENDPOINTS;
  const lastError: string[] = [];

  // The on-chain REST API only understands gc1... addresses.
  // Convert any me1... address to gc1... for querying.
  let gcAddress = address;
  try {
    gcAddress = meToGcAddress(address);
  } catch { /* if conversion fails, try original address */ }

  for (const ep of endpoints) {
    try {
      // Use gc1 address for the direct RPC REST endpoint; original for custom APIs
      const queryAddr = ep.base.includes("118.175.0.247") ? gcAddress : address;
      const url = ep.base + ep.path(queryAddr);
      const res = await axios.get(url, {
        timeout: 8000,
        headers: { Accept: "application/json" },
        validateStatus: (s) => s === 200,
      });

      let result: BalanceResult | null = null;
      if (ep.type === "cosmos") {
        result = parseCosmosBalance(res.data, address);
      } else {
        result = parseCustomBalance(res.data, address) ?? parseCosmosBalance(res.data, address);
      }

      if (result) return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.push(`${ep.base}: ${msg}`);
    }
  }

  return { address, balance: "unavailable", denom: "MEC", error: lastError[0] };
}

/**
 * Derive the MEC bech32 address from a raw secp256k1 private key.
 * Accepts hex (with or without 0x prefix) or base64.
 */
export async function deriveAddressFromPrivateKey(privateKey: string): Promise<{ address: string; privkeyHex: string }> {
  let hex = privateKey.trim();
  // Strip 0x prefix
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  // If it looks like base64 (not all hex chars), decode it
  if (/[^0-9a-fA-F]/.test(hex)) {
    const buf = Buffer.from(hex, "base64");
    hex = buf.toString("hex");
  }
  if (hex.length !== 64) throw new Error(`Private key must be 32 bytes (64 hex chars), got ${hex.length}`);
  const privkey = Buffer.from(hex, "hex");
  const { pubkey } = await Secp256k1.makeKeypair(privkey);
  const compressed = Secp256k1.compressPubkey(pubkey);
  const rawAddr = rawSecp256k1PubkeyToRawAddress(compressed);
  const address = toBech32(MEC_PREFIX, rawAddr);
  return { address, privkeyHex: hex };
}

/**
 * Derive the MEC bech32 address from a BIP39 mnemonic at a given account index.
 * HD path: m/44'/{coinType}'/0'/0/{index}
 */
export async function deriveMECAddressAsync(mnemonic: string, index = 0): Promise<DerivedAccount> {
  const hdPath = `m/44'/${MEC_COIN_TYPE}'/0'/0/${index}`;
  const mnemonicObj = new EnglishMnemonic(mnemonic.trim());
  const seed = await Bip39.mnemonicToSeed(mnemonicObj);
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(hdPath));
  const { pubkey } = await Secp256k1.makeKeypair(privkey);
  const compressed = Secp256k1.compressPubkey(pubkey);
  const rawAddr = rawSecp256k1PubkeyToRawAddress(compressed);
  const address = toBech32(MEC_PREFIX, rawAddr);
  return { address, hdIndex: index, hdPath };
}

// ─── Chain constants ──────────────────────────────────────────────────────────
// The Meta Earth chain uses "gc" bech32 prefix internally.
// User-facing addresses use "me" prefix — same bytes, different HRP.
const MEC_CHAIN_PREFIX = "gc";
const MEC_RPC = "http://118.175.0.247:26657";
const MEC_GAS_LIMIT = "5000000";
const MEC_FEE_UGC = "1000000"; // 1 GC fee (native denom on gc_20-1 is ugc)

/** Convert any MEC address (me1... or gc1...) to the on-chain gc1... form. */
export function meToGcAddress(addr: string): string {
  const { data } = fromBech32(addr);
  return toBech32(MEC_CHAIN_PREFIX, data);
}

/** Convert any MEC address (me1... or gc1...) to the user-facing me1... form. */
export function gcToMeAddress(addr: string): string {
  const { data } = fromBech32(addr);
  return toBech32(MEC_PREFIX, data);
}

/** Derive the raw secp256k1 private key hex from a stored decrypted secret. */
export async function getPrivateKeyHex(secret: string, hdIndex = 0): Promise<string> {
  if (secret.startsWith(PRIVATE_KEY_PREFIX)) {
    return secret.slice(PRIVATE_KEY_PREFIX.length);
  }
  // Derive from mnemonic at the given HD index
  const hdPath = `m/44'/${MEC_COIN_TYPE}'/0'/0/${hdIndex}`;
  const mnemonicObj = new EnglishMnemonic(secret.trim());
  const seed = await Bip39.mnemonicToSeed(mnemonicObj);
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(hdPath));
  return Buffer.from(privkey).toString("hex");
}

/**
 * Derive the on-chain gc1... address that corresponds to a given private key hex.
 * This lets us verify that our derived key actually matches the stored address.
 */
export async function gcAddressFromPrivkeyHex(privkeyHex: string): Promise<string> {
  const privkey = Buffer.from(privkeyHex, "hex");
  const { pubkey } = await Secp256k1.makeKeypair(privkey);
  const compressed = Secp256k1.compressPubkey(pubkey);
  const rawAddr = rawSecp256k1PubkeyToRawAddress(compressed);
  return toBech32(MEC_CHAIN_PREFIX, rawAddr);
}

export interface SendResult {
  txHash: string;
  height: number;
}

/**
 * Sign and broadcast a MsgSend transaction on the Meta Earth (gc_20-1) chain.
 * @param privkeyHex  32-byte private key as lowercase hex
 * @param fromAddress me1... source address
 * @param toAddress   me1... destination address
 * @param amountMEC   amount in MEC (not umec)
 * @param memo        optional memo string
 */
export async function sendMEC(params: {
  privkeyHex: string;
  fromAddress: string;
  toAddress: string;
  amountMEC: number;
  memo?: string;
}): Promise<SendResult> {
  const { privkeyHex, fromAddress, toAddress, amountMEC, memo = "" } = params;

  const privkey = Buffer.from(privkeyHex, "hex");
  const wallet = await DirectSecp256k1Wallet.fromKey(privkey, MEC_CHAIN_PREFIX);

  const fromGc = meToGcAddress(fromAddress);
  const toGc = meToGcAddress(toAddress);

  const client = await SigningStargateClient.connectWithSigner(MEC_RPC, wallet, {
    prefix: MEC_CHAIN_PREFIX,
  });

  const amountUGc = Math.floor(amountMEC * 1_000_000).toString();
  const fee = {
    amount: [{ denom: "ugc", amount: MEC_FEE_UGC }],
    gas: MEC_GAS_LIMIT,
  };

  const result = await client.sendTokens(fromGc, toGc, [{ denom: "ugc", amount: amountUGc }], fee, memo);

  if (result.code !== 0) {
    throw new Error(`Tx failed (code ${result.code}): ${result.rawLog ?? "unknown error"}`);
  }

  return { txHash: result.transactionHash, height: result.height };
}

export function deriveMECAddress(mnemonic: string): string {
  const hash = Buffer.from(mnemonic.trim().split(" ").slice(0, 4).join(""))
    .toString("hex")
    .slice(0, 39);
  return `me1${hash}`;
}

export async function deriveMultipleAccounts(
  mnemonic: string,
  count: number
): Promise<DerivedAccount[]> {
  const results: DerivedAccount[] = [];
  for (let i = 0; i < count; i++) {
    results.push(await deriveMECAddressAsync(mnemonic, i));
  }
  return results;
}
