---
name: modify-autostaker
description: Safely modify or extend the SLVR Auto-Staker — change the automation, add dashboard stats, add settings, or restyle the UI. Use whenever the user asks to change, customize, improve, or add a feature to this app. Enforces the safety rails (never touch wallet/user data, verify with typecheck + dry-run).
---

# Safely modify the SLVR Auto-Staker

Follow this workflow for ANY change to this repository. The architecture map
and full rules live in `CLAUDE.md` — read it first if you haven't.

## Workflow

1. **Locate the change** using the map in `CLAUDE.md` (NEW strategies →
   `src/strategies.custom.ts` (never `strategies.ts` — the custom file is
   upgrade-proof), automation execution → `src/cycle.ts`, dashboard →
   `app.ts#getState` + `public/index.html`, settings → `config.ts` +
   `app.ts#updateConfig` + the settings modal, new front end like a Telegram
   bot → build on `src/app.ts` (the headless core; `server.ts` is the
   reference adapter), wallet/crypto → stop and re-read the rules below).

2. **Make the change**, matching the existing style (SLVR design system in
   the UI; inset-shadow rings, never borders; the elevation ladder colors).

3. **Verify — all three, in order:**
   - `npx tsc --noEmit` (must be clean)
   - `npm run check` — proves the RPC/SDK still work, needs no wallet
   - restart `npm start`, reload http://localhost:4663, and exercise the
     changed surface in **dry-run mode**

4. **If the change touches money paths** (`cycle.ts`, `swap.ts`,
   `position.ts`): run at least one full `npm run once` in dry-run and read
   the printed decisions before suggesting the user go live. Never test with
   a funded wallet.

## Hard rules

- Never read out, log, print, or commit `wallet.json`, `.env`, private keys,
  or passwords. These files are the user's money.
- Never weaken `src/keystore.ts`: scrypt params, AES-256-GCM, the
  existing-wallet overwrite guard, and the password-gated reveal stay.
- Never delete or migrate `config.json` / `state.json` / `data.sqlite`
  destructively — users depend on them across restarts. Additive schema
  changes only (new fields with defaults).
- Keep the server bound to 127.0.0.1 and keep dry-run as the default mode.
- No new native npm modules (keeps installs compiler-free on Windows/macOS).

## Updating the user's SETTINGS (not code)

When the user asks to change a *setting* (their split, buyback dip %, mining
strategy, price-impact cap, etc.) — not the code — use the config CLI, which
validates and persists to `config.json`. A running app applies it on the next
cycle (no restart). Never hand-edit `config.json`.

- Read it:   `npm run config` (prints the full config)
- Set fields: `npm run config -- set-json '{"buybackDipPct":2,"maxBuybackPriceImpactPct":1}'`
  or `npm run config -- set buybackMinIntervalMin=60 minePace=large`
- Strategy params: `npm run config -- set strategyParams.opp.highEdge=8`

It rejects invalid values (NaN, splits that don't sum to 100, bad addresses),
so you can't brick the config. Show the user the changed fields afterward.

## After the change

Summarize what changed, what you verified, and anything the user should
re-check in the UI. Do not commit unless the user asks.
