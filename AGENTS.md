# Agent guide

All architecture notes, safety rules, and verification steps for AI agents
working on this repo live in **[CLAUDE.md](CLAUDE.md)** — read that file
before making changes. The short version:

- Never touch or expose `wallet.json`, `.env`, `config.json`, `state.json`,
  `data.sqlite*` — user money and state.
- Never weaken `src/keystore.ts` (crypto, overwrite guard, gated reveal).
- Verify every change: `npx tsc --noEmit` → `npm run check` → restart
  `npm start` and test the UI in dry-run.
- The whole UI is `public/index.html`; the automation loop is `src/cycle.ts`
  and the mining engine is `src/mining.ts`.
