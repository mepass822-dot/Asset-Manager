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

- **Coin type 118 (Cosmos standard)**: The `gc_20-1` chain is pure Cosmos SDK (no EVM module confirmed by direct chain probe). Coin type 60 (Ethermint/EVM) is NOT used.
- **gc1... addresses for balance queries**: The REST LCD (`118.175.0.247:1317`) only accepts `gc1...` bech32 prefix. `me1...` and `gc1...` are identical raw bytes with different HRP — `meToGcAddress()` handles the conversion.
- **Native denom `ugc`**: Confirmed via on-chain supply query. Total supply ~100 trillion ugc. Displayed as "MEC" in the UI. 1 MEC = 1,000,000 ugc.
- **Extension import uses provided address**: When importing from the Meta Earth Chrome extension, we trust the extension's address directly rather than re-deriving (which could use a different HD path). This is the key fix for balance display.
- **NVIDIA NIM via `nvidia-nim` base URL**: Uses `meta/llama-3.1-70b-instruct` model for agent decision-making.

## Product

- Manage multiple MEC wallets (import via mnemonic, private key, or Chrome extension)
- Real-time on-chain balance display (ugc / MEC)
- AI agent (NVIDIA NIM / Llama 3.1) for autonomous transfer decisions
- Address whitelist for security guardrails
- Send MEC with pre-flight balance check and key mismatch detection

## Chain facts (gc_20-1) — confirmed by direct probing

```
Chain ID   : gc_20-1
App        : gead v1.1.2-callisto-5 (CometBFT 0.37.5)
VM         : Cosmos SDK only — NO EVM/Ethermint module
Bech32     : "gc" on-chain, "me" user-facing (same raw bytes)
Denom      : ugc (micro-GC), total supply ~100 trillion ugc
HD path    : m/44'/118'/0'/0/<index>
REST LCD   : http://118.175.0.247:1317  (only public endpoint)
RPC        : http://118.175.0.247:26657
Docs       : https://docs.mec.me
```

## Gotchas

- **Balance shows 0 after fresh import**: Wallets imported before the extension import fix had addresses re-derived with coin type 118. If the extension used a different HD path internally, those addresses differ → delete and re-import via the extension bridge.
- **gc_20-1 vs ME Network 2.0**: ME Network 2.0 was activated May 19 2025. The node at `118.175.0.247` may be a legacy or private node. If the extension shows balance but the app shows 0, the funds may be on a different chain endpoint not publicly accessible from Replit.
- **All other public endpoints (me-explorer.me-network.me etc.) are DNS-unresolvable** from Replit. Only `118.175.0.247:1317` is reachable.
- **1 GC fee per transaction**: `sendMEC` charges 1,000,000 ugc (1 GC) as network fee.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
