import { initializeApp, getApps, getApp, cert, type App } from "firebase-admin/app";

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

function makeApp(): App {
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT"];
  if (raw) {
    console.log(`[firebase-admin] FIREBASE_SERVICE_ACCOUNT found, length=${raw.length}`);
    const serviceAccount = parseServiceAccount(raw);
    if (serviceAccount) {
      const sa = serviceAccount as Record<string, unknown>;
      const keyId = sa["private_key_id"] ?? "missing";
      const email = sa["client_email"] ?? "missing";
      const pk = typeof sa["private_key"] === "string" ? sa["private_key"] : "";
      const pkOk = pk.includes("-----BEGIN PRIVATE KEY-----") && pk.includes("-----END PRIVATE KEY-----");
      console.log(`[firebase-admin] Parsed OK — key_id=${keyId} email=${email} private_key_valid=${pkOk} private_key_length=${pk.length}`);
      if (!pkOk) {
        console.error("[firebase-admin] private_key is missing BEGIN/END markers — the key is truncated or malformed in the secret");
      }
      return initializeApp({ credential: cert(serviceAccount as any), databaseURL: DATABASE_URL });
    }
    console.error("[firebase-admin] FIREBASE_SERVICE_ACCOUNT could not be parsed as JSON — falling back to default credentials");
  } else {
    console.error("[firebase-admin] FIREBASE_SERVICE_ACCOUNT is not set");
  }
  return initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL });
}

export const adminApp: App = getApps().length === 0 ? makeApp() : getApp();
