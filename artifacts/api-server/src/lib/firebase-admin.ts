import { initializeApp, getApps, getApp, cert, type App } from "firebase-admin/app";

const PROJECT_ID = "mec-agent-ops";
const DATABASE_URL = "https://mec-agent-ops-default-rtdb.firebaseio.com";

function makeApp(): App {
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT"];
  if (raw) {
    try {
      const serviceAccount = JSON.parse(raw);
      return initializeApp({ credential: cert(serviceAccount), databaseURL: DATABASE_URL });
    } catch {
      console.error("FIREBASE_SERVICE_ACCOUNT is set but could not be parsed as JSON — falling back to default credentials");
    }
  }
  return initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL });
}

export const adminApp: App = getApps().length === 0 ? makeApp() : getApp();
