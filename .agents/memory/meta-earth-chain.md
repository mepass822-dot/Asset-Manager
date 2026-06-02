---
name: Meta Earth chain config
description: Correct ME Hub endpoints, denom, coin type, and key gotchas for the MEC blockchain agent project.
---

# Meta Earth (me-chain) — Confirmed Configuration

**Source**: official SDK github.com/openmetaearth/meta-earth-js-sdk master branch + direct chain probing.

## Endpoints

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `me-chain` | `mechain_400-1` |
| Hub REST LCD | `http://118.175.0.247:11317` | `http://118.175.0.249:1317` |
| Hub RPC | `http://118.175.0.247:16657` | `http://118.175.0.249:26657` |
| Rollup REST | `http://118.175.0.247:23013` | `http://118.175.0.249:3317` |

## Chain Parameters

- Bech32 prefix: `me` → addresses are `me1...`
- Native denom: `umec` (1 MEC = 100,000,000 umec — 8 decimal places, NOT 6 despite "micro" prefix)
- HD path: `m/44'/118'/0'/0/<index>` — coin type **118** (Cosmos standard, NOT 60)
- Gas limit: `500000`, gas price: `0.02 umec/gas`, network fee: `10000 umec`
- Hub REST accepts `me1...` addresses directly

## Critical Gotcha

The server `118.175.0.247` runs TWO different chains on different ports:
- **Port 1317** → old `gc_20-1` chain, denom `ugc`, prefix `gc`, app `gead` — WRONG/legacy
- **Port 11317** → real `me-chain` hub, denom `umec`, prefix `me`, app `me-hub` — CORRECT

This was the root cause of balance showing 0: querying port 1317 instead of 11317.

**Why:** The ME Hub mainnet runs on non-standard ports (11317/16657) to coexist with the legacy gc_20-1 chain on the same host.

**How to apply:** Always use port 11317 for mainnet hub REST and 16657 for mainnet hub RPC.

## Address Derivation

- Standard Cosmos SDK path, coin type 118: confirmed from `src/modules/common.ts` in official SDK
- `convert0xToMeAddress(0x...)` and `convertMeTo0xAddress(me1...)` are bech32↔hex re-encodings of the same 20 Cosmos-style bytes — NOT Ethereum keccak256 addresses
- Address prefix `me` is confirmed; hub accepts `me1...` directly
