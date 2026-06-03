import { getDatabase, type Reference } from "firebase-admin/database";
import "./firebase-admin";

export const rtdb = getDatabase();

export const walletsRef   = () => rtdb.ref("wallets");
export const rulesRef     = () => rtdb.ref("rules");
export const logsRef      = () => rtdb.ref("agent_logs");
export const whitelistRef = () => rtdb.ref("whitelist");
export const sweepRef     = () => rtdb.ref("sweep_config");

export type WithId<T> = T & { id: string };

// ── Timeout + retry config ───────────────────────────────────────────────────

const RTDB_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

function withTimeout<T>(promise: Promise<T>, ms = RTDB_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Firebase RTDB timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("socket") ||
    msg.includes("unavailable") ||
    msg.includes("service_unavailable")
  );
}

async function withRetry<T>(fn: () => Promise<T>, label = "rtdb"): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_RETRIES) break;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[firebase-db] ${label} failed (attempt ${attempt + 1}), retrying in ${delay}ms…`, (err as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── CRUD helpers ─────────────────────────────────────────────────────────────

export async function getAllItems<T>(ref: Reference): Promise<WithId<T>[]> {
  const snap = await withRetry(() => withTimeout(ref.get()), `getAllItems(${ref.key})`);
  if (!snap.exists()) return [];
  const val = snap.val() as Record<string, T>;
  return Object.entries(val).map(([id, data]) => ({ ...(data as object), id } as WithId<T>));
}

export async function pushItem<T extends object>(ref: Reference, data: T): Promise<WithId<T>> {
  const newRef = ref.push();
  await withRetry(() => withTimeout(newRef.set(data)), `pushItem(${ref.key})`);
  return { ...data, id: newRef.key! };
}

export async function getItem<T>(ref: Reference, id: string): Promise<WithId<T> | null> {
  const snap = await withRetry(() => withTimeout(ref.child(id).get()), `getItem(${ref.key}/${id})`);
  if (!snap.exists()) return null;
  return { ...(snap.val() as T), id };
}

export async function updateItem(ref: Reference, id: string, updates: object): Promise<void> {
  await withRetry(() => withTimeout(ref.child(id).update(updates)), `updateItem(${ref.key}/${id})`);
}

export async function deleteItem(ref: Reference, id: string): Promise<void> {
  await withRetry(() => withTimeout(ref.child(id).remove()), `deleteItem(${ref.key}/${id})`);
}

// ── Sweep config (single document) ──────────────────────────────────────────

export interface SweepConfig {
  masterAddress: string;
  enabled: boolean;
  autoClaimStaking: boolean;
  dividendWindowDays: number;
  minSweepAmountMec: string;
  updatedAt: string;
}

const SWEEP_DEFAULTS: SweepConfig = {
  masterAddress: "me1h4fc80gz38ms8tejlj37rxmf7uh6xe25fk0tfx",
  enabled: false,
  autoClaimStaking: false,
  dividendWindowDays: 7,
  minSweepAmountMec: "0.001",
  updatedAt: new Date().toISOString(),
};

export async function getSweepConfig(): Promise<SweepConfig> {
  const snap = await withRetry(() => withTimeout(sweepRef().get()), "getSweepConfig");
  if (!snap.exists()) {
    await withRetry(() => withTimeout(sweepRef().set(SWEEP_DEFAULTS)), "setSweepDefaults");
    return SWEEP_DEFAULTS;
  }
  return snap.val() as SweepConfig;
}

export async function setSweepConfig(updates: Partial<SweepConfig>): Promise<SweepConfig> {
  const current = await getSweepConfig();
  const updated: SweepConfig = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await withRetry(() => withTimeout(sweepRef().set(updated)), "setSweepConfig");
  return updated;
}

// ── Wallet type ──────────────────────────────────────────────────────────────

export interface Wallet {
  label: string;
  address: string;
  encryptedMnemonic: string;
  network: string;
  hdIndex: number;
  verified: boolean;
  monitored: boolean;
  importSource: string;
  createdAt: string;
  updatedAt: string;
}

// ── Rule type ────────────────────────────────────────────────────────────────

export interface Rule {
  name: string;
  ruleType: string;
  enabled: boolean;
  conditionJson: string | null;
  actionJson: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Agent log type ───────────────────────────────────────────────────────────

export interface AgentLog {
  walletId: string | null;
  action: string;
  status: string;
  txHash: string | null;
  amount: string | null;
  message: string;
  createdAt: string;
}

// ── Whitelist type ───────────────────────────────────────────────────────────

export interface WhitelistEntry {
  address: string;
  label: string | null;
  createdAt: string;
}

// ── App settings (NVIDIA key, etc.) ──────────────────────────────────────────

export async function getNvidiaKeyFromDB(): Promise<string | null> {
  const snap = await withRetry(() => withTimeout(rtdb.ref("settings/nvidiaApiKey").get()), "getNvidiaKey");
  return snap.exists() ? (snap.val() as string) : null;
}

export async function setNvidiaKeyInDB(key: string): Promise<void> {
  await withRetry(() => withTimeout(rtdb.ref("settings/nvidiaApiKey").set(key)), "setNvidiaKey");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

export async function insertLog(log: Omit<AgentLog, "createdAt">): Promise<WithId<AgentLog>> {
  return pushItem<AgentLog>(logsRef(), { ...log, createdAt: now() });
}
