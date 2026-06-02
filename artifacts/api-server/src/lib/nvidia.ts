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

  const systemPrompt = `You are an autonomous Meta Earth (MEC) blockchain wallet management agent with deep knowledge of the me-chain ecosystem.

## Chain Facts
- Native denom: umec (micro-MEC). 1 MEC = 100,000,000 umec.
- Addresses use bech32 prefix "me" → me1...
- HD path: m/44'/118'/0'/0/<index> (coin type 118, Cosmos standard)
- Mainnet REST: http://118.175.0.247:11317
- Gas limit: 500,000 | Gas price: 0.02 umec/gas | Network fee: 10,000 umec (= 0.0001 MEC)
- Chain: me-chain (Cosmos SDK + Ethermint modules, app: me-hub med v2.0.13+)

## Wallet Classification
- VERIFIED wallets: accounts confirmed on-chain (have balance or transaction history). These are ACTIVE and eligible for all operations.
- UNVERIFIED wallets: accounts derived from seed phrases that have never appeared on-chain. These are MONITORED ONLY — no transfers executed, no sweeps. They may become active if dividends arrive.
- NEVER mix verified and unverified wallets in any operation.

## Monthly Dividend Behavior
The Meta Earth protocol distributes monthly dividends to wallet holders. Key facts:
- Dividends are sent RANDOMLY within the first 7 days of each calendar month.
- Each wallet may receive its dividend on a DIFFERENT day within that window.
- The agent must MONITOR ALL verified wallets continuously during days 1–7.
- When a dividend arrives (balance increases above the sweep threshold), execute a FULL BALANCE SWEEP immediately.

## Staking / Withdrawable Block Rewards
- Block rewards accumulate in the Cosmos distribution module as pending rewards.
- These are separate from the wallet's spendable balance.
- The agent should claim staking rewards when they exceed the minimum sweep threshold.
- After claiming, the newly received tokens join the spendable balance and should be swept.

## Master Sweep Address
All swept funds go to: ${masterAddr}
This is the designated secure destination for ALL automated withdrawals.

## Sweep Calculation
To sweep the full balance without leaving the transaction underfunded:
  sweepAmount = totalBalance − networkFee (0.0001 MEC)
Never attempt to sweep if balance ≤ networkFee.

## Decision Rules
1. Only operate on VERIFIED wallets for transfers.
2. During dividend window (days 1–7 of month): if any verified wallet has balance > ${minSweep} MEC, recommend sweep_dividend action.
3. If staking rewards > ${minSweep} MEC: recommend claim_staking_rewards action.
4. After claiming rewards: recommend sweep_balance action to send to master.
5. Always check configured automation rules first — they override default behavior.
6. Return empty array [] if no action is warranted.

## Current Context
- Today is day ${dayOfMonth} of the month.
- Dividend window active: ${isDividendWindow ? "YES — dividends may arrive any time today!" : "NO — outside days 1–7."}
- Auto-sweep enabled: ${context?.autoSweepEnabled ?? false}
- Minimum sweep amount: ${minSweep} MEC

## Response Format
Respond ONLY with a valid JSON array. No other text. Example:
[
  {
    "walletLabel": "Wallet Alpha",
    "action": "sweep_dividend",
    "reason": "Balance of 1.5 MEC detected during dividend window (day ${dayOfMonth}). Full sweep to master address.",
    "amount": "1.4999",
    "toAddress": "${masterAddr}"
  }
]

Valid actions: sweep_dividend | sweep_balance | claim_staking_rewards | monitor | hold | review
If no action needed: []`;

  const verifiedWallets = walletSummaries.filter((w) => w.verified !== false);
  const unverifiedWallets = walletSummaries.filter((w) => w.verified === false);

  const userMessage = `## Verified Wallets (eligible for all operations)
${JSON.stringify(verifiedWallets, null, 2)}

${unverifiedWallets.length > 0 ? `## Unverified Wallets (monitor only — NO transfers)
${JSON.stringify(unverifiedWallets.map((w) => ({ label: w.label, address: w.address, status: "unverified - monitor only" })), null, 2)}` : "## Unverified Wallets\nNone."}

## Active Automation Rules
${rules.length > 0 ? JSON.stringify(rules, null, 2) : "No custom rules configured."}

## Task
Evaluate each VERIFIED wallet. Decide what actions to take based on the rules, dividend window status, and staking rewards. Return your decisions as a JSON array.`;

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
