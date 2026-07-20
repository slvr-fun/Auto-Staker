---
name: autostaker-status
description: Check on the SLVR Auto-Staker — is it running, earning, funded? Use when the user asks "how's my staker doing", "is it running", "what has it earned", or any health/status question about the app.
---

# Auto-staker status check

Give the user a friendly, plain-English health report. Never ask for or
display private keys or passwords.

## Steps

1. Check whether the app's server is running:
   `curl -s http://localhost:4663/api/state` — if it fails, the app isn't
   running; offer to start it (see the `slvr-autostaker` skill) and stop.

2. From the JSON, report in plain English:
   - **Running?** `running` + `config.live` → "running in dry-run" /
     "running LIVE" / "stopped"
   - **Locked?** if `locked` is true → they need to unlock in the UI
   - **Funded?** `wallet.ethWei` vs `lowGasWei` → warn if low, suggest the
     Fund button
   - **Earning:** the selected position's `pendingEthWei` (unclaimed), and
     `metrics` lifetime totals (ETH claimed, SLVR bought/locked/mined)
   - **Anything odd:** recent `error` entries in `events`, or `chainError`

3. If the server isn't up but they just want history, `npm run status` in the
   repo prints a terminal summary (works without the UI).

Keep it to a short paragraph plus at most 3 bullet numbers. Suggest ONE next
action (fund it / unlock it / start it / nothing needed).
