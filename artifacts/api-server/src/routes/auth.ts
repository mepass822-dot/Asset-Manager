import { Router, type IRouter } from "express";
import type { Request, Response } from "express";

const router: IRouter = Router();

router.get("/auth/me", (req: Request, res: Response) => {
  const userId = req.headers["x-replit-user-id"];
  const userName = req.headers["x-replit-user-name"];
  const userImage = req.headers["x-replit-user-profile-image"];

  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json({
    id: userId,
    name: userName ?? "unknown",
    profileImage: userImage ?? null,
  });
});

router.get("/auth/login", (_req: Request, res: Response) => {
  res.redirect("/__replauthuser");
});

export default router;
