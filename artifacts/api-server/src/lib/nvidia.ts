import axios from "axios";
import { logger } from "./logger";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = "meta/llama-3.1-70b-instruct";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatWithNvidia(
  messages: ChatMessage[],
  apiKey: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured. Please set it in environment secrets.");
  }

  const res = await axios.post(
    `${NVIDIA_BASE_URL}/chat/completions`,
    {
      model: MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const reply = res.data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("Empty response from NVIDIA NIM");
  return reply;
}

export interface AgentDecision {
  walletLabel: string;
  action: string;
  reason: string;
  amount?: string;
  toAddress?: string;
}

export async function agentDecide(
  walletSummaries: Array<{
    label: string;
    address: string;
    balance: string;
    stakingRewards?: string;
    verified?: boolean;
  }>,
  rules: Array<{
    name: string;
    ruleType: string;
    conditionJson: string | null;
    actionJson: string | null;
  }>,
  apiKey: string,
  context?: {
    isDividendWindow: boolean;
    dayOfMonth: number;
    masterAddress: string;
    autoSweepEnabled: boolean;
    minSweepMEC: number;
  }
): Promise<AgentDecision[]> {
  const now = new Date();
  const dayOfMonth = context?.dayOfMonth ?? now.getUTCDate();
  const isDividendWindow = context?.isDividendWindow ?? (dayOfMonth >= 1 && dayOfMonth <= 7);
  const masterAddr = context?.masterAddress ?? "me1h4fc80gz38ms8tejlj37rxmf7uh6xe25fk0tfx";
  const minSweep = context?.minSweepMEC ?? 0.001;

  const systemPrompt = `You are an autonomous Meta Earth (MEC) blockchain wallet management agent. Your PRIMARY mission is to sweep all spendable MEC balances to the master address as efficiently as possible.

## Chain Facts
- Native denom: umec (micro-MEC). 1 MEC = 100,000,000 umec.
- Addresses use bech32 prefix "me" → me1...
- HD path: m/44'/118'/0'/0/<index> (coin type 118, Cosmos standard)
- Mainnet REST: http://118.175.0.247:11317
- Gas limit: 500,000 | Gas price: 0.02 umec/gas | Network fee: 10,000 umec (= 0.0001 MEC)
- Chain: me-chain (Cosmos SDK + Ethermint modules, app: me-hub med v2.0.13+)

## Wallet Classification
- VERIFIED wallets: confirmed on-chain accounts. ELIGIBLE for all operations.
- UNVERIFIED wallets: never appeared on-chain. MONITOR ONLY — ZERO transfers. They may become active if dividends arrive.
- NEVER execute transfers on unverified wallets. This is an absolute rule.

## Monthly Dividend Behavior
Meta Earth distributes monthly dividends randomly in days 1–7 of each calendar month.
- Each wallet may receive its dividend on a different day within that window.
- During dividend window: IMMEDIATELY sweep any balance above threshold — dividend has likely arrived.

## Staking / Block Rewards
- Block rewards accumulate in the Cosmos distribution module as pending rewards.
- Claim staking rewards when they exceed the minimum threshold.
- After claiming, the received tokens join the spendable balance and MUST be swept.

## Master Sweep Address
ALL swept funds go ONLY to: ${masterAddr}
This is the one and only designated secure destination for automated withdrawals.
NEVER send to any other address unless explicitly specified by a custom rule.

## Sweep Calculation
sweepAmount = totalBalance − 0.0001 MEC (network fee)
NEVER attempt a sweep if balance ≤ 0.0001 MEC.

## Decision Rules — FOLLOW IN ORDER
1. VERIFIED wallets ONLY for any transfer action.
2. If balance > ${minSweep} MEC → ALWAYS recommend sweep_balance (or sweep_dividend during dividend window). Do not hold.
3. If staking rewards > ${minSweep} MEC → recommend claim_staking_rewards.
4. After claiming rewards → recommend sweep_balance to master.
5. Custom rules override defaults when applicable.
6. Use monitor/hold ONLY when balance = 0 or balance ≤ network fee (0.0001 MEC).
7. UNVERIFIED wallets → ALWAYS use monitor action. Never sweep.

## Current Context
- Today is day ${dayOfMonth} of the month.
- Dividend window active: ${isDividendWindow ? "YES — SWEEP ALL balances immediately!" : "NO — but still sweep any balance above threshold."}
- Auto-sweep enabled: ${context?.autoSweepEnabled ?? false}
- Minimum sweep threshold: ${minSweep} MEC

## Response Format
Respond ONLY with a valid JSON array. No markdown, no explanation. Example:
[
  {
    "walletLabel": "Wallet Alpha",
    "action": "sweep_balance",
    "reason": "Verified wallet has 2.5 MEC spendable balance — sweeping full amount to master address.",
    "amount": "2.4999",
    "toAddress": "${masterAddr}"
  }
]

Valid actions: sweep_dividend | sweep_balance | claim_staking_rewards | monitor | hold | review
Return [] only if ALL verified wallets have zero or sub-threshold balance.`;

  const verifiedWallets = walletSummaries.filter((w) => w.verified !== false);
  const unverifiedWallets = walletSummaries.filter((w) => w.verified === false);

  const userMessage = `## Verified Wallets (eligible for all operations — SWEEP if balance > ${minSweep} MEC)
${JSON.stringify(verifiedWallets, null, 2)}

${unverifiedWallets.length > 0 ? `## Unverified Wallets (MONITOR ONLY — absolutely NO transfers)
${JSON.stringify(unverifiedWallets.map((w) => ({ label: w.label, address: w.address, status: "unverified - monitor only" })), null, 2)}` : "## Unverified Wallets\nNone."}

## Active Automation Rules
${rules.length > 0 ? JSON.stringify(rules, null, 2) : "No custom rules configured."}

## Your Task
Evaluate every VERIFIED wallet. For each one with balance > ${minSweep} MEC, output a sweep action targeting ${masterAddr}. Be decisive — if there is a balance, sweep it. Return your decisions as a JSON array.`;

  const reply = await chatWithNvidia(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    apiKey
  );

  try {
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    logger.warn({ reply }, "Could not parse NVIDIA agent response as JSON");
    return [];
  }
}
