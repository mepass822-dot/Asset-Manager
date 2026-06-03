import { getDatabase, type Reference } from "firebase-admin/database";
import "./firebase-admin";

export const rtdb = getDatabase();

export const walletsRef   = () => rtdb.ref("wallets");
export const rulesRef     = () => rtdb.ref("rules");
export const logsRef      = () => rtdb.ref("agent_logs");
export const whitelistRef = () => rtdb.ref("whitelist");
export const sweepRef     = () => rtdb.ref("sweep_config");

export type WithId<T> = T & { id: string };

// ── Config ───────────────────────────────────────────────────────────────────

const RTDB_TIMEOUT_MS    = 8_000;
const MAX_RETRIES        = 2;
const RETRY_BASE_DELAY   = 500;     // ms — doubles each retry: 500 → 1000
const CB_FAILURE_THRESH  = 3;       // consecutive failures before opening circuit
const CB_RESET_MS        = 30_000;  // how long to stay OPEN before testing again

// ── Circuit breaker ──────────────────────────────────────────────────────────

type CBState = "CLOSED" | "OPEN" | "HALF_OPEN";

let cbState: CBState = "CLOSED";
let cbFailures = 0;
let cbOpenedAt: number | null = null;

export function getCircuitBreakerStatus() {
  return {
    state: cbState,
    consecutiveFailures: cbFailures,
    openedAt: cbOpenedAt ? new Date(cbOpenedAt).toISOString() : null,
    resetsAt: cbOpenedAt ? new Date(cbOpenedAt + CB_RESET_MS).toISOString() : null,
  };
}

function cbOnSuccess() {
  if (cbState !== "CLOSED") {
    console.info("[firebase-db] Circuit breaker CLOSED — Firebase is healthy again");
  }
  cbState = "CLOSED";
  cbFailures = 0;
  cbOpenedAt = null;
}

function cbOnFailure() {
  cbFailures++;
  if (cbState === "HALF_OPEN" || cbFailures >= CB_FAILURE_THRESH) {
    cbState = "OPEN";
    cbOpenedAt = Date.now();
    console.warn(`[firebase-db] Circuit breaker OPEN after ${cbFailures} failures — pausing for ${CB_RESET_MS / 1000}s`);
  }
}

function cbCheck(): void {
  if (cbState === "CLOSED") return;
  if (cbState === "OPEN") {
    const elapsed = Date.now() - (cbOpenedAt ?? 0);
    if (elapsed >= CB_RESET_MS) {
      cbState = "HALF_OPEN";
      console.info("[firebase-db] Circuit breaker HALF_OPEN — sending probe request");
    } else {
      const remaining = Math.ceil((CB_RESET_MS - elapsed) / 1000);
      throw new Error(`Firebase RTDB circuit open — retry in ${remaining}s`);
    }
  }
  // HALF_OPEN: allow the request through (result updates state)
}

// ── Timeout + retry ──────────────────────────────────────────────────────────

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

async function rtdbOp<T>(fn: () => Promise<T>, label = "rtdb"): Promise<T> {
  cbCheck(); // throws immediately if circuit is OPEN

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(fn());
      cbOnSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      // Don't retry if circuit opened mid-flight or non-transient error
      if (!isTransient(err) || attempt === MAX_RETRIES) break;
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.warn(`[firebase-db] ${label} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms…`, (err as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  cbOnFailure();
  throw lastErr;
}

// ── CRUD helpers ─────────────────────────────────────────────────────────────

export async function getAllItems<T>(ref: Reference): Promise<WithId<T>[]> {
  const snap = await rtdbOp(() => ref.get(), `getAllItems(${ref.key})`);
  if (!snap.exists()) return [];
  const val = snap.val() as Record<string, T>;
  return Object.entries(val).map(([id, data]) => ({ ...(data as object), id } as WithId<T>));
}

export async function pushItem<T extends object>(ref: Reference, data: T): Promise<WithId<T>> {
  const newRef = ref.push();
  await rtdbOp(() => newRef.set(data), `pushItem(${ref.key})`);
  return { ...data, id: newRef.key! };
}

export async function getItem<T>(ref: Reference, id: string): Promise<WithId<T> | null> {
  const snap = await rtdbOp(() => ref.child(id).get(), `getItem(${ref.key}/${id})`);
  if (!snap.exists()) return null;
  return { ...(snap.val() as T), id };
}

export async function updateItem(ref: Reference, id: string, updates: object): Promise<void> {
  await rtdbOp(() => ref.child(id).update(updates), `updateItem(${ref.key}/${id})`);
}

export async function deleteItem(ref: Reference, id: string): Promise<void> {
  await rtdbOp(() => ref.child(id).remove(), `deleteItem(${ref.key}/${id})`);
}

// ── Sweep config ─────────────────────────────────────────────────────────────

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
  const snap = await rtdbOp(() => sweepRef().get(), "getSweepConfig");
  if (!snap.exists()) {
    await rtdbOp(() => sweepRef().set(SWEEP_DEFAULTS), "setSweepDefaults");
    return SWEEP_DEFAULTS;
  }
  return snap.val() as SweepConfig;
}

export async function setSweepConfig(updates: Partial<SweepConfig>): Promise<SweepConfig> {
  const current = await getSweepConfig();
  const updated: SweepConfig = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await rtdbOp(() => sweepRef().set(updated), "setSweepConfig");
  return updated;
}

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface Rule {
  name: string;
  ruleType: string;
  enabled: boolean;
  conditionJson: string | null;
  actionJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLog {
  walletId: string | null;
  action: string;
  status: string;
  txHash: string | null;
  amount: string | null;
  message: string;
  createdAt: string;
}

export interface WhitelistEntry {
  address: string;
  label: string | null;
  createdAt: string;
}

// ── App settings ─────────────────────────────────────────────────────────────

export async function getNvidiaKeyFromDB(): Promise<string | null> {
  const snap = await rtdbOp(() => rtdb.ref("settings/nvidiaApiKey").get(), "getNvidiaKey");
  return snap.exists() ? (snap.val() as string) : null;
}

export async function setNvidiaKeyInDB(key: string): Promise<void> {
  await rtdbOp(() => rtdb.ref("settings/nvidiaApiKey").set(key), "setNvidiaKey");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

export async function insertLog(log: Omit<AgentLog, "createdAt">): Promise<WithId<AgentLog>> {
  return pushItem<AgentLog>(logsRef(), { ...log, createdAt: now() });
}
