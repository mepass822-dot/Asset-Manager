/**
 * Loads env/.env.local before anything else starts.
 * Only active when the file exists — safe to omit in Replit (secrets are env vars)
 * and on Vercel (env vars are set via Vercel dashboard / deploy script).
 *
 * Format: KEY=value  (one per line, # for comments, blank lines ok)
 * Values are NOT quoted — the first '=' splits key from value.
 * This lets FIREBASE_SERVICE_ACCOUNT hold a raw JSON string safely.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const candidates = [
  resolve(process.cwd(), "../../env/.env.local"),
  resolve(process.cwd(), "../../../env/.env.local"),
  resolve(process.cwd(), "env/.env.local"),
];

for (const envPath of candidates) {
  try {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    let loaded = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1);
      if (key && !process.env[key]) {
        process.env[key] = val;
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log(`[env] Loaded ${loaded} variable(s) from ${envPath}`);
    }
    break;
  } catch {
    // file not found at this path — try next
  }
}
