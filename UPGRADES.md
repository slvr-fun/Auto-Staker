# Upgrade notes

Newest first. Each entry describes what changed, anything a user must do, and
anything that could conflict with local modifications. The `upgrade-autostaker`
skill reads this file when pulling template updates into your copy.

Maintainers: add an entry at the TOP for every meaningful push, bump `version`
in `package.json` to match, and keep entries additive — never rewrite old ones.

---

## 1.1.0 — SDK 0.2.0 + grid lottery migration (IMPORTANT — mining)

**⚠️ If you mine, this upgrade is required.** The grid game has moved to a new
lottery contract at a **cutover round**, and this release teaches the app to
send every lottery call to the right contract. Without it, mining breaks in two
ways that cost real money:

- **Before the cutover**, the new contract is deployed but **not live** — it
  accepts bets while minting no SLVR and holding no jackpot. Betting there
  burns ETH for nothing.
- **After the cutover**, rounds you bet earlier still live on the **old**
  contract. Claiming them on the new one would forfeit those winnings.

Round numbering is continuous across the migration, so a round number alone
doesn't say which contract holds it. The app now resolves that per round:

- **Betting** goes to whichever contract is live for the current round.
- **Settling** goes to the contract that holds that specific round — so
  pre-cutover rounds keep settling correctly on the old contract, forever
  (it's never paused and has no claim deadline).
- The one-time miner account is opened on the contract actually being bet on.
- Round reads, EV pricing, and the dashboard all follow the same routing.

Also moves onto **`@slvr-labs/sdk` 0.2.0** (from 0.1.2), which is what exposes
the migration helpers (`lotteryForRound`, `isMigrationLive`) plus additive
auto-commit `LOCK_MODE` support the auto-staker doesn't use. Nothing the app
already called was renamed or removed.

**User action required:** run `npm install` after merging — the SDK version
changed, so the lockfile must be refreshed before `npm start`. Your wallet,
settings, history, and any unsettled rounds are untouched.

**Verified before release:** typecheck clean, UI check green, live chain
connect OK, per-round routing checked across the cutover boundary (legacy
below it, new at/above it), and a dry-run cycle sends nothing.

**Conflict-prone:** `src/chain.ts` (new `lotteryFor` / `lotteryAddressFor`
helpers), `src/mining.ts` (bet + settle now route per round), `package.json`.
If you customized mining, keep your changes but take the per-round routing —
betting or claiming on the wrong contract loses funds.

---

## 1.0.0 — Initial release

The SLVR Auto-Staker: a local web app that automates a SLVR staking position on
Robinhood Chain. It claims the ETH your locked SLVR earns, splits each claim the
way you choose (hold / mine / buy-and-max-lock), and shows a live dashboard.
Run it with `npm start` (server + UI at http://localhost:4663).

What's in the box:

- **Claim automation** — claims staking rewards past your threshold and splits
  each claim into hold / mine / buy-and-lock shares. Auto or fixed allocation.
- **Claimed-rewards-only funding** — the automation spends *claimed rewards
  only*. Your deposit is never bought, locked, or mined automatically; you
  create your locked position explicitly with **Buy & Lock** (a previewed,
  confirmed step that shows the price impact first).
- **Hard spend limits** — max ETH per buy, max buys per day, and a rolling-24h
  total-spend ceiling across mining + buybacks, all enforced and configurable.
- **Smart + instant buybacks** — buy immediately, or wait for a dip below the
  moving average — always trimmed to a max price-impact cap and deployed in
  measured slices. Resilient swaps re-quote and retry on a revert.
- **Grid mining engine** — EV-gated bet sizing with gas rails, pacing, and
  strategy plug-ins (`strategies.custom.ts`), so mining never eats its edge.
- **Risk presets** — Conservative / Neutral / Aggressive bundles that prefill
  every setting; fully editable afterward.
- **Educational onboarding** — a step-by-step wizard (create/import/restore a
  wallet, verified backup, pick a preset, set limits, fund, put it to work,
  rehearse in dry-run, then a personalized go-live preview) so the first LIVE
  action is never a surprise. Dry-run is the default.
- **Secure keystore** — the wallet is encrypted at rest (AES-256-GCM + scrypt)
  and password-gated. Everything stays on your computer.
- **Live dashboard** — realtime earnings, position, round watch, and a chart,
  in light or dark mode.
- **Config CLI** — `npm run config` reads/updates saved settings from the
  terminal (validated + atomic), so a running app applies changes next cycle.

Requires Node >= 22.13. Built on `@slvr-labs/sdk`.
