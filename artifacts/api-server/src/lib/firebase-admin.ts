import { initializeApp, getApps, getApp, cert, type App } from "firebase-admin/app";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_ID = "mec-agent-ops";
const DATABASE_URL = "https://mec-agent-ops-default-rtdb.firebaseio.com";

function parseServiceAccount(raw: string): object | null {
  const attempts = [
    raw,
    raw.trim(),
    // Missing opening brace — value is just the inner fields
    (() => { const t = raw.trim(); return t.startsWith("{") ? t : "{" + t; })(),
  ];
  for (const s of attempts) {
    try { return JSON.parse(s); } catch { /* try next */ }
  }
  return null;
}

function loadServiceAccount(): object | null {
  // 1. Try env var first
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT"];
  if (raw && raw.length > 100) {
    const parsed = parseServiceAccount(raw);
    if (parsed) {
      console.log("[firebase-admin] Loaded credentials from FIREBASE_SERVICE_ACCOUNT env var");
      return parsed;
    }
    console.warn("[firebase-admin] FIREBASE_SERVICE_ACCOUNT env var present but could not be parsed");
  }

  // 2. Fall back to local service-account.json file (gitignored, dev-only)
  const candidates = [
    resolve(__dirname, "../../service-account.json"),
    resolve(__dirname, "../../../service-account.json"),
    resolve(process.cwd(), "service-account.json"),
  ];
  for (const filePath of candidates) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      console.log(`[firebase-admin] Loaded credentials from file: ${filePath}`);
      return parsed;
    } catch {
      // try next
    }
  }

  return null;
}

function makeApp(): App {
  const serviceAccount = loadServiceAccount();
  if (serviceAccount) {
    const sa = serviceAccount as Record<string, unknown>;
    console.log(`[firebase-admin] Using key_id=${sa["private_key_id"]} email=${sa["client_email"]}`);
    return initializeApp({ credential: cert(serviceAccount as any), databaseURL: DATABASE_URL });
  }
  console.error("[firebase-admin] No valid service account found — Firebase RTDB will not work");
  return initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL });
}

export const adminApp: App = getApps().length === 0 ? makeApp() : getApp();
