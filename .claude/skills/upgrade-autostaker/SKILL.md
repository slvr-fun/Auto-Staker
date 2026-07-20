---
name: upgrade-autostaker
description: Pull the latest SLVR Auto-Staker template updates into this copy — safely, even if the user has forked, made local changes, or installed from a zip without git. Use when the user asks to update, upgrade, or "get the latest version" of the app.
---

# Upgrade this copy from the template

Merges updates from the upstream template
(`https://github.com/slvr-fun/Auto-Staker`) while preserving the
user's local modifications and never touching their data. Works for git
clones, GitHub forks, AND zip installs — pick the right path below.

## Guarantees to uphold

- **User data survives untouched**: the wallet, settings, state, and
  history live in the OS app-data folder (`~/Library/Application Support/
  slvr-autostaker` on macOS, `%APPDATA%\slvr-autostaker` on Windows,
  `~/.local/share/slvr-autostaker` on Linux) — completely outside this
  repo, so no upgrade step may ever write there. If legacy `wallet.json`
  / `config.json` / `state.json` / `data.sqlite*` / `.env` files exist in
  the repo folder, never modify, delete, or commit them.
- **Local code changes survive**: merge, never reset or force-checkout.
  `src/strategies.custom.ts` belongs to the user — NEVER overwrite it.
  If the user customized other files, their intent wins — integrate the
  upstream change around it.
- **The app must work afterwards** — an upgrade isn't done until verified.

## Pick the path

Run `git --version` and `git rev-parse --git-dir` (in the app folder):

- git installed + folder is a repo → **Path A** (normal).
- git installed + folder is NOT a repo (zip install) → **Path B** (adopt
  git, then merge — one-time conversion, best long-term).
- no git at all → **Path C** (zip overlay).

## Path A — git merge (clones and forks)

1. **Snapshot**: if the working tree is dirty,
   `git add -A && git commit -m "local changes before upgrade"`.
2. **Pick the remote to pull from.** Run `git remote -v` and look for one
   already pointing at `slvr-fun/Auto-Staker` (any protocol — an
   `https://…` URL or an SSH form like `git@…:slvr-fun/Auto-Staker`).
   - If a remote already points there (commonly `origin` when the user
     cloned this repo directly): use it — call it `$SRC`. No new remote
     needed, and it keeps whatever auth already works (SSH keys included).
   - If none does (e.g. `origin` is the user's own fork): add the template
     as `upstream` and use that as `$SRC`:
     `git remote add upstream https://github.com/slvr-fun/Auto-Staker.git`.
     Heads up: this HTTPS URL only fetches if the template repo is public
     (or the user has access). If `git fetch` returns "Repository not
     found", the repo isn't public yet — tell the user; you can't upgrade
     over HTTPS until it is (or fall back to Path C with a zip they can
     access).
3. **Fetch + read the notes BEFORE merging**: `git fetch $SRC`, then
   `git diff HEAD $SRC/main -- UPGRADES.md` — the new entries at the top are
   the upgrade notes. Summarize them (what's new, any "User action
   required", conflict-prone areas) and confirm before proceeding.
4. **Merge**: `git merge $SRC/main --no-edit`. Resolve conflicts file by
   file: keep the user's customization AND apply the upstream improvement
   around it. For `public/index.html` conflicts too tangled to merge, prefer
   upstream and re-apply the user's customization on top (ask what it was if
   unclear). Never silently discard a user change.
5. **Verify** (below), then report.

## Path B — zip install, git available

Convert once, then it's Path A forever:

1. `git init && git add -A && git commit -m "my copy before first upgrade"`
   — the snapshot makes everything reversible.
2. Continue from Path A step 2, adding `--allow-unrelated-histories` to
   the merge command this one time.

## Path C — no git at all (zip overlay)

1. **Download the latest template** without git:
   `curl -L -o /tmp/slvr-upgrade.zip https://github.com/slvr-fun/Auto-Staker/archive/refs/heads/main.zip`
   and unzip it to a temp folder (`unzip` on macOS/Linux,
   `Expand-Archive` on Windows PowerShell).
2. **Read the notes first**: compare the temp copy's `UPGRADES.md` with
   the local one — the new top entries are the notes. Summarize and
   confirm before changing anything.
3. **Overlay file by file** (never bulk-copy the whole folder):
   - Skip entirely: `src/strategies.custom.ts` and any legacy data files.
   - For each remaining file, diff local vs upstream. Identical → skip.
     Local matches an older template version (user never touched it) →
     copy the upstream file in. User-customized → merge by hand with
     Edit: apply the upstream improvements around the user's changes.
   - Add new upstream files; do not delete local extra files.
4. **Verify** (below), then report. Suggest installing git for smoother
   future upgrades, but never require it.

## Verify — all paths, all of:

- `npm install` (dependencies may have changed)
- `npx tsc --noEmit` and `npm run check:ui`
- `npm run check`
- restart `npm start`, reload the UI, confirm the dashboard renders and
  (if they use it) the automation still starts in dry-run.

## Report

The upgrade notes that applied, any conflicts/customizations and how you
resolved them, and the verification results. Remind them their wallet,
settings, and history live in the app-data folder and were untouched.

## If anything breaks

Path A/B: `git merge --abort` (mid-merge) or
`git reset --hard <pre-upgrade commit>` — the snapshot commit is the
anchor. Path C: restore the files you changed from the diffs you took;
user data was never in scope, so it's safe throughout.
