import type { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";
import "../lib/firebase-admin";
import { logger } from "../lib/logger";

const adminAuth = getAuth();

const TOKEN_VERIFY_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized — missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await withTimeout(
      adminAuth.verifyIdToken(token),
      TOKEN_VERIFY_TIMEOUT_MS,
      "Firebase token verification"
    );
    (req as any).user = decoded;
    next();
  } catch (err) {
    logger.warn({ err }, "Firebase token verification failed");
    res.status(401).json({ error: "Unauthorized — invalid or expired token" });
  }
}
