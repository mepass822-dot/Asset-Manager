import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./middlewares/firebase-auth";
import { requestTimeout } from "./middlewares/request-timeout";

const app: Express = express();

// Disable ETags — they cause 304 responses which the API client
// interprets as "no body" (returning null), breaking .map() calls in the UI.
app.set("etag", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: { id: unknown; method: string; url?: string }) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global request timeout — ensures no request ever reaches the gateway's 30s limit
app.use(requestTimeout);

// Serve bridge extension ZIP for download (unauthenticated).
const bridgeZipCandidates = [
  path.resolve(process.cwd(), "attached_assets/mec-bridge-extension/bridge-extension.zip"),
  path.resolve(process.cwd(), "../../attached_assets/mec-bridge-extension/bridge-extension.zip"),
];
const bridgeZipPath = bridgeZipCandidates.find(existsSync) ?? bridgeZipCandidates[0];

app.get("/api/wallets/bridge-extension.zip", (_req, res) => {
  if (!existsSync(bridgeZipPath)) {
    res.status(404).json({ error: "Bridge extension not available" });
    return;
  }
  res.download(bridgeZipPath, "mec-bridge-extension.zip");
});

// Health checks — no auth required
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/healthz/detail", (_req, res) => {
  const { getCircuitBreakerStatus } = require("./lib/firebase-db");
  const cb = getCircuitBreakerStatus() as ReturnType<typeof getCircuitBreakerStatus>;
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

// All other /api routes require a valid Firebase ID token
app.use("/api", requireAuth, router);

// In production on a self-hosted server, serve the built dashboard static files.
if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  const dashboardDist = path.join(__dirname, "../../dashboard/dist/public");
  app.use(express.static(dashboardDist, { etag: false }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

// Global error handler — catches any unhandled errors thrown in route handlers
// Must be defined last and have exactly 4 parameters for Express to recognise it
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, method: req.method, url: req.url }, "Unhandled route error");
  if (!res.headersSent) {
    res.status(500).json({ error: `Internal server error: ${message}` });
  }
});

export default app;
