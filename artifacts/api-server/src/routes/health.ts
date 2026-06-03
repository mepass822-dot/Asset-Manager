import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getCircuitBreakerStatus } from "../lib/firebase-db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Detailed health — useful for debugging; not publicly linked in the UI
router.get("/healthz/detail", (_req, res) => {
  const cb = getCircuitBreakerStatus();
  const firebaseHealthy = cb.state === "CLOSED";
  res.status(firebaseHealthy ? 200 : 503).json({
    status: firebaseHealthy ? "ok" : "degraded",
    uptime: Math.floor(process.uptime()),
    firebase: {
      rtdb: cb.state === "CLOSED" ? "healthy" : cb.state === "HALF_OPEN" ? "recovering" : "unavailable",
      circuitBreaker: cb,
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
