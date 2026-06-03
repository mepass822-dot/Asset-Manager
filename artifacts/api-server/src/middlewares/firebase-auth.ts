import type { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";
import type { DecodedIdToken } from "firebase-admin/auth";
import "../lib/firebase-admin";
import { logger } from "../lib/logger";

const adminAuth = getAuth();

const TOKEN_VERIFY_TIMEOUT_MS = 10_000;
const TOKEN_CACHE_TTL_MS      = 4 * 60 * 1000; // 4 min (tokens valid for 1h)
const TOKEN_CACHE_MAX_SIZE    = 500;

// ── Token verification cache ─────────────────────────────────────────────────
// Caches the decoded token after first successful verification.
// Avoids a round-trip to Google's auth servers on every request.

interface CacheEntry {
  decoded: DecodedIdToken;
  cachedAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

function pruneCache() {
  if (tokenCache.size < TOKEN_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) tokenCache.delete(token);
  }
}

function getCached(token: string): DecodedIdToken | null {
  const entry = tokenCache.get(token);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
    tokenCache.delete(token);
    return null;
  }
  return entry.decoded;
}

function setCache(token: string, decoded: DecodedIdToken) {
  pruneCache();
  tokenCache.set(token, { decoded, cachedAt: Date.now() });
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Middleware ────────────────────────────────────────────────────────────────

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized — missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);

  // Fast path: serve from cache
  const cached = getCached(token);
  if (cached) {
    (req as any).user = cached;
    next();
    return;
  }

  // Slow path: verify with Firebase Auth (network call)
  try {
    const decoded = await withTimeout(
      adminAuth.verifyIdToken(token),
      TOKEN_VERIFY_TIMEOUT_MS,
      "Firebase token verification"
    );
    setCache(token, decoded);
    (req as any).user = decoded;
    next();
  } catch (err) {
    logger.warn({ err }, "Firebase token verification failed");
    res.status(401).json({ error: "Unauthorized — invalid or expired token" });
  }
}
