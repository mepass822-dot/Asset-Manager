---
name: Firebase auth setup
description: Firebase Auth integration for the MEC Agent dashboard — frontend client SDK + backend Admin SDK token verification.
---

# Firebase Auth Setup

**Project:** mec-agent-ops (Firebase projectId)

**Architecture:**
- Frontend: Firebase client SDK (`firebase@10`) — email/password auth
- Backend: Firebase Admin SDK (`firebase-admin@13`) — token verification only (no service account needed for this)
- Database: PostgreSQL remains unchanged — full Firebase DB migration needs a service account JSON

**How to apply:**
- Frontend: `artifacts/dashboard/src/lib/firebase.ts` holds the client config (hardcoded, public-facing values)
- Frontend: `AuthProvider` in `src/contexts/auth-context.tsx` sets up `onAuthStateChanged` and `setAuthTokenGetter` so all API calls automatically include `Authorization: Bearer {token}`
- Frontend: `AuthGuard` in `App.tsx` shows the login page when no user is authenticated
- Backend: `requireAuth` middleware in `src/middlewares/firebase-auth.ts` verifies tokens using `getAuth().verifyIdToken(token)`
- Backend Admin SDK initialized with just `initializeApp({ projectId: 'mec-agent-ops' })` — no service account needed for token verification alone
- `/api/healthz` is exempt from auth (registered before the auth middleware in `app.ts`)

**Why:** Firebase Admin SDK fetches Google's public signing keys automatically to verify JWT signatures — no service account required for this specific use case. Full Firestore/RTDB server-side database access would require a service account JSON key.

**For full Firebase DB migration:** User must provide Firebase service account JSON as a secret (FIREBASE_SERVICE_ACCOUNT_JSON). Then install `firebase-admin` with `credential: cert(serviceAccount)` and rewrite the Drizzle ORM queries to Firestore operations.
