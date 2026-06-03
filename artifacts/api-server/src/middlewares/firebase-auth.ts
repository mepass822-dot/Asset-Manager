import type { Request, Response, NextFunction } from "express";
import { getAuth } from "firebase-admin/auth";
import "../lib/firebase-admin";
import { logger } from "../lib/logger";

const adminAuth = getAuth();

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized — missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    (req as any).user = decoded;
    next();
  } catch (err) {
    logger.warn({ err }, "Firebase token verification failed");
    res.status(401).json({ error: "Unauthorized — invalid or expired token" });
  }
}
