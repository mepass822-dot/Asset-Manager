import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth } from "./middlewares/firebase-auth";
import { db, sweepConfigTable } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seed the sweep config row (with master address default) on startup
(async () => {
  try {
    const rows = await db.select().from(sweepConfigTable).limit(1);
    if (rows.length === 0) {
      await db.insert(sweepConfigTable).values({});
      logger.info("Sweep config seeded with master address default");
    }
  } catch (err) {
    logger.warn({ err }, "Could not seed sweep config on startup");
  }
})();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve bridge extension ZIP for download (unauthenticated)
const bridgeZipPath = path.resolve(process.cwd(), "../../attached_assets/mec-bridge-extension/bridge-extension.zip");
app.get("/api/wallets/bridge-extension.zip", (_req, res) => {
  res.download(bridgeZipPath, "mec-bridge-extension.zip");
});

// Health check — no auth required
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// All other /api routes require a valid Firebase ID token
app.use("/api", requireAuth, router);

export default app;
