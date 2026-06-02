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

export async function agentDecide(
  walletSummaries: Array<{ label: string; address: string; balance: string }>,
  rules: Array<{ name: string; ruleType: string; conditionJson: string | null; actionJson: string | null }>,
  apiKey: string
): Promise<Array<{ walletLabel: string; action: string; reason: string; amount?: string; destination?: string }>> {
  const systemPrompt = `You are an autonomous Meta Earth (MEC) wallet management agent.
You manage multiple cryptocurrency wallets on the Meta Earth blockchain.
Your job is to evaluate wallet balances and configured rules, then decide what actions to take.

Rules you follow:
- Only execute actions that match configured automation rules
- Never exceed configured withdrawal amounts
- Always provide clear reasoning for each decision
- Return your decisions as a JSON array

Respond ONLY with a valid JSON array of actions, no other text. Example:
[{"walletLabel": "Main Wallet", "action": "withdraw", "reason": "Balance exceeds threshold per rule", "amount": "10.5", "destination": "me1abc123..."}]
If no action is needed for any wallet, return: []`;

  const userMessage = `Current wallet states:
${JSON.stringify(walletSummaries, null, 2)}

Active automation rules:
${JSON.stringify(rules, null, 2)}

Evaluate each wallet against the rules and return your decisions as JSON.`;

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
