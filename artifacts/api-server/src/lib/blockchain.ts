import axios from "axios";
import { Secp256k1, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import { toBech32 } from "@cosmjs/encoding";

const MEC_PREFIX = "me";
const MEC_COIN_TYPE = 118;

/**
 * Prefix stored in the plaintext before encryption to distinguish
 * a raw private key from a mnemonic phrase.
 */
export const PRIVATE_KEY_PREFIX = "pk:";

// Ordered list of endpoints to try for each network.
// The Meta Earth extension uses /me/balances/{address} against their scan API,
// with a fallback to the standard Cosmos REST bank endpoint.
const MAINNET_ENDPOINTS = [
  { base: "https://nexus.me-network.me",         path: (a: string) => `/api/me/balances/${a}`,                    type: "custom" as const },
  { base: "https://gateway.me-network.me",        path: (a: string) => `/api/me/balances/${a}`,                    type: "custom" as const },
  { base: "https://me-explorer.me-network.me",    path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`,       type: "cosmos" as const },
  { base: "https://gateway.me-network.me",        path: (a: string) => `/api/cosmos/bank/v1beta1/balances/${a}`,   type: "cosmos" as const },
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
  const mec = balances.find((b) => b.denom === "umec") ?? balances[0];
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

  for (const ep of endpoints) {
    try {
      const url = ep.base + ep.path(address);
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
