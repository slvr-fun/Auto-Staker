# SLVR Auto-Staker — guide for AI assistants

A local web app that automates a SLVR staking position on Robinhood Chain:
claims ETH rewards, splits them (hold / mine / buy-and-max-lock), and shows a
live dashboard. Users run it with `npm start` (server + UI at
http://localhost:4663).

## Architecture map

| File | What it does |
|---|---|
| `src/index.ts` | CLI entry: `ui` (default), `once`, `status`, `check` |
| `src/preflight.ts` | Node >= 22.13 check — must stay the first import |
| `src/config.ts` | config.json + state.json + RPC resolution |
| `src/keystore.ts` | **security-critical** — wallet.json, AES-256-GCM + scrypt |
| `src/chain.ts` | viem clients, SDK wiring, vote-escrow + router ABIs |
| `src/position.ts` | veNFT reads, max-lock, add-to-lock |
| `src/swap.ts` | ETH→SLVR buys (fee-on-transfer aware) |
| `src/strategies.ts` | built-in decision strategies (upstream file — don't add user code) |
| `src/strategies.custom.ts` | **user strategies go here** — upgrades never touch it |
| `src/mining.ts` | **the mining engine** — bet sizing, gas rails, pacing, settle. Isolated so you can tune mining without touching the money split |
| `src/budget.ts` | tiny shared leaf: gas reserve + `spendable()` + the rolling-24h spend-limit helpers (`spent24hWei`, `buys24h`, `dailyRemainingWei`, `recordSpend`) |
| `src/cycle.ts` | the automation loop: claim → hold/mine/buyback split, then calls the mining engine |
| `src/app.ts` | **headless core** — automation control, state, settings, actions, 30s monitor; no HTTP. New front ends (Telegram bot, CLI) import this |
| `src/server.ts` | thin HTTP adapter over `app.ts` + static file serving — no logic |
| `src/db.ts` | SQLite (node:sqlite) events + snapshots |
| `public/index.html` | the entire UI — single self-contained file |

## Rules — read before changing anything

1. **Never touch user data files**: `wallet.json`, `config.json`,
   `state.json`, `data.sqlite*` (in the OS app-data dir —
   `~/Library/Application Support/slvr-autostaker` on macOS,
   `%APPDATA%\slvr-autostaker` on Windows, `~/.local/share/slvr-autostaker`
   on Linux — with per-profile subfolders) and any legacy copies or `.env` in
   the repo. Never
   print, log, or commit a private key; never weaken `src/keystore.ts`
   (encryption params, the overwrite guard, the password-gated reveal).
2. **Money safety**: `cycle.ts` moves real funds in LIVE mode. Keep dry-run
   the default; keep the gas reserve, per-round caps, and the
   record-before-send pattern in `maybeMine`. When testing, use a fresh
   throwaway wallet and stay in dry-run.
3. **Verify every change**: `npx tsc --noEmit` and `npm run check:ui`
   must pass, then
   `npm run check` (no wallet needed — proves the chain connection), then
   restart `npm start` and exercise the UI. The server serves
   `public/index.html` per request, so UI edits only need a browser reload;
   `src/` edits need a server restart.
4. **The UI is one file** (`public/index.html`) using the SLVR design system:
   dark elevation ladder (#0d0d0d/#111112/#1a1a1b/#202022), rings as inset
   box-shadows (never CSS borders), Geist + Space Grotesk. Match it.
5. **No new native modules** — `node:sqlite` was chosen so `npm install`
   never needs a compiler. Keep it that way for Windows/macOS users.
6. **Keep the API localhost-only** (`127.0.0.1` bind in `server.ts`) and keep
   the static-file path check.

## Upgrades

This repo is a template users clone and modify. `UPGRADES.md` carries the
per-release notes; the `upgrade-autostaker` skill merges upstream changes
into a user's copy without touching their data or customizations. When
releasing: add an entry at the top of `UPGRADES.md`, bump `version` in
`package.json`, keep changes to `public/index.html` and `src/cycle.ts` as
surgical as possible (they're the files users most often customize).

## Quick recipes

- **Write a NEW strategy** → `src/strategies.custom.ts`. That file belongs
  to the user and upgrades never touch it, so custom strategies merge
  cleanly forever. Add an entry to `CUSTOM_MINING` (or `CUSTOM_BUYBACK` /
  `CUSTOM_ALLOCATION`) — it automatically appears as a choice in Settings →
  Mining. Do NOT add user strategies to `strategies.ts` (that's the
  upstream file; editing it invites merge conflicts).
- Change how mining works (bet size, pacing, gas rails, settlement) →
  `src/mining.ts` — it's isolated from the rest of the loop. The tuning
  knobs are grouped at the top of the file.
- Change other automation execution (claiming, hold transfers, buybacks) →
  `src/cycle.ts` (log with the `log()` callback so it reaches the UI
  activity feed; record events via `db.logEvent`).
- Add a dashboard stat → add the read in `app.ts#getState`, render it in
  `public/index.html#render()`.
- Add a setting → `AppConfig` + `DEFAULTS` in `config.ts`, add to
  `validateConfig`'s finite-guard, pass-through in `app.ts#updateConfig`,
  field in the settings modal, `fillForm` + save handler in `index.html`.
- **Change a user's SETTING (not code)** → `npm run config -- set-json '{…}'`
  or `npm run config -- set key=value` (validates + writes `config.json`
  atomically; a running app applies it next cycle). `npm run config` prints
  it. Never hand-edit `config.json`.
- **Build a new front end (Telegram bot, CLI, …)** → import from `src/app.ts`
  (`getState`, `startAutomation`, `stopAutomation`, `runOnce`, `maxLock`,
  `updateConfig`, `getSeries`, `subscribeLog` for push notifications, `boot()`
  once at startup) and `src/keystore.ts` for wallet ops. Never duplicate
  logic in the presentation layer — `server.ts` is the reference adapter.
  Only ONE process may run the core at a time (state files + SQLite are
  single-writer), so host a bot inside the same process, not a second one.
