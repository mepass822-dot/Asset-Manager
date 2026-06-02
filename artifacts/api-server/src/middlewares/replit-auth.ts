import type { Request, Response, NextFunction } from "express";

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.headers["x-replit-user-id"];
  if (!userId) {
    res.status(401).json({ error: "Unauthorized — not logged in" });
    return;
  }
  (req as any).user = {
    uid: userId,
    name: req.headers["x-replit-user-name"] ?? "unknown",
  };
  next();
}
