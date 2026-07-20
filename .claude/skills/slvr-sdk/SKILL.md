---
name: slvr-sdk
description: Reference for @slvr-labs/sdk — how this app talks to the SLVR protocol (staking, mining/lottery, token, prices, EV math). Use when a change involves protocol reads/writes, adding SDK calls, or questions about how mining, staking rewards, or locks work on-chain.
---

# @slvr-labs/sdk — how this app uses it

Full docs: `node_modules/@slvr-labs/sdk/README.md`. This is the working
subset, with where each piece is already used in this repo.

## Setup

```ts
import { SlvrSDK, robinhoodChain, deployments } from '@slvr-labs/sdk';
// This repo builds clients in src/chain.ts — use readOnlyCtx() for reads,
// walletCtx() for writes. Don't create ad-hoc clients elsewhere.
```

`deployments.robinhood.addresses` carries every contract address (lottery,
staking, token, voteEscrow, slvrEthPair, chainlinkEthUsd…).

## Staking (ETH rewards) — `sdk.staking`

- `getStakerRewards(tokenId)` → claimable ETH (wei) for a veNFT
- `claimStakerRewards(tokenId)` → claims (owner only; ETH arrives in wallet)
- `stake(tokenId)` / `balance(tokenId)` / `getTotalWeight()`
- Rewards come from each round's protocol fee: stakers share
  `protocolFeeBps × stakerFeeBps` of every pot (~8% by default).
- Used in: `src/cycle.ts` (claim), `src/position.ts` (stake/info).

## Locks (the veNFT) — vote-escrow contract, NOT in the SDK

The SDK has no vote-escrow module; this repo wraps it in `src/chain.ts`
(`VOTE_ESCROW_ABI`) and `src/position.ts`:

- **Max lock = permanent lock**: `createPermanentLock(amount)` /
  `increasePermanentLock(id, amount)` — the SLVR is **burned**, earns forever,
  can never be withdrawn. One per account (`getPermanentLockTokenId`).
- Timed locks exist too (`createLock(amount, duration)`, up to `TMAX()` = 4
  months) but this app's "Max-lock" action means the permanent lock.
- Approve the vote-escrow before locking (`sdk.token.approve`) — it pulls via
  `transferFrom`. `src/position.ts#maxLockSlvr` does all of this.

## Mining (the grid lottery) — `sdk.lottery`

- `currentRoundId()`, `roundOpen(id)`, `bettingEnd(id)`, `getRound(id)`
  (`.totalWager` = the pot)
- `bet({ roundId, squares, amounts })` — payable in native ETH. This app
  spreads every stake over all 25 squares (always holds the winner).
- `claim({ roundId })` — winnings + mined SLVR; `sdk.canClaim(id, addr)` first
- EV math: `sdk.estimateRoundEv({ stake, roundId, pot, cashOut })` →
  `{ profitable, netEth, edgeRatio, breakEvenPot }`. Mining pays while the pot
  is below break-even ≈ `emission × slvrPriceEth / feeFraction`.
- Used in: `src/cycle.ts#maybeMine` / `#settleMiningRounds`.

## Token & prices

- `sdk.token.balanceOf/approve/allowance/transfer`
- `sdk.getSlvrPrice()` → `{ eth, usd }` (pair + Chainlink feed)
- SLVR has a small buy tax → swaps must use the fee-on-transfer router path;
  `src/swap.ts#buySlvr` already handles quoting, tax, and slippage.

## Gotchas

- All amounts are `bigint` wei — format with `formatEther`, never `Number`
  until display.
- A brand-new round has pot 0 — pass the pot *including your stake* to the EV
  math or it throws (see `maybeMine`).
- The betting window is ~60s; don't add slow reads before a bet.
- Reads are cheap (Multicall3 batching is on); writes cost gas — everything
  written must respect dry-run mode (`cfg.live`).
