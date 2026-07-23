/**
 * The headless application core — every operation the app can perform, with
 * no HTTP, HTML, or terminal attached. `server.ts` is one thin presentation
 * layer over this file; a Telegram bot, Discord bot, CLI, or scheduler can
 * import these same functions and get identical behavior (same guards, same
 * safety rails, same logging, same state files).
 *
 *   getState()          everything a dashboard or bot status command shows
 *   getSeries()         chart/time-series data (live buffer + SQLite buckets)
 *   updateConfig()      merge + validate + save settings
 *   startAutomation()   guarded start (throws UserError with a friendly message)
 *   stopAutomation()    stop and stay stopped across restarts
 *   runOnce()           fire a single cycle in the background
 *   maxLock()           permanently lock wallet SLVR into the veNFT
 *   subscribeLog()      live activity feed — push each line to chat, logs, etc.
 *   boot()              monitor + auto-resume + price backfill (call once)
 *
 * Wallet operations (create/import/unlock/reveal/export/restore) live in
 * `./keystore` — import them directly; they are already presentation-free.
 *
 * Errors: anything user-caused (bad input, wrong app state) throws UserError
 * whose message is safe to show verbatim. Everything else is unexpected.
 */
import { formatEther, parseEther, isAddress, getAddress, parseAbi } from 'viem';
import {
  DATA_DIR,
  PROFILE,
  DEFAULTS,
  PRESETS,
  hasConfig,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  type AppConfig,
  type PresetName,
} from './config';
import { readOnlyCtx, walletCtx, ADDRESSES, lotteryFor, lotteryAddressFor } from './chain';
import { allMiningStrategies, allMiningStrategyMeta } from './strategies';
import { getPosition, listPositions, lockExpired, maxLockSlvr } from './position';
import { buySlvr, quoteBuy } from './swap';
import { runCycle } from './cycle';
import { GAS_RESERVE_WEI, spendable } from './budget';
import { miningPlan } from './mining';
import { earliestPriceTs, earnedSeriesSince, insertPriceHistory, logEvent, logSnapshot, metrics, recentEvents, recentSnapshots, seriesSince, type SeriesKey } from './db';
import { keyStatus } from './keystore';

/** An error caused by user input or app state — its message is written for humans and safe to show as-is. */
export class UserError extends Error {}

/** Warn the user when the miner wallet's gas drops below this. */
const LOW_GAS_WEI = parseEther('0.002');

/** Fee-split views not wrapped by the SDK — read directly off the lottery. */
const FEE_SPLIT_ABI = parseAbi([
  'function stakerFeeBps() view returns (uint16)',
  'function jackpotFeeBps() view returns (uint16)',
]);

// ---- activity log ----------------------------------------------------------

type LogListener = (line: string) => void;
const logListeners = new Set<LogListener>();

/**
 * Subscribe to the live activity feed (the same lines the web UI shows).
 * Returns an unsubscribe function. A bot can forward these to a chat.
 */
