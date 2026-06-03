import express, { type Express } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./middlewares/firebase-auth";

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

// Serve bridge extension ZIP for download (unauthenticated).
// Try multiple candidate paths to work both locally and on Vercel.
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

// Health check — no auth required
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// All other /api routes require a valid Firebase ID token
app.use("/api", requireAuth, router);

// In production on a self-hosted server, serve the built dashboard static files.
// On Vercel, static assets are served by the CDN and the function only handles /api/*,
// so we skip this to avoid broken paths in the serverless environment.
if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  const dashboardDist = path.join(__dirname, "../../dashboard/dist/public");
  app.use(express.static(dashboardDist, { etag: false }));
  // SPA fallback — all non-API routes serve index.html
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
