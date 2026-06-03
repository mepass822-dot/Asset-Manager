/**
 * Firebase RTDB access via REST API.
 *
 * The Admin SDK's `getDatabase()` uses WebSockets internally. On Vercel
 * serverless (cold starts) the WebSocket handshake can hang indefinitely —
 * Promise.race() cannot interrupt it. Switching to the RTDB REST API
 * (simple HTTPS + AbortController) fixes this completely.
 */
import { getApp } from "firebase-admin/app";
import "./firebase-admin"; // ensure app is initialised

const DATABASE_URL = "https://mec-agent-ops-default-rtdb.firebaseio.com";

// ── Config ────────────────────────────────────────────────────────────────────

const RTDB_TIMEOUT_MS   = 8_000;
const MAX_RETRIES       = 2;
const RETRY_BASE_DELAY  = 500;
const CB_FAILURE_THRESH = 3;
const CB_RESET_MS       = 30_000;

// ── Circuit breaker ───────────────────────────────────────────────────────────

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
  if (cbState !== "CLOSED") console.info("[firebase-db] Circuit breaker CLOSED — healthy");
  cbState = "CLOSED"; cbFailures = 0; cbOpenedAt = null;
}

function cbOnFailure() {
  cbFailures++;
  if (cbState === "HALF_OPEN" || cbFailures >= CB_FAILURE_THRESH) {
    cbState = "OPEN"; cbOpenedAt = Date.now();
    console.warn(`[firebase-db] Circuit breaker OPEN after ${cbFailures} failures — pausing ${CB_RESET_MS / 1000}s`);
  }
}

function cbCheck(): void {
  if (cbState === "CLOSED") return;
  if (cbState === "OPEN") {
    const elapsed = Date.now() - (cbOpenedAt ?? 0);
    if (elapsed >= CB_RESET_MS) {
      cbState = "HALF_OPEN";
      console.info("[firebase-db] Circuit breaker HALF_OPEN — probe request");
    } else {
      const remaining = Math.ceil((CB_RESET_MS - elapsed) / 1000);
      throw new Error(`Firebase RTDB circuit open — retry in ${remaining}s`);
    }
  }
}

// ── REST helpers ──────────────────────────────────────────────────────────────

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const credential = getApp().options.credential!;
  const result = await credential.getAccessToken();
  _tokenCache = {
    token: result.access_token,
    expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000,
  };
  return result.access_token;
}

async function restFetch(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${DATABASE_URL}/${path}.json?access_token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RTDB_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Firebase RTDB ${method} ${path} → HTTP ${resp.status}: ${text}`);
    }
    return resp.status === 204 ? null : resp.json();
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      throw new Error(`Firebase RTDB timed out after ${RTDB_TIMEOUT_MS}ms (${method} ${path})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("timed out") || m.includes("timeout") || m.includes("abort") ||
    m.includes("network") || m.includes("econnreset") || m.includes("enotfound") ||
    m.includes("socket") || m.includes("unavailable") || m.includes("fetch failed")
  );
}

async function rtdbOp<T>(fn: () => Promise<T>, label = "rtdb"): Promise<T> {
  cbCheck();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      cbOnSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_RETRIES) break;
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.warn(`[firebase-db] ${label} failed (${attempt + 1}/${MAX_RETRIES + 1}), retry in ${delay}ms —`, (err as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  cbOnFailure();
  throw lastErr;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

const PATHS = {
  wallets:   "wallets",
  rules:     "rules",
  logs:      "agent_logs",
  whitelist: "whitelist",
  sweep:     "sweep_config",
  nvidia:    "settings/nvidiaApiKey",
} as const;

export type WithId<T> = T & { id: string };

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getAllItems<T>(path: string): Promise<WithId<T>[]> {
  const data = await rtdbOp(() => restFetch("GET", path), `getAllItems(${path})`);
  if (!data) return [];
  return Object.entries(data as Record<string, T>).map(
    ([id, val]) => ({ ...(val as object), id } as WithId<T>)
  );
}

export async function pushItem<T extends object>(path: string, data: T): Promise<WithId<T>> {
  const result = await rtdbOp(() => restFetch("POST", path, data), `pushItem(${path})`);
  const id = (result as { name: string }).name;
  return { ...data, id };
}

export async function getItem<T>(path: string, id: string): Promise<WithId<T> | null> {
  const data = await rtdbOp(() => restFetch("GET", `${path}/${id}`), `getItem(${path}/${id})`);
  if (!data) return null;
  return { ...(data as T), id };
}

export async function updateItem(path: string, id: string, updates: object): Promise<void> {
  await rtdbOp(() => restFetch("PATCH", `${path}/${id}`, updates), `updateItem(${path}/${id})`);
}

export async function deleteItem(path: string, id: string): Promise<void> {
  await rtdbOp(() => restFetch("DELETE", `${path}/${id}`), `deleteItem(${path}/${id})`);
}

export async function clearPath(path: string): Promise<void> {
  await rtdbOp(() => restFetch("DELETE", path), `clearPath(${path})`);
}

// ── Ref-compatible wrappers (keeps existing route code unchanged) ──────────────

export const walletsRef   = () => PATHS.wallets;
export const rulesRef     = () => PATHS.rules;
export const logsRef      = () => PATHS.logs;
export const whitelistRef = () => PATHS.whitelist;
export const sweepRef     = () => PATHS.sweep;

// ── Sweep config ──────────────────────────────────────────────────────────────

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
  const data = await rtdbOp(() => restFetch("GET", PATHS.sweep), "getSweepConfig");
  if (!data) {
    await rtdbOp(() => restFetch("PUT", PATHS.sweep, SWEEP_DEFAULTS), "setSweepDefaults");
    return SWEEP_DEFAULTS;
  }
  return data as SweepConfig;
}

export async function setSweepConfig(updates: Partial<SweepConfig>): Promise<SweepConfig> {
  const current = await getSweepConfig();
  const updated: SweepConfig = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await rtdbOp(() => restFetch("PUT", PATHS.sweep, updated), "setSweepConfig");
  return updated;
}

// ── App settings ──────────────────────────────────────────────────────────────

export async function getNvidiaKeyFromDB(): Promise<string | null> {
  const val = await rtdbOp(() => restFetch("GET", PATHS.nvidia), "getNvidiaKey");
  return val as string | null;
}

export async function setNvidiaKeyInDB(key: string): Promise<void> {
  await rtdbOp(() => restFetch("PUT", PATHS.nvidia, key), "setNvidiaKey");
}

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function now(): string { return new Date().toISOString(); }

export async function insertLog(log: Omit<AgentLog, "createdAt">): Promise<WithId<AgentLog>> {
  return pushItem<AgentLog>(PATHS.logs, { ...log, createdAt: now() });
}