export function subscribeLog(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

function uiLog(line: string): void {
  console.log(line);
  automation.lastLog.push(line);
  if (automation.lastLog.length > 80) automation.lastLog.splice(0, automation.lastLog.length - 80);
  for (const listener of logListeners) {
    try {
      listener(line);
    } catch {
      // a broken subscriber must never break the app
    }
  }
}

// ---- live chart buffer -----------------------------------------------------

/**
 * The LIVE chart buffer: seconds-resolution readings kept in memory only.
 * Fed by every getState() call (~5s while a UI is open); ~20 minutes deep.
 * SQLite keeps the 30s history for the longer ranges — this is just the
 * high-frequency tip.
 */
interface LivePoint {
  t: number;
  pending: number;
  balance: number;
  slvr: number;
  locked: number;
  price: number | null;
}
const liveBuffer: LivePoint[] = [];
/** Last nonzero wallet balance, to ride out transient RPC zero-reads. */
let lastGoodEthWei = 0n;
let lastGoodEthTs = 0;
function pushLive(p: Omit<LivePoint, 't'>): void {
  const t = Math.floor(Date.now() / 1000);
  const last = liveBuffer[liveBuffer.length - 1];
  if (last && t - last.t < 4) return; // throttle to ~1 point / 4s
  liveBuffer.push({ t, ...p });
  if (liveBuffer.length > 300) liveBuffer.splice(0, liveBuffer.length - 300);
}

const SERIES_RANGES: Record<string, { sinceSec: number; bucket: number }> = {
  '1h': { sinceSec: 3600, bucket: 30 },
  '1d': { sinceSec: 86400, bucket: 600 },
  '1w': { sinceSec: 604800, bucket: 3600 },
};

/**
 * Time-series data for charts: `range` is 'live' (past hour, mixed
 * seconds-level buffer + history backbone) or '1h' / '1d' / '1w' (SQLite
 * buckets). Values are whole units (ETH / SLVR), price is SLVR in ETH.
 */
export function getSeries(seriesKey: string, range: string): { points: Array<{ t: number; v: number }>; resolution: string } {
  const LIVE_KEYS: Record<string, (p: LivePoint) => number | null> = {
    pending: (p) => p.pending, balance: (p) => p.balance, slvr: (p) => p.slvr,
    locked: (p) => p.locked, price: (p) => p.price,
  };
  // 'earned' is a derived, cumulative series (pending + everything claimed so
  // far) — always DB-sourced (claims are events, not in the live buffer), so
  // it's computed the same way for every range.
  if (seriesKey === 'earned') {
    const sinceSec = range === 'live' ? 3600 : (SERIES_RANGES[range]?.sinceSec ?? 3600);
    const bucket = range === 'live' ? 30 : (SERIES_RANGES[range]?.bucket ?? 30);
    const since = Math.floor(Date.now() / 1000) - sinceSec;
    const points = earnedSeriesSince(since, bucket).map((p) => ({ t: p.t, v: p.v / 1e18 }));
    return { points, resolution: range === 'live' ? '30s' : `${bucket}s` };
  }
  if (!(seriesKey in LIVE_KEYS)) throw new UserError('unknown series');
  if (range === 'live') {
    // LIVE = the past hour: history backbone (30s snapshots + backfilled
    // minute candles for price) with the seconds-level buffer on the tip —
    // rich enough to be useful, live enough to move.
    const since = Math.floor(Date.now() / 1000) - 3600;
    const get = LIVE_KEYS[seriesKey]!;
    // snapshot wei columns arrive as wei floats — normalize to whole units so
    // they share a scale with the live buffer (price is already in ETH)
    let dbPoints = seriesSince(seriesKey as SeriesKey, since, 30);
    if (seriesKey !== 'price') dbPoints = dbPoints.map((p) => ({ t: p.t, v: p.v / 1e18 }));
    const livePoints = liveBuffer
      .filter((p) => p.t >= since)
      .map((p) => ({ t: p.t, v: get(p) }))
      .filter((p): p is { t: number; v: number } => p.v != null && Number.isFinite(p.v));
    const points = [...dbPoints, ...livePoints].sort((a, b) => a.t - b.t);
    return { points, resolution: 'mixed ~5-60s' };
  }
  const spec = SERIES_RANGES[range];
  if (!spec) throw new UserError('unknown range (use live, 1h, 1d, 1w)');
  const since = Math.floor(Date.now() / 1000) - spec.sinceSec;
  let points = seriesSince(seriesKey as SeriesKey, since, spec.bucket);
  // snapshot wei columns arrive as wei floats — normalize everything to whole units
  if (seriesKey !== 'price') points = points.map((p) => ({ t: p.t, v: p.v / 1e18 }));
  return { points, resolution: `${spec.bucket}s` };
}

// ---- automation loop -------------------------------------------------------

const automation = {
  running: false,
  timer: undefined as NodeJS.Timeout | undefined,
  busy: false,
  lastLog: [] as string[],
};

async function cycleOnce(): Promise<void> {
  if (automation.busy) return; // never overlap cycles
  automation.busy = true;
  try {
    const cfg = loadConfig(); // re-read every tick so UI edits apply immediately
    const ctx = walletCtx();
    uiLog(`[${new Date().toLocaleTimeString()}] cycle${cfg.live ? ' (LIVE)' : ' (dry-run)'}`);
    await runCycle(ctx, cfg, uiLog);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    uiLog(`  ✗ cycle error: ${msg}`);
    logEvent('error', { detail: msg });
  } finally {
    automation.busy = false;
  }
}

/**
 * Start the automation loop. Throws UserError (with a message ready to show
 * the user) when the app isn't ready: no wallet, locked wallet, or no saved
 * settings. The automation NEVER auto-creates a position or spends your
 * deposit — it adopts a veNFT the wallet already owns and otherwise runs on
 * CLAIMED REWARDS ONLY. You create the position explicitly with Buy & Lock /
 * Max-lock, so it can run before a position exists (it just waits for one).
 */
export function startAutomation(): void {
  const ks = keyStatus();
  if (!ks.exists) throw new UserError('Create or import a wallet first.');
  if (ks.locked) throw new UserError('The wallet is locked — unlock it with your password first.');
  if (!hasConfig()) throw new UserError('Save your settings first.');
  if (automation.running) return;
  automation.running = true;
  // Fresh feed for every run: the activity panel resets at each start so
  // dry-run rehearsal lines never mix with a LIVE run. Nothing is lost —
  // the full history lives in the database (History page).
  automation.lastLog = [];
  uiLog(safeConfig()?.live
    ? '▶ automation started — LIVE: real transactions from here on'
    : '▶ automation started — dry-run: decisions are shown, nothing is sent');
  // Remember across restarts: if the app (or the computer) goes down, the
  // next launch resumes the loop from the state files automatically.
  const state = loadState();
  if (!state.autoResume) {
    state.autoResume = true;
    saveState(state);
  }
  const tick = async () => {
    if (!automation.running) return;
    await cycleOnce();
    if (!automation.running) return;
    const cfg = safeConfig();
    automation.timer = setTimeout(tick, (cfg?.intervalSeconds ?? 30) * 1000);
  };
  void tick();
}

export function stopAutomation(): void {
  if (automation.running) uiLog('⏹ automation stopped');
  automation.running = false;
  if (automation.timer) clearTimeout(automation.timer);
  automation.timer = undefined;
  // An explicit stop means "stay stopped", including across restarts.
  const state = loadState();
  if (state.autoResume) {
    state.autoResume = false;
    saveState(state);
  }
}

/** Fire a single cycle in the background (returns immediately). */
export function runOnce(): void {
  if (!hasConfig()) throw new UserError('Save your key and settings first.');
  void cycleOnce();
}

/** Resume the loop after a restart, if it was running when the app went down. */
export function maybeResume(context: string): void {
  if (automation.running) return;
  const state = loadState();
  if (!state.autoResume) return;
  const ks = keyStatus();
  if (!ks.exists || !hasConfig()) return;
  if (ks.locked) {
    uiLog('⏸ automation was running before the restart — it will resume once you unlock the wallet.');
    return;
  }
  uiLog(`▶ resuming automation (${context}) — picking up from the saved state files.`);
  startAutomation();
}

function safeConfig(): AppConfig | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}

