import axios from "axios";
import { Secp256k1, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";

// ─── Meta Earth Chain Constants ────────────────────────────────────────────────
//
// All values confirmed from the official meta-earth-js-sdk source
// (github.com/openmetaearth/meta-earth-js-sdk, master branch, src/config/define.ts)
// and direct chain probing.
//
//   Chain ID      : me-chain          (mainnet) / mechain_400-1 (testnet)
//   App           : me-hub (med) — Cosmos SDK + Ethermint modules
//   Bech32 prefix : "me"   → addresses are me1...
//   Native denom  : umec   (micro-MEC), total supply ~1.76 quadrillion
//   HD coin type  : 118    (standard Cosmos — confirmed from SDK instanceME)
//   HD path       : m/44'/118'/0'/0/<index>
//
//   Mainnet Hub REST LCD : http://118.175.0.247:11317
//   Mainnet Hub RPC      : http://118.175.0.247:16657
//   Testnet Hub REST LCD : http://118.175.0.249:1317
//   Testnet Hub RPC      : http://118.175.0.249:26657
//
//   Gas limit    : 500000
//   Gas price    : 0.02 umec/gas
//   Min fee      : 10000 umec  (= 500000 × 0.02)
//
// Docs: https://docs.mec.me

const MEC_PREFIX = "me";
const MEC_COIN_TYPE = 118;

/**
 * Prefix stored in the plaintext before encryption to distinguish
 * a raw private key from a mnemonic phrase.
 */
export const PRIVATE_KEY_PREFIX = "pk:";

const MAINNET_ENDPOINTS = [
  {
    base: "http://118.175.0.247:11317",
    path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`,
    type: "cosmos" as const,
  },
];

const TESTNET_ENDPOINTS = [
  {
    base: "http://118.175.0.249:1317",
    path: (a: string) => `/cosmos/bank/v1beta1/balances/${a}`,
    type: "cosmos" as const,
  },
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

function parseCosmosBalance(data: unknown, address: string): BalanceResult {
  const balances: Array<{ denom: string; amount: string }> =
    (data as { balances?: Array<{ denom: string; amount: string }> })?.balances ?? [];
  // Official denom is "umec"; accept "ugc" as fallback for the legacy gc_20-1 node
  const mec = balances.find((b) => b.denom === "umec")
    ?? balances.find((b) => b.denom === "ugc")
    ?? balances[0];
  if (mec) {
    const amount = (parseFloat(mec.amount) / 100_000_000).toFixed(8);
    return { address, balance: amount, denom: "MEC" };
  }
  return { address, balance: "0.000000", denom: "MEC" };
}

// ─── Transaction History ────────────────────────────────────────────────────

export interface TxRecord {
  txHash: string;
  height: number;
  timestamp: string;
  direction: "sent" | "received";
  amount: string;      // in MEC, formatted
  amountRaw: string;   // in umec
  counterpart: string; // the other address
  memo: string;
  success: boolean;
}

function parseTxResponse(
  tx: Record<string, any>,
  txResp: Record<string, any>,
  walletAddress: string
): TxRecord | null {
  try {
    const msg = tx?.body?.messages?.[0];
    if (!msg || msg["@type"] !== "/cosmos.bank.v1beta1.MsgSend") return null;
    const from: string = msg.from_address ?? "";
    const to: string = msg.to_address ?? "";
    const amtArr: Array<{ denom: string; amount: string }> = msg.amount ?? [];
    const umecAmt = amtArr.find((a) => a.denom === "umec") ?? amtArr[0];
    if (!umecAmt) return null;

    const direction: "sent" | "received" = from === walletAddress ? "sent" : "received";
    const counterpart = direction === "sent" ? to : from;
    const amountMEC = (parseFloat(umecAmt.amount) / 100_000_000).toFixed(8);

    return {
      txHash: txResp.txhash ?? "",
      height: parseInt(txResp.height ?? "0", 10),
      timestamp: txResp.timestamp ?? "",
      direction,
      amount: amountMEC,
      amountRaw: umecAmt.amount,
      counterpart,
      memo: tx?.body?.memo ?? "",
      success: (txResp.code ?? 0) === 0,
    };
  } catch {
    return null;
  }
}

async function fetchTxPage(
  baseUrl: string,
  eventParam: string,
  limit: number
): Promise<{ txs: any[]; tx_responses: any[] }> {
  const url = `${baseUrl}/cosmos/tx/v1beta1/txs?events=${encodeURIComponent(eventParam)}&limit=${limit}&order_by=ORDER_BY_DESC`;
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { Accept: "application/json" },
    validateStatus: (s) => s === 200,
  });
  return {
    txs: res.data?.txs ?? [],
    tx_responses: res.data?.tx_responses ?? [],
  };
}

export async function queryTransactions(
  address: string,
  network: string,
  limit = 25
): Promise<TxRecord[]> {
  const baseUrl =
    network === "testnet" ? "http://118.175.0.249:1317" : "http://118.175.0.247:11317";

  let queryAddress = address;
  try {
    const { data } = fromBech32(address);
    queryAddress = toBech32(MEC_PREFIX, data);
  } catch { /* keep as-is */ }

  const results: TxRecord[] = [];
  const seen = new Set<string>();

  const addRecords = (txs: any[], txResps: any[]) => {
    for (let i = 0; i < txResps.length; i++) {
      const rec = parseTxResponse(txs[i], txResps[i], queryAddress);
      if (rec && !seen.has(rec.txHash)) {
        seen.add(rec.txHash);
        results.push(rec);
      }
    }
  };

  // Sent transactions
  try {
    const sent = await fetchTxPage(baseUrl, `transfer.sender='${queryAddress}'`, limit);
    addRecords(sent.txs, sent.tx_responses);
  } catch { /* ignore if endpoint fails */ }

  // Received transactions
  try {
    const recv = await fetchTxPage(baseUrl, `transfer.recipient='${queryAddress}'`, limit);
    addRecords(recv.txs, recv.tx_responses);
  } catch { /* ignore if endpoint fails */ }

  // Sort newest first
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return results.slice(0, limit);
}

export async function queryBalance(address: string, network: string): Promise<BalanceResult> {
  const endpoints = network === "testnet" ? TESTNET_ENDPOINTS : MAINNET_ENDPOINTS;
  const lastError: string[] = [];

  // The ME Hub REST LCD accepts me1... addresses directly — no conversion needed.
  // Normalize any gc1... legacy address back to me1... just in case.
  let queryAddress = address;
  try {
    const { data } = fromBech32(address);
    queryAddress = toBech32(MEC_PREFIX, data);
  } catch { /* use address as-is if parsing fails */ }

  for (const ep of endpoints) {
    try {
      const url = ep.base + ep.path(queryAddress);
      const res = await axios.get(url, {
        timeout: 8000,
        headers: { Accept: "application/json" },
        validateStatus: (s) => s === 200,
      });
      return parseCosmosBalance(res.data, address);
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
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
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
 * HD path: m/44'/118'/0'/0/<index>  (coin type 118, confirmed from official SDK)
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

// ─── Send / Transaction Constants ─────────────────────────────────────────────
const MEC_MAINNET_RPC = "http://118.175.0.247:16657";
const MEC_TESTNET_RPC = "http://118.175.0.249:26657";
const MEC_GAS_LIMIT = "500000";
const MEC_FEE_UMEC = "10000"; // 500000 gas × 0.02 umec/gas = 10000 umec

/** Normalize any MEC address to me1... form (accepts me1... or gc1...). */
export function normalizeMeAddress(addr: string): string {
  try {
    const { data } = fromBech32(addr);
    return toBech32(MEC_PREFIX, data);
  } catch {
    return addr;
  }
}

/**
 * @deprecated use normalizeMeAddress instead.
 * Kept for backward compatibility with existing routes.
 */
export function meToGcAddress(addr: string): string {
  return normalizeMeAddress(addr);
}

/** @deprecated */
export function gcToMeAddress(addr: string): string {
  return normalizeMeAddress(addr);
}

/** Derive the raw secp256k1 private key hex from a stored decrypted secret. */
export async function getPrivateKeyHex(secret: string, hdIndex = 0): Promise<string> {
  if (secret.startsWith(PRIVATE_KEY_PREFIX)) {
    return secret.slice(PRIVATE_KEY_PREFIX.length);
  }
  const hdPath = `m/44'/${MEC_COIN_TYPE}'/0'/0/${hdIndex}`;
  const mnemonicObj = new EnglishMnemonic(secret.trim());
  const seed = await Bip39.mnemonicToSeed(mnemonicObj);
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(hdPath));
  return Buffer.from(privkey).toString("hex");
}

/**
 * Derive the me1... address that corresponds to a given private key hex.
 * Used to verify that our derived key matches the stored address.
 */
export async function gcAddressFromPrivkeyHex(privkeyHex: string): Promise<string> {
  const privkey = Buffer.from(privkeyHex, "hex");
  const { pubkey } = await Secp256k1.makeKeypair(privkey);
  const compressed = Secp256k1.compressPubkey(pubkey);
  const rawAddr = rawSecp256k1PubkeyToRawAddress(compressed);
  return toBech32(MEC_PREFIX, rawAddr);
}

export interface SendResult {
  txHash: string;
  height: number;
}

/**
 * Sign and broadcast a MsgSend transaction on the Meta Earth me-chain.
 * @param privkeyHex  32-byte private key as lowercase hex
 * @param fromAddress me1... source address
 * @param toAddress   me1... destination address
 * @param amountMEC   amount in MEC (converted to umec internally)
 * @param network     "mainnet" | "testnet"
 * @param memo        optional memo string
 */
export async function sendMEC(params: {
  privkeyHex: string;
  fromAddress: string;
  toAddress: string;
  amountMEC: number;
  network?: string;
  memo?: string;
}): Promise<SendResult> {
  const { privkeyHex, fromAddress, toAddress, amountMEC, network = "mainnet", memo = "" } = params;

  const privkey = Buffer.from(privkeyHex, "hex");
  const wallet = await DirectSecp256k1Wallet.fromKey(privkey, MEC_PREFIX);

  const fromMe = normalizeMeAddress(fromAddress);
  const toMe = normalizeMeAddress(toAddress);

  const rpcUrl = network === "testnet" ? MEC_TESTNET_RPC : MEC_MAINNET_RPC;

  const client = await SigningStargateClient.connectWithSigner(rpcUrl, wallet, {
    prefix: MEC_PREFIX,
  });

  const amountUMec = Math.floor(amountMEC * 100_000_000).toString();
  const fee = {
    amount: [{ denom: "umec", amount: MEC_FEE_UMEC }],
    gas: MEC_GAS_LIMIT,
  };

  const result = await client.sendTokens(
    fromMe,
    toMe,
    [{ denom: "umec", amount: amountUMec }],
    fee,
    memo,
  );

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
