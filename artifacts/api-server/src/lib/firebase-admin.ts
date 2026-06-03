import { initializeApp, getApps, getApp, type App } from "firebase-admin/app";

const PROJECT_ID = "mec-agent-ops";
const DATABASE_URL = "https://mec-agent-ops-default-rtdb.firebaseio.com";

export const adminApp: App =
  getApps().length === 0
    ? initializeApp({ projectId: PROJECT_ID, databaseURL: DATABASE_URL })
    : getApp();