// ---- settings --------------------------------------------------------------

/**
 * Merge a partial settings object into the saved config, validate, and save.
 * Unknown fields are ignored; missing fields keep their current values.
 * Throws UserError with a human-readable message on invalid input.
 */
/** Merge a partial strategyParams patch into the current map, keeping only finite numbers. */
function mergeStrategyParams(current: Record<string, number>, patch: unknown): Record<string, number> {
  const merged: Record<string, number> = { ...(current ?? {}) };
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) merged[k] = n;
    }
  }
  return merged;
}

export function updateConfig(body: Record<string, unknown>): AppConfig {
  const current = safeConfig() ?? ({ ...DEFAULTS, tokenId: '' } as AppConfig);
  const next: AppConfig = {
    ...current,
    tokenId: String(body.tokenId ?? current.tokenId),
    holdPct: Number(body.holdPct ?? current.holdPct),
    minePct: Number(body.minePct ?? current.minePct),
    buybackPct: Number(body.buybackPct ?? current.buybackPct),
    buybackMode: body.buybackMode === 'smart' || (body.buybackMode === undefined && current.buybackMode === 'smart') ? 'smart' : 'instant',
    allocationMode: body.allocationMode === 'fixed' || (body.allocationMode === undefined && current.allocationMode === 'fixed') ? 'fixed' : 'auto',
    buybackDipPct: Number(body.buybackDipPct ?? current.buybackDipPct),
    buybackLookbackMin: Number(body.buybackLookbackMin ?? current.buybackLookbackMin),
    maxBuybackPerCycleEth: Number(body.maxBuybackPerCycleEth ?? current.maxBuybackPerCycleEth),
    buybackMaxWaitHours: Number(body.buybackMaxWaitHours ?? current.buybackMaxWaitHours),
    maxBuybackPriceImpactPct: Number(body.maxBuybackPriceImpactPct ?? current.maxBuybackPriceImpactPct),
    buybackMinIntervalMin: Number(body.buybackMinIntervalMin ?? current.buybackMinIntervalMin),
    maxEthPerBuy: Number(body.maxEthPerBuy ?? current.maxEthPerBuy),
    maxBuysPerDay: Number(body.maxBuysPerDay ?? current.maxBuysPerDay),
    maxDailySpendEth: Number(body.maxDailySpendEth ?? current.maxDailySpendEth),
    holdWalletAddress: String(body.holdWalletAddress ?? current.holdWalletAddress).trim(),
    minClaimEth: Number(body.minClaimEth ?? current.minClaimEth),
    mineOnlyWhenProfitable: Boolean(body.mineOnlyWhenProfitable ?? current.mineOnlyWhenProfitable),
    miningStrategy: String(body.miningStrategy ?? current.miningStrategy ?? '').trim(),
    minEdgePct: Number(body.minEdgePct ?? current.minEdgePct),
    maxPotEth: Number(body.maxPotEth ?? current.maxPotEth),
    minSecondsLeft: Number(body.minSecondsLeft ?? current.minSecondsLeft),
    valueSlvrAsCashOut: Boolean(body.valueSlvrAsCashOut ?? current.valueSlvrAsCashOut),
    maxMinePerRoundEth: Number(body.maxMinePerRoundEth ?? current.maxMinePerRoundEth),
    minePace: (['large', 'balanced', 'small'] as const).includes(body.minePace as any) ? (body.minePace as AppConfig['minePace']) : current.minePace,
    strategyParams: mergeStrategyParams(current.strategyParams, body.strategyParams),
    rpcUrl: String(body.rpcUrl ?? current.rpcUrl).trim(),
    slippagePct: Number(body.slippagePct ?? current.slippagePct),
    restakeMinedSlvr: Boolean(body.restakeMinedSlvr ?? current.restakeMinedSlvr),
    intervalSeconds: Number(body.intervalSeconds ?? current.intervalSeconds),
    live: Boolean(body.live ?? current.live),
  };
  if (next.holdWalletAddress && !isAddress(next.holdWalletAddress)) {
    throw new UserError('Hold wallet address is not a valid address.');
  }
  if (next.rpcUrl && !/^https?:\/\/.+/.test(next.rpcUrl)) {
    throw new UserError('RPC URL must start with http:// or https:// (or be empty for the public RPC).');
  }
  if (next.holdWalletAddress) next.holdWalletAddress = getAddress(next.holdWalletAddress);
  try {
    saveConfig(next);
  } catch (err) {
    throw new UserError(err instanceof Error ? err.message : String(err));
  }
  return next;
}

