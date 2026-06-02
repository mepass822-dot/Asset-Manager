---
name: Wstaking rewards endpoint
description: The correct ME chain endpoint for withdrawable block rewards — different from standard Cosmos distribution.
---

# Wstaking Rewards Endpoint

**Rule:** Always use the ME-specific wstaking endpoint for "Withdrawable Block Rewards", NOT the standard Cosmos distribution endpoint.

- **Correct:** `GET /metaearth/wstaking/delegation-rewards/{delegator_address}`
- **Wrong (returns 0):** `GET /cosmos/distribution/v1beta1/delegators/{addr}/rewards`

**Response format:**
```json
{"rewards":[{"denom":"umec","amount":"92554.937262000000000000"}]}
```

**Why:** The ME chain has a custom `wstaking` module for flexible staking (block rewards). The standard Cosmos distribution endpoint only covers validator delegation rewards, which is a different mechanism. Querying the wrong endpoint always returned 0.

**How to apply:** `queryStakingRewards()` in `blockchain.ts` tries the wstaking endpoint first, then falls back to the standard distribution endpoint. The wstaking result has `validatorAddress: "wstaking"` as a marker.

**Claim message type:** For claiming wstaking rewards, use `/metaearth.wstaking.v1beta1.MsgWithdrawReward` with just `{ delegatorAddress }` (no validatorAddress needed). This is different from the standard `MsgWithdrawDelegatorReward` which requires a validator address.
