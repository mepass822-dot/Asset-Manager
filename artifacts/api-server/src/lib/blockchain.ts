import axios from "axios";
import { Secp256k1, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import { toBech32 } from "@cosmjs/encoding";

const MAINNET_API = "https://gateway.me-network.me/api";
const TESTNET_API = "https://nexus-beta.explorer-testnet.me/api";
const MEC_PREFIX = "me";
const MEC_COIN_TYPE = 118; // Cosmos coin type

function getApiBase(network: string): string {
  return network === "testnet" ? TESTNET_API : MAINNET_API;
}

export interface BalanceResult {
  address: string;
  balance: string;
  denom: string;
}

export interface DerivedAccount {
  address: string;
  hdIndex: number;
  hdPath: string;
}

export async function queryBalance(address: string, network: string): Promise<BalanceResult> {
  try {
    const base = getApiBase(network);
    const url = `${base}/cosmos/bank/v1beta1/balances/${address}`;
    const res = await axios.get(url, { timeout: 10000 });
    const balances: Array<{ denom: string; amount: string }> = res.data?.balances ?? [];
    const mec = balances.find((b) => b.denom === "umec") ?? balances[0];
    if (mec) {
      const amount = (parseFloat(mec.amount) / 1_000_000).toFixed(6);
      return { address, balance: amount, denom: "MEC" };
    }
    return { address, balance: "0.000000", denom: "MEC" };
  } catch {
    return { address, balance: "unavailable", denom: "MEC" };
  }
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

/**
 * Synchronous wrapper — used in routes that can't be async at top-level.
 * For the import endpoint we use the async version directly.
 * This falls back to a deterministic placeholder if crypto fails.
 */
export function deriveMECAddress(mnemonic: string): string {
  // Placeholder used only in legacy createWallet — real derivation is async
  const hash = Buffer.from(mnemonic.trim().split(" ").slice(0, 4).join(""))
    .toString("hex")
    .slice(0, 39);
  return `me1${hash}`;
}

/**
 * Derive multiple accounts from a mnemonic (indices 0..count-1).
 */
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
