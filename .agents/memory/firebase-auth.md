---
name: Firebase auth setup
description: Firebase Auth (email/password) on frontend; Admin SDK token verification on backend with service account; RTDB for all data storage.
---

# Firebase Auth & RTDB Setup

**Project:** mec-agent-ops

## Auth flow
- Frontend: Firebase client SDK (`firebase@10`) — `signInWithEmailAndPassword` / `createUserWithEmailAndPassword`
- Backend middleware: `requireAuth` in `artifacts/api-server/src/middlewares/firebase-auth.ts` — verifies Firebase ID token from `Authorization: Bearer <token>` header
- Frontend sends token via `authFetch` helper and `setAuthTokenGetter` wired in `auth-context.tsx`
- `/api/healthz` is exempt from auth (registered before middleware in `app.ts`)

## Firebase Admin SDK init
- File: `artifacts/api-server/src/lib/firebase-admin.ts`
- Requires `FIREBASE_SERVICE_ACCOUNT` secret (full service account JSON key)
- **Gotcha**: Replit stores the secret with the outer `{` brace dropped — parser tries prepending `{` if raw value doesn't start with `{`
- Project: `mec-agent-ops`, DB URL: `https://mec-agent-ops-default-rtdb.firebaseio.com`

## RTDB data layer
- All CRUD helpers in `artifacts/api-server/src/lib/firebase-db.ts`
- Collections: `wallets`, `rules`, `agent_logs`, `whitelist`, `sweep_config`
- IDs are Firebase push-key strings (not integers) — all route params use `string` not `number`

## Required secrets
- `FIREBASE_SERVICE_ACCOUNT` — service account JSON (Replit drops the opening `{`, parser handles it)
- `NVIDIA_API_KEY` — for AI agent features

**Why:** All runtime data goes to Firebase RTDB per user requirement. PostgreSQL schema in `lib/db/` is present but unused at runtime.