// ---- actions ---------------------------------------------------------------

/**
 * Permanently lock wallet SLVR into the veNFT (creates one if needed).
 * `amountSlvr` is a decimal string or 'all'. Throws UserError for input/state
 * problems; execution failures bubble up as plain Errors.
 */
export async function maxLock(amountSlvr: string): Promise<{ tokenId: string; dryRun?: boolean }> {
  const ks = keyStatus();
  if (!ks.exists) throw new UserError('Create or import a wallet first.');
  if (ks.locked) throw new UserError('The wallet is locked — unlock it first.');
  const ctx = walletCtx();
  const balance = await ctx.sdk.token.balanceOf(ctx.account.address);
  let amount: bigint;
  if (amountSlvr === 'all') {
    amount = balance;
  } else {
    try {
      amount = parseEther(String(amountSlvr));
    } catch {
      throw new UserError('Invalid SLVR amount.');
    }
  }
  if (amount <= 0n) throw new UserError('Nothing to lock — the wallet holds no SLVR.');
  if (amount > balance) throw new UserError(`The wallet only holds ${formatEther(balance)} SLVR.`);
  // Dry-run simulates — no on-chain action. Only LIVE mode actually locks.
  const cfg = safeConfig();
  if (!cfg?.live) {
    uiLog(`  🧪 [dry-run] would permanently max-lock ${formatEther(amount)} SLVR — nothing sent. Switch to LIVE to execute.`);
    return { tokenId: cfg?.tokenId || '', dryRun: true };
  }
  const tokenId = await maxLockSlvr(ctx, amount);
  logEvent('max_lock', { slvrWei: amount, detail: `manual, veNFT #${tokenId}` });
  uiLog(`  ✅ max-locked ${formatEther(amount)} SLVR (veNFT #${tokenId})`);
  return { tokenId: tokenId.toString() };
}

