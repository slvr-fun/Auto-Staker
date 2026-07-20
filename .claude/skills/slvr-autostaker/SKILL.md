---
name: slvr-autostaker
description: Launch the SLVR Auto-Staker local web UI. Use when the user wants to run, open, start, or check on the SLVR auto-staker / their SLVR staking automation. Installs dependencies if needed, starts the local server, and opens the UI in the browser.
---

# Run the SLVR Auto-Staker UI

Launch the local web UI for the SLVR Auto-Staker (this repository). Everything
runs on the user's machine; the UI is served at http://localhost:4663.

## Steps

1. **Check Node.js**: run `node --version`. It must be v22.13 or newer. If Node
   is missing or too old, tell the user to install the LTS version from
   https://nodejs.org and stop.

2. **Install dependencies** (first run only): if `node_modules/` does not exist
   in the repository root, run `npm install`.

3. **Start the server**: run `npm start` as a background task from the
   repository root. It prints "SLVR Auto-Staker is running" when ready and
   keeps running — do not wait for it to exit. If it reports the port is
   already in use, the app is already running — just open the URL.

4. **Open the UI**: open http://localhost:4663 in the browser for the user.

5. **Tell the user what to do next**, briefly:
   - First time: create a fresh wallet in the UI (or import a key), ideally
     with a password — the key is stored encrypted in the local
     `wallet.json`. Back it up when shown.
   - Use the **Fund** button to send ETH (and optionally SLVR) over from
     their regular wallet.
   - Create the locked position with an amount **they choose**: **Buy & Lock**
     (spend a set amount of wallet ETH on SLVR and permanently lock it) or
     **Max-lock** (lock SLVR they already hold). The automation never spends
     the wallet balance on its own — mining and buybacks run on *claimed
     rewards* only.
   - Drag the sliders to set the hold / mine / buy-and-lock split and save.
   - The app starts in **dry-run** mode — the DRY RUN / LIVE switch is in
     the header. Click **Start** to claim and compound rewards; keep the
     terminal window open.
   - If the wallet is password-protected, the app asks to unlock it each
     time it starts.

## Notes

- Never ask the user to paste their private key or password into the chat —
  the UI's fields are the only place they should go.
- To stop the app, stop the background `npm start` task (Ctrl+C in its
  terminal).
- `npm run status` prints a terminal summary; `npm run check` verifies the
  chain connection without a wallet.
