import { getDatabase, type Reference } from "firebase-admin/database";
import "./firebase-admin";

export const rtdb = getDatabase();

export const walletsRef   = () => rtdb.ref("wallets");
export const rulesRef     = () => rtdb.ref("rules");
export const logsRef      = () => rtdb.ref("agent_logs");
export const whitelistRef = () => rtdb.ref("whitelist");
export const sweepRef     = () => rtdb.ref("sweep_config");

export type WithId<T> = T & { id: string };

const RTDB_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms = RTDB_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Firebase RTDB operation timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function getAllItems<T>(ref: Reference): Promise<WithId<T>[]> {
  const snap = await withTimeout(ref.get());
  if (!snap.exists()) return [];
  const val = snap.val() as Record<string, T>;
  return Object.entries(val).map(([id, data]) => ({ ...(data as object), id } as WithId<T>));
}

export async function pushItem<T extends object>(ref: Reference, data: T): Promise<WithId<T>> {
  const newRef = ref.push();
  await withTimeout(newRef.set(data));
  return { ...data, id: newRef.key! };
}

export async function getItem<T>(ref: Reference, id: string): Promise<WithId<T> | null> {
  const snap = await withTimeout(ref.child(id).get());
  if (!snap.exists()) return null;
  return { ...(snap.val() as T), id };
}

export async function updateItem(ref: Reference, id: string, updates: object): Promise<void> {
  await withTimeout(ref.child(id).update(updates));
}

export async function deleteItem(ref: Reference, id: string): Promise<void> {
  await withTimeout(ref.child(id).remove());
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
  const snap = await withTimeout(sweepRef().get());
  if (!snap.exists()) {
    await withTimeout(sweepRef().set(SWEEP_DEFAULTS));
    return SWEEP_DEFAULTS;
  }
  return snap.val() as SweepConfig;
}

export async function setSweepConfig(updates: Partial<SweepConfig>): Promise<SweepConfig> {
  const current = await getSweepConfig();
  const updated: SweepConfig = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await withTimeout(sweepRef().set(updated));
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
  const snap = await withTimeout(rtdb.ref("settings/nvidiaApiKey").get());
  return snap.exists() ? (snap.val() as string) : null;
}

export async function setNvidiaKeyInDB(key: string): Promise<void> {
  await withTimeout(rtdb.ref("settings/nvidiaApiKey").set(key));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

export async function insertLog(log: Omit<AgentLog, "createdAt">): Promise<WithId<AgentLog>> {
  return pushItem<AgentLog>(logsRef(), { ...log, createdAt: now() });
}
