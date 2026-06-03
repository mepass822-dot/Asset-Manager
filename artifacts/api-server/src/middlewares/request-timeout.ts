import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

const REQUEST_TIMEOUT_MS = 25_000; // 25s — safely under 30s gateway limit

/**
 * Adds a hard deadline on every request. If a route handler hasn't sent
 * a response within REQUEST_TIMEOUT_MS, this middleware sends 503 and
 * prevents the request from ever reaching Replit/Vercel's gateway timeout.
 */
export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    logger.warn({ method: req.method, url: req.url }, "Request timed out — sending 503");
    res.status(503).json({ error: "Service temporarily unavailable — request timed out" });
  }, REQUEST_TIMEOUT_MS);

  // Clean up timer once the response finishes (success or error)
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));

  next();
}
