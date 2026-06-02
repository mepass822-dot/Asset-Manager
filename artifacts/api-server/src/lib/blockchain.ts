import axios from "axios";

const MAINNET_API = "https://gateway.me-network.me/api";
const TESTNET_API = "https://nexus-beta.explorer-testnet.me/api";

function getApiBase(network: string): string {
  return network === "testnet" ? TESTNET_API : MAINNET_API;
}

export interface BalanceResult {
  address: string;
  balance: string;
  denom: string;
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

export function deriveMECAddress(mnemonic: string): string {
  // Return a placeholder — real derivation would use @cosmjs/crypto
  // We derive from mnemonic hash for demo purposes
  const hash = Buffer.from(mnemonic.split(" ").slice(0, 3).join("")).toString("hex").slice(0, 39);
  return `me1${hash}`;
}
