# Autonomous MEC Wallet Management Agent

AI-driven wallet management agent for the Meta Earth (MEC) blockchain — monitors balances, executes transfers, and applies NVIDIA NIM (Llama 3.1) reasoning to optimize on-chain activity.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `NVIDIA_API_KEY` — NIM inference

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- API: Express 5 (port 8080)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Dashboard: React + Vite (port 23183)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — Drizzle table definitions
- `artifacts/api-server/src/lib/blockchain.ts` — chain interaction, address derivation, balance queries
- `artifacts/api-server/src/lib/nvidia.ts` — NVIDIA NIM / Llama 3.1 integration
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/dashboard/src/` — React dashboard

## Architecture decisions

- **Coin type 118** — confirmed from official SDK source (`instanceME` sets `m/44'/118'/0'/0/<index>`). Standard Cosmos SDK, NOT EVM coin type 60.
- **Bech32 prefix `me`** — addresses are `me1...` everywhere. The ME Hub REST accepts `me1...` directly; no conversion needed.
- **Native denom `umec`** — confirmed from chain supply and SDK source. 1 MEC = 1,000,000 umec.
- **Extension import uses provided address** — trust the extension's address directly; never re-derive from mnemonic during import.
- **NVIDIA NIM via `nvidia-nim` base URL** — uses `meta/llama-3.1-70b-instruct` model.

## Product

- Manage multiple MEC wallets (import via mnemonic, private key, or Chrome extension)
- Real-time on-chain balance display (umec / MEC)
- AI agent (NVIDIA NIM / Llama 3.1) for autonomous transfer decisions
- Address whitelist for security guardrails
- Send MEC with pre-flight balance check and key mismatch detection

## Chain facts (me-chain) — confirmed from official SDK + direct probing

```
Chain ID (mainnet) : me-chain
Chain ID (testnet) : mechain_400-1
App                : me-hub (med v2.0.13+) — Cosmos SDK + Ethermint modules
Bech32 prefix      : me  →  me1... addresses
Native denom       : umec (micro-MEC), total supply ~1.76 quadrillion
HD path            : m/44'/118'/0'/0/<index>  (coin type 118, Cosmos standard)
Gas limit          : 500000
Gas price          : 0.02 umec/gas
Network fee        : 10000 umec  (= 500000 × 0.02)

Mainnet Hub REST LCD : http://118.175.0.247:11317   ← PORT 11317, not 1317!
Mainnet Hub RPC      : http://118.175.0.247:16657
Testnet Hub REST LCD : http://118.175.0.249:1317
Testnet Hub RPC      : http://118.175.0.249:26657

Rollup REST (mainnet): http://118.175.0.247:23013
Rollup REST (testnet): http://118.175.0.249:3317

SDK source: github.com/openmetaearth/meta-earth-js-sdk (master branch)
Docs      : https://docs.mec.me
```

## Gotchas

- **WRONG PORT** was the root cause of balance showing 0: querying `118.175.0.247:1317` (old `gc_20-1` chain with `ugc` denom) instead of the correct `118.175.0.247:11317` (me-hub with `umec` denom).
- **The `gc_20-1` chain at port 1317** is a legacy/different chain. It uses `ugc` denom and `gc1...` addresses. Do NOT confuse with the real ME Hub.
- **1 MEC = 1,000,000 umec** — all amounts on-chain are in umec.
- **Extension import** — always use the address the extension provides; don't re-derive.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