/**
 * Buy SLVR with wallet ETH and zap it straight into the veNFT (permanent
 * max-lock). One click: ETH → SLVR → locked position. `amountEth` is a decimal
 * string or 'all' (all spendable ETH above the gas reserve). Creates the
 * position if there isn't one yet.
 */
export async function buyAndLock(amountEth: string): Promise<{ tokenId: string; slvrLockedWei: string; dryRun?: boolean }> {
  const ks = keyStatus();
  if (!ks.exists) throw new UserError('Create or import a wallet first.');
  if (ks.locked) throw new UserError('The wallet is locked — unlock it first.');
  const ctx = walletCtx();
  const cfg = safeConfig() ?? DEFAULTS;
  const budget = await spendable(ctx);
  let amount: bigint;
  if (amountEth === 'all') {
    amount = budget;
  } else {
    try {
      amount = parseEther(String(amountEth));
    } catch {
      throw new UserError('Invalid ETH amount.');
    }
  }
  if (amount <= 0n) throw new UserError('Enter an ETH amount to buy with.');
  if (amount > budget) {
    throw new UserError(`Only ${formatEther(budget)} ETH is spendable (the rest is held as the gas reserve).`);
  }
  // Dry-run simulates — no on-chain action. Only LIVE mode actually buys/locks.
  if (!cfg.live) {
    const { expectedSlvrWei, impactPct } = await quoteBuy(ctx, amount);
    uiLog(`  🧪 [dry-run] would buy ~${formatEther(expectedSlvrWei)} SLVR with ${formatEther(amount)} ETH (~${impactPct.toFixed(2)}% impact) and permanently max-lock it — nothing sent. Switch to LIVE to execute.`);
    return { tokenId: safeConfig()?.tokenId || '', slvrLockedWei: expectedSlvrWei.toString(), dryRun: true };
  }
  uiLog(`  🪙 buying SLVR with ${formatEther(amount)} ETH and locking it into your position…`);
  const { slvrReceived, txHash } = await buySlvr(ctx, amount, cfg.slippagePct);
  logEvent('buyback', { ethWei: amount, slvrWei: slvrReceived, txHash, detail: 'manual buy & lock' });
  if (slvrReceived <= 0n) throw new UserError('The swap returned no SLVR — try again or raise slippage in Settings.');
  const tokenId = await maxLockSlvr(ctx, slvrReceived);
  logEvent('max_lock', { slvrWei: slvrReceived, detail: `buy & lock, veNFT #${tokenId}` });
  uiLog(`  ✅ bought and locked ${formatEther(slvrReceived)} SLVR into veNFT #${tokenId}`);
  return { tokenId: tokenId.toString(), slvrLockedWei: slvrReceived.toString() };
}

