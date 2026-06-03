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
    const serviceAccount = parseServiceAccount(raw);
    if (serviceAccount) {
      return initializeApp({ credential: cert(serviceAccount as any), databaseURL: DATABASE_URL });
    }
    console.error("FIREBASE_SERVICE_ACCOUNT could not be parsed as JSON — falling back to default credentials");
  }
  return initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL });
}

export const adminApp: App = getApps().length === 0 ? makeApp() : getApp();
