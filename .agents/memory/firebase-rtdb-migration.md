---
name: Firebase RTDB migration
description: PostgreSQL + Drizzle ORM replaced by Firebase Realtime Database across all routes and the scheduler
---

## What changed
All data storage migrated from PostgreSQL/Drizzle to Firebase Realtime Database (RTDB). PostgreSQL is no longer used at runtime.

## Single initialization point
`artifacts/api-server/src/lib/firebase-admin.ts` initializes the Firebase Admin app exactly once with both `projectId` and `databaseURL`. All other files (`firebase-auth.ts`, `firebase-db.ts`, routes) import this module to guarantee the app is initialized before `getAuth()` or `getDatabase()` is called.

**Why:** The previous pattern called `initializeApp` in `firebase-auth.ts` without `databaseURL`, which would cause RTDB to fail if auth middleware was imported first.

## RTDB data model
All collections stored under root paths:
- `/wallets/{pushKey}` — Wallet records (label, address, encryptedMnemonic, network, hdIndex, verified, monitored, importSource, createdAt, updatedAt)
- `/rules/{pushKey}` — Automation rules
- `/agent_logs/{pushKey}` — Agent activity logs  
- `/whitelist/{pushKey}` — Whitelisted destination addresses
- `/sweep_config` — Single object (not a collection), read/written via `getSweepConfig()` / `setSweepConfig()`

## ID type change: integer → string
Firebase push keys are strings (e.g. `-NxAbcDef`). All route params (`:id`), `walletIds` arrays in request bodies, and `SchedulerConfig.walletIds` are now `string[]` instead of `number[]`. The Drizzle Zod validators (`GetWalletParams`, `DeleteWalletParams`, etc.) that coerced IDs to integers are no longer used in routes.

## Helper layer
`artifacts/api-server/src/lib/firebase-db.ts` exports:
- `getAllItems<T>(ref)` — returns all children as `WithId<T>[]`
- `pushItem<T>(ref, data)` — push + return with id
- `getItem<T>(ref, id)` — get by push key
- `updateItem(ref, id, updates)` — partial update
- `deleteItem(ref, id)` — remove
- `insertLog(log)` — convenience wrapper for agent_logs
- `getSweepConfig()` / `setSweepConfig()` — single-doc helpers with defaults

## Ordering
RTDB has no native `ORDER BY`. All sorted lists are sorted in memory after `getAllItems()`, ordering by `createdAt` string (ISO-8601, so lexicographic = chronological).

## Duplicate checks in bulk import
Address uniqueness is checked by loading all wallets into memory and using a `Set<string>`, rather than a DB-level unique index. Acceptable for the expected wallet count.

**How to apply:** If bulk imports grow very large, consider an RTDB index on `address` field and use `orderByChild('address').equalTo(address)` queries instead.