/**
 * What a Buy & Lock of `amountEth` would do right now, WITHOUT spending: the
 * expected SLVR out (net of buy tax) and the price impact at that size. The UI
 * shows this before the user confirms an allocation. Read-only — works while
 * the wallet is locked.
 */
export async function estimateBuy(amountEth: string): Promise<{ impactPct: number; expectedSlvrWei: string }> {
  let amount: bigint;
  try {
    amount = parseEther(String(amountEth));
  } catch {
    throw new UserError('Invalid ETH amount.');
  }
  if (amount <= 0n) return { impactPct: 0, expectedSlvrWei: '0' };
  const { expectedSlvrWei, impactPct } = await quoteBuy(readOnlyCtx(), amount);
  return { impactPct, expectedSlvrWei: expectedSlvrWei.toString() };
}

/** The risk presets (Conservative / Neutral / Aggressive) for the UI to render + prefill from. */
export function getPresets(): Record<PresetName, Partial<AppConfig>> {
  return PRESETS;
}

/**
 * Look up a transaction on Robinhood Chain. 'pending' means not mined yet
 * (or unknown hash) — poll until it settles. Fronts use this to track
 * deposits and other user-submitted transactions to completion.
 */
export async function getTxStatus(hash: string): Promise<{ status: 'pending' | 'success' | 'failed' }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new UserError('Invalid transaction hash.');
  const ctx = readOnlyCtx();
  try {
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
    return { status: receipt.status === 'success' ? 'success' : 'failed' };
  } catch {
    return { status: 'pending' };
  }
}

// ---- state -----------------------------------------------------------------

/**
 * The full application state: wallet, position, round, network, config,
 * metrics, events, snapshots, and the activity log — everything any front
 * end needs to render a dashboard or answer a status query. Read-only and
 * works even while an encrypted wallet is still locked.
 */
export async function getState(): Promise<object> {
  const ks = keyStatus();
  const cfg = safeConfig();
  const state = loadState();

  const base = {
    hasKey: ks.exists,
    locked: ks.locked,
    encrypted: ks.encrypted,
    configured: ks.exists && !!cfg,
    config: cfg ?? { ...DEFAULTS, tokenId: '' },
    running: automation.running,
    busy: automation.busy,
    log: automation.lastLog.slice(-40),
    mineBudgetWei: state.mineBudgetWei,
    buybackBudgetWei: state.buybackBudgetWei,
    holdKeptWei: state.holdKeptWei,
    gasReserveWei: GAS_RESERVE_WEI.toString(),
    openMineRounds: state.openMineRounds,
    lowGasWei: LOW_GAS_WEI.toString(),
    tokenAddress: ADDRESSES.token,
    dataDir: DATA_DIR,
    profile: PROFILE,
    miningStrategies: Object.keys(allMiningStrategies()),
    miningStrategyMeta: allMiningStrategyMeta(),
    metrics: metrics(),
    events: recentEvents(40),
    snapshots: recentSnapshots(200),
  };

  if (!ks.exists || !ks.address) return { ...base, wallet: null, positions: [], price: null, round: null, network: null };

  // Everything the dashboard shows is a READ — so it works with just the
  // stored address, even while an encrypted wallet is still locked.
  try {
    const ctx = readOnlyCtx();
    const me = ks.address;
    const roundId = await ctx.sdk.lottery.currentRoundId();
    const [ethWei, slvrWei, positions, price, permanentLockTokenId, round, roundOpen, bettingEnd, block,
           totalWeight, slvrPerRound, protocolFeeBps, stakerFeeBps, jackpotFeeBps] = await Promise.all([
      ctx.publicClient.getBalance({ address: me }),
      ctx.sdk.token.balanceOf(me),
      listPositions(ctx, me),
      ctx.sdk.getSlvrPrice().catch(() => null),
      ctx.voteEscrow.read.getPermanentLockTokenId([me]),
      lotteryFor(ctx, roundId).getRound(roundId),
      lotteryFor(ctx, roundId).roundOpen(roundId),
      lotteryFor(ctx, roundId).bettingEnd(roundId),
      ctx.publicClient.getBlock(),
      ctx.sdk.staking.getTotalWeight(),
      lotteryFor(ctx, roundId).slvrPerRound(),
      lotteryFor(ctx, roundId).protocolFeeBps(),
      ctx.publicClient.readContract({ address: lotteryAddressFor(roundId), abi: FEE_SPLIT_ABI, functionName: 'stakerFeeBps' }).catch(() => 0),
      ctx.publicClient.readContract({ address: lotteryAddressFor(roundId), abi: FEE_SPLIT_ABI, functionName: 'jackpotFeeBps' }).catch(() => 200),
    ]);
    const secondsLeft = Number(bettingEnd - block.timestamp);
    const plan = cfg ? await miningPlan(ctx, cfg, state, roundId).catch(() => null) : null;

    // Guard the wallet balance against transient RPC zero-reads: the public
    // RPC sometimes returns 0 for a funded wallet, which flashes "0 ETH" on
    // the card and dips the chart. Carry the last known value forward for a
    // few minutes; a genuine drain persists past the window and shows through.
    const nowSec = Math.floor(Date.now() / 1000);
    if (ethWei > 0n) { lastGoodEthWei = ethWei; lastGoodEthTs = nowSec; }
    const ethWeiSafe = ethWei === 0n && lastGoodEthWei > 0n && nowSec - lastGoodEthTs < 300 ? lastGoodEthWei : ethWei;

    // Auto-adopt a position for the dashboard: if no veNFT is selected yet but
    // the wallet already owns a staking position (just after onboarding, or an
    // imported/restored wallet), select it now so the position, earnings, and
    // chart populate immediately — instead of waiting for the first automation
    // cycle to adopt it. Mirrors adoptExistingPosition() in cycle.ts. `cfg` is
    // the same object returned in `base.config`, so this poll already reflects it.
    if (cfg && !cfg.tokenId) {
      const owned = positions.find((p) => p.lockedSlvr > 0n);
      if (owned) {
        cfg.tokenId = owned.tokenId.toString();
        try { saveConfig(cfg); } catch { /* non-fatal — still surfaced in this response */ }
      }
    }

    // feed the LIVE chart buffer from this poll's readings
    const cfgPos = positions.find((p) => p.tokenId.toString() === cfg?.tokenId);
    pushLive({
      pending: Number(formatEther(cfgPos?.pendingRewardsWei ?? 0n)),
      balance: Number(formatEther(ethWeiSafe)),
      slvr: Number(formatEther(slvrWei)),
      locked: Number(formatEther(cfgPos?.lockedSlvr ?? 0n)),
      price: price?.eth ?? null,
    });

    return {
      round: {
        id: roundId.toString(),
        potWei: round.totalWager.toString(),
        open: roundOpen,
        secondsLeft: secondsLeft > 0 ? secondsLeft : 0,
      },
      network: {
        totalWeightWei: totalWeight.toString(),
        slvrPerRoundWei: slvrPerRound.toString(),
        protocolFeeBps: Number(protocolFeeBps),
        /** share of the protocol fee that goes to stakers, in bps of the fee (0 = derive from jackpot split) */
        stakerFeeBps: Number(stakerFeeBps),
        /** jackpot's cut in bps of the total wager */
        jackpotFeeBps: Number(jackpotFeeBps),
      },
      ...base,
      wallet: { address: me, ethWei: ethWeiSafe.toString(), slvrWei: slvrWei.toString() },
      positions: positions.map((p) => ({
        tokenId: p.tokenId.toString(),
        lockedSlvrWei: p.lockedSlvr.toString(),
        lockEnd: p.lockEnd.toString(),
        permanent: p.permanent,
        isMaxTime: p.isMaxTime,
        staked: p.stakedWeight > 0n,
        stakedWeightWei: p.stakedWeight.toString(),
        expired: lockExpired(p),
        pendingEthWei: p.pendingRewardsWei.toString(),
      })),
      permanentLockTokenId: permanentLockTokenId.toString(),
      price,
      minePlan: plan && {
        stakeWei: plan.stakeWei.toString(),
        minStakeWei: plan.minStakeWei.toString(),
        spacingSec: Math.round(plan.spacingSec),
        roundsAffordable: plan.roundsAffordable,
        horizonSec: Math.round(plan.horizonSec),
        blockedByCap: plan.blockedByCap,
      },
    };
  } catch (err) {
    return { ...base, wallet: { address: ks.address, ethWei: '0', slvrWei: '0' }, positions: [], price: null, round: null, network: null, chainError: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

// ---- background services ---------------------------------------------------

/**
 * Backfill SLVR price history from GeckoTerminal so the price chart is useful
 * from the very first launch (minute candles for 1H/LIVE context, hourly for
 * 1D). Quote-token pricing = price in ETH, same unit as our own readings.
 * Best-effort: failures are logged and skipped, never fatal.
 */
export async function backfillPriceHistory(): Promise<void> {
  try {
    if (!ADDRESSES.slvrEthPair) return;
    const now = Math.floor(Date.now() / 1000);
    const earliest = earliestPriceTs();
    if (earliest && now - earliest > 20 * 3600) return; // already have deep history
    const pool = ADDRESSES.slvrEthPair.toLowerCase();
    const base = `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv`;
    const fetchCandles = async (tf: string, limit: number) => {
      const res = await fetch(`${base}/${tf}?aggregate=1&limit=${limit}&currency=token`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return [] as Array<{ ts: number; priceEth: number }>;
      const body = (await res.json()) as any;
      const list: Array<[number, number, number, number, number, number]> =
        body?.data?.attributes?.ohlcv_list ?? [];
      return list.map(([ts, , , , close]) => ({ ts, priceEth: close }));
    };
    const [minutes, hours] = await Promise.all([fetchCandles('minute', 1000), fetchCandles('hour', 100)]);
    const inserted = insertPriceHistory([...hours, ...minutes]);
    if (inserted > 0) uiLog(`📈 backfilled ${inserted} SLVR price points from market history`);
  } catch (err) {
    console.warn('price backfill skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Background monitor: records a balances/rewards snapshot every 30s while the
 * app runs (skipped when a cycle is mid-flight — cycles snapshot themselves).
 * This is what keeps the chart moving even when the automation is stopped.
 */
export function startMonitor(): void {
  const tick = async () => {
    try {
      const ks = keyStatus();
      if (!ks.exists || !ks.address || automation.busy) return;
      const ctx = readOnlyCtx();
      const me = ks.address;
      const cfg = safeConfig();
      const tokenId = cfg?.tokenId ? BigInt(cfg.tokenId) : undefined;
      const [ethBal, slvrBal, price, position] = await Promise.all([
        ctx.publicClient.getBalance({ address: me }),
        ctx.sdk.token.balanceOf(me),
        ctx.sdk.getSlvrPrice().catch(() => null),
        tokenId !== undefined ? getPosition(ctx, tokenId).catch(() => null) : Promise.resolve(null),
      ]);
      logSnapshot({
        pendingEthWei: (position?.pendingRewardsWei ?? 0n).toString(),
        ethBalanceWei: ethBal.toString(),
        slvrBalanceWei: slvrBal.toString(),
        lockedSlvrWei: (position?.lockedSlvr ?? 0n).toString(),
        slvrPriceEth: price?.eth ?? null,
      });
    } catch {
      // RPC hiccup — try again next tick
    }
  };
  setInterval(tick, 30_000);
  void tick();
}

/**
 * Bring the core online: resume the loop if it was running before the last
 * shutdown, start the 30s snapshot monitor, and backfill price history.
 * Call exactly once, from whichever front end hosts the app.
 */
export function boot(context: string): void {
  maybeResume(context);
  startMonitor();
  void backfillPriceHistory();
}
