/**
 * Configuration + persistent state for the auto-staker.
 *
 * Files, all in the OS app-data dir (see DATA_DIR below), per profile:
 *   wallet.json   — the wallet key, encrypted at rest when a password is set
 *                   (managed by keystore.ts; .env is a legacy import path only)
 *   config.json   — the user's choices (splits, thresholds, live/dry-run)
 *   state.json    — running ledger (ETH earmarked for mining but not yet bet)
 *   data.sqlite   — earnings & activity history (see db.ts)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const APP_DIR = join(__dirname, '..');
export const ENV_PATH = join(APP_DIR, '.env');

/**
 * User data lives in the OS's standard application-data directory — NOT the
 * repo folder — so it survives re-clones, upgrades, and moving the code, and
 * works identically on macOS, Windows, and Linux:
 *
 *   macOS    ~/Library/Application Support/slvr-autostaker
 *   Windows  %APPDATA%\slvr-autostaker
 *   Linux    $XDG_DATA_HOME/slvr-autostaker (default ~/.local/share/…)
 *
 * Each profile is its own subfolder with its own wallet, settings, and
 * history — run with SLVR_PROFILE=name to manage multiple accounts
 * (default profile: "default").
 */
function resolveDataDir(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'slvr-autostaker')
      : process.platform === 'win32'
        ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'slvr-autostaker')
        : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'slvr-autostaker');
  return join(base, 'profiles', PROFILE);
}

export const PROFILE = (process.env.SLVR_PROFILE || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
export const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });

export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const DB_PATH = join(DATA_DIR, 'data.sqlite');
export const WALLET_PATH = join(DATA_DIR, 'wallet.json');

// One-time migration: earlier versions kept user files in the repo folder.
// Move them into the data dir so nothing is lost on upgrade.
for (const name of ['wallet.json', 'config.json', 'state.json', 'data.sqlite']) {
  const legacy = join(APP_DIR, name);
  const target = join(DATA_DIR, name);
  if (existsSync(legacy) && !existsSync(target)) {
    try {
      renameSync(legacy, target);
    } catch {
      copyFileSync(legacy, target);
      unlinkSync(legacy);
    }
    console.log(`(migrated ${name} → ${target})`);
  }
}

/** The local web UI listens here (chosen to match Robinhood Chain's id). */
export const UI_PORT = 4663;

export interface AppConfig {
  /** The veNFT tokenId whose ETH rewards this app claims. */
  tokenId: string;
  /** % of each claim transferred to the hold wallet (or kept if none set). */
  holdPct: number;
  /** % of each claim used to mine SLVR (grid bets in the lottery). */
  minePct: number;
  /** % of each claim used to buy SLVR and max-lock it. */
  buybackPct: number;
  /**
   * How the buyback share is spent:
   *  - 'instant': market-buy immediately after each claim
   *  - 'smart': accumulate a budget and buy into sell pressure — only when the
   *    price dips below its recent average (with a time-based safety valve so
   *    the budget never waits forever)
   */
  buybackMode: 'instant' | 'smart';
  /**
   * How the non-hold share is split:
   *  - 'auto': price-aware — each claim routes to MINING when the round is
   *    profitable to mine, otherwise to BUYBACKS (the slider split is ignored)
   *  - 'fixed': always use the mine/buyback slider percentages
   */
  allocationMode: 'auto' | 'fixed';
  /** Smart mode: buy when price is at least this % below its recent average. */
  buybackDipPct: number;
  /** Smart mode: the moving-average lookback, in minutes. */
  buybackLookbackMin: number;
  /** Smart mode: max ETH spent per cycle (spreads big budgets over time). */
  maxBuybackPerCycleEth: number;
  /** Smart mode: buy regardless after the budget has waited this many hours. */
  buybackMaxWaitHours: number;
  /**
   * Max price impact a single buyback may cause, in percent. The trade is
   * capped (reduced) so it never moves the SLVR price more than this — so a
   * big budget is deployed in measured slices instead of one market-moving
   * buy. 0 = no cap.
   */
  maxBuybackPriceImpactPct: number;
  /** Don't buy back more often than once per this many minutes (rate limit). */
  buybackMinIntervalMin: number;
  /**
   * Hard ceiling on any single AUTOMATED buyback, in ETH. Applies to every
   * automated buy path (instant + smart). Does NOT limit the manual Buy & Lock
   * button (that's your own explicit, confirmed allocation). 0 = no cap.
   */
  maxEthPerBuy: number;
  /** Max number of automated buybacks in any rolling 24h window. 0 = no cap. */
  maxBuysPerDay: number;
  /**
   * Max total ETH the automation may spend in any rolling 24h window, across
   * mining bets AND buybacks combined. A daily ceiling on how fast claimed
   * rewards are put to work. Does NOT limit manual Buy & Lock. 0 = no cap.
   */
  maxDailySpendEth: number;
  /** Where the hold % is sent. Empty = stays in the running wallet. */
  holdWalletAddress: string;
  /** Don't claim until at least this much ETH has accrued. */
  minClaimEth: number;
  /** Mining strategy master switch: gate bets on expected value, or bet every round. */
  mineOnlyWhenProfitable: boolean;
  /**
   * Named mining strategy override (a key from strategies.ts / your
   * strategies.custom.ts). Empty = derived from mineOnlyWhenProfitable.
   */
  miningStrategy: string;
  /**
   * Minimum edge required to mine, as a % of the stake (EV-gated mode only).
   * 0 = any positive-EV round qualifies; 2 = require net EV ≥ 2% of the stake.
   */
  minEdgePct: number;
  /** Only mine while the round's pot is below this many ETH. 0 = no cap. */
  maxPotEth: number;
  /** Need at least this many seconds left in the betting window to bet. */
  minSecondsLeft: number;
  /**
   * How the EV model values mined SLVR: false = at full price (you hold/stake
   * it), true = net of the refining fee (you intend to cash out to ETH).
   */
  valueSlvrAsCashOut: boolean;
  /** Cap on ETH committed to any single mining round. */
  maxMinePerRoundEth: number;
  /**
   * Mining pace: how the budget is split into bets before the next claim tops
   * it up. Fewer, larger bets have lower gas drag; more, smaller bets spread
   * risk. Maps to a target number of bets in mining.ts.
   */
  minePace: 'large' | 'balanced' | 'small';
  /** Per-strategy tunable parameters, keyed by the param's `key` (see strategies.ts). */
  strategyParams: Record<string, number>;
  /** Max price slippage tolerated when buying SLVR, in percent. */
  slippagePct: number;
  /** Also max-lock SLVR won from mining rounds (compound it). */
  restakeMinedSlvr: boolean;
  /** Seconds between automation cycles. */
  intervalSeconds: number;
  /** Custom JSON-RPC endpoint. Empty = the public Robinhood Chain RPC. */
  rpcUrl: string;
  /** false = dry-run (print what would happen, send nothing). */
  live: boolean;
}

export const DEFAULTS: Omit<AppConfig, 'tokenId'> = {
  holdPct: 10,
  minePct: 45,
  buybackPct: 45,
  allocationMode: 'auto',
  // Smart (moving-average dip-buying) is the default: buy into weakness, not
  // all at once. Paired with the price-impact + frequency caps below.
  buybackMode: 'smart',
  buybackDipPct: 1,
  buybackLookbackMin: 60,
  maxBuybackPerCycleEth: 0.02,
  buybackMaxWaitHours: 24,
  maxBuybackPriceImpactPct: 1.5,
  buybackMinIntervalMin: 30,
  // Hard spend limits (the automation never exceeds these, whatever happens).
  // These govern AUTOMATED spending only; the manual Buy & Lock button is your
  // own explicit allocation and isn't limited by them.
  maxEthPerBuy: 0.05,
  maxBuysPerDay: 12,
  maxDailySpendEth: 0.25,
  holdWalletAddress: '',
  minClaimEth: 0.001,
  mineOnlyWhenProfitable: true,
  miningStrategy: '',
  minEdgePct: 0,
  maxPotEth: 0,
  minSecondsLeft: 10,
  valueSlvrAsCashOut: false,
  // An upper cap, not the usual bet size: the miner paces the budget over the
  // rounds until the next claim, so real bets are typically far smaller and
  // grow gradually as you add ETH. Kept modest by default (well above the
  // gas-efficient minimum ~0.0165 ETH); risk presets raise it if you want more.
  maxMinePerRoundEth: 0.05,
  minePace: 'balanced',
  strategyParams: {},
  // A few percent by default so ordinary price movement doesn't revert the
  // buy before it lands. Safe because the price-impact guard caps the real
  // execution price separately and buySlvr re-quotes/retries on a revert.
  slippagePct: 3,
  restakeMinedSlvr: true,
  intervalSeconds: 30,
  rpcUrl: '',
  live: false,
};

/**
 * Risk presets — starting bundles a new user picks during onboarding
 * (Conservative is pre-selected). A preset is a PREFILL, not a locked mode:
 * selecting it fills every field with these values, and the user can still
 * edit any of them here or in Settings.
 *
 * The deposits/principal rule is identical in every preset and is NOT encoded
 * here: the automation always spends CLAIMED REWARDS only, never principal.
 * Presets only govern how claimed rewards are split and how large the
 * automation's actions may be.
 */
export type PresetName = 'conservative' | 'neutral' | 'aggressive';

export const PRESETS: Record<PresetName, Partial<Omit<AppConfig, 'tokenId'>>> = {
  // Maximize the reversible slice (hold), treat principal as untouchable, keep
  // the mining cap just above the gas-efficient minimum, buy dips only.
  conservative: {
    holdPct: 40, minePct: 20, buybackPct: 40,
    allocationMode: 'fixed',
    maxEthPerBuy: 0.01, maxBuysPerDay: 4, maxDailySpendEth: 0.05,
    maxMinePerRoundEth: 0.025,
    mineOnlyWhenProfitable: true, miningStrategy: 'ev-gated', minEdgePct: 3,
    maxPotEth: 1.5, minePace: 'large',
    buybackMode: 'smart', buybackMaxWaitHours: 24,
    slippagePct: 10, maxBuybackPriceImpactPct: 1,
    minClaimEth: 0.001,
  },
  // Equal thirds; today's balanced defaults with the missing caps filled in.
  neutral: {
    holdPct: 33, minePct: 33, buybackPct: 34,
    allocationMode: 'auto',
    maxEthPerBuy: 0.05, maxBuysPerDay: 12, maxDailySpendEth: 0.25,
    maxMinePerRoundEth: 0.05,
    mineOnlyWhenProfitable: true, miningStrategy: 'ev-gated', minEdgePct: 1,
    maxPotEth: 3, minePace: 'balanced',
    buybackMode: 'instant', buybackMaxWaitHours: 24,
    slippagePct: 10, maxBuybackPriceImpactPct: 3,
    minClaimEth: 0.001,
  },
  // Reinvest claims hardest — but even here a daily ceiling stays on, because
  // "aggressive" means risk appetite, not "no brakes".
  aggressive: {
    holdPct: 0, minePct: 50, buybackPct: 50,
    allocationMode: 'auto',
    maxEthPerBuy: 0.25, maxBuysPerDay: 48, maxDailySpendEth: 1,
    maxMinePerRoundEth: 0.25,
    mineOnlyWhenProfitable: true, miningStrategy: 'opportunistic', minEdgePct: 0,
    maxPotEth: 0, minePace: 'small',
    buybackMode: 'instant', buybackMaxWaitHours: 24,
    slippagePct: 10, maxBuybackPriceImpactPct: 5,
    minClaimEth: 0.001,
  },
};

export interface AppState {
  /** ETH claimed and earmarked for mining, waiting for a good round (wei, as string). */
  mineBudgetWei: string;
  /** ETH earmarked for smart buybacks, waiting for a price dip (wei, as string). */
  buybackBudgetWei: string;
  /** Unix time the buyback budget first became non-zero (for the max-wait valve). */
  buybackSince: number;
  /** Unix time of the last buyback (for the frequency rate limit). */
  lastBuybackTs: number;
  /** Rounds we bet on that haven't been settled/claimed yet. */
  openMineRounds: string[];
  /** Unix time of the last mining bet (for sustainable pacing between claims). */
  lastMineTs: number;
  /** Claimed HOLD share kept in this wallet (no hold address set) — never reinvested (wei, as string). */
  holdKeptWei: string;
  /**
   * Rolling ledger of automated spends (buybacks + mining bets) used to enforce
   * the per-day count and total-spend caps. Entries older than 24h are pruned
   * on each read, so this stays tiny. `ts` is unix seconds, `wei` a string.
   */
  spendLog: { ts: number; wei: string; kind: 'buy' | 'mine' }[];
  /**
   * True while the automation is meant to be running. Survives restarts: when
   * the app relaunches (reboot, crash, closed laptop) it picks up right where
   * it left off — resuming the loop as soon as the wallet is usable.
   */
  autoResume: boolean;
}

/**
 * Crash-safe file write: write to a temp file, then atomically rename over
 * the target. A crash or power loss mid-write can never corrupt the wallet,
 * settings, or state — the old file stays intact until the new one is
 * complete.
 */
export function writeFileAtomic(path: string, contents: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, mode !== undefined ? { mode } : {});
  renameSync(tmp, path);
}

/** True when settings have been saved (wallet existence is keystore.ts's job). */
export function hasConfig(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): AppConfig {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw } as AppConfig;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: AppConfig): void {
  // Reject non-finite (NaN/Infinity) numbers FIRST. NaN slips through the
  // range/sum comparisons below (Math.abs(NaN - 100) > 0.01 is false), then
  // JSON.stringify turns it into `null` on save — which overrides the default
  // on the next load and permanently bricks config loading. Guard every
  // numeric field up front so a bad value is rejected, not persisted.
  for (const [k, v] of Object.entries({
    holdPct: cfg.holdPct, minePct: cfg.minePct, buybackPct: cfg.buybackPct,
    minEdgePct: cfg.minEdgePct, maxPotEth: cfg.maxPotEth, minSecondsLeft: cfg.minSecondsLeft,
    buybackDipPct: cfg.buybackDipPct, buybackLookbackMin: cfg.buybackLookbackMin,
    buybackMaxWaitHours: cfg.buybackMaxWaitHours, maxBuybackPriceImpactPct: cfg.maxBuybackPriceImpactPct,
    buybackMinIntervalMin: cfg.buybackMinIntervalMin, intervalSeconds: cfg.intervalSeconds,
    slippagePct: cfg.slippagePct, minClaimEth: cfg.minClaimEth,
    maxMinePerRoundEth: cfg.maxMinePerRoundEth, maxBuybackPerCycleEth: cfg.maxBuybackPerCycleEth,
    maxEthPerBuy: cfg.maxEthPerBuy, maxBuysPerDay: cfg.maxBuysPerDay, maxDailySpendEth: cfg.maxDailySpendEth,
  })) {
    if (!Number.isFinite(v)) throw new Error(`${k} must be a finite number (got ${v})`);
  }
  const sum = cfg.holdPct + cfg.minePct + cfg.buybackPct;
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`holdPct + minePct + buybackPct must add up to 100 (got ${sum})`);
  }
  // tokenId may be empty until the user has a position; starting the
  // automation is what requires it (guarded in server.ts / cycle.ts).
  if (cfg.tokenId && !/^\d+$/.test(cfg.tokenId)) {
    throw new Error('tokenId must be a whole number (veNFT id)');
  }
  if (cfg.holdWalletAddress && !/^0x[0-9a-fA-F]{40}$/.test(cfg.holdWalletAddress)) {
    throw new Error('holdWalletAddress is not a valid address');
  }
  if (cfg.minEdgePct < 0) throw new Error('minEdgePct cannot be negative');
  if (cfg.maxPotEth < 0) throw new Error('maxPotEth cannot be negative');
  if (cfg.minSecondsLeft < 0) throw new Error('minSecondsLeft cannot be negative');
  if (!Number.isFinite(cfg.intervalSeconds) || cfg.intervalSeconds < 5) {
    throw new Error('intervalSeconds must be at least 5');
  }
  if (!Number.isFinite(cfg.slippagePct) || cfg.slippagePct < 0 || cfg.slippagePct > 10) {
    throw new Error('slippagePct must be between 0 and 10');
  }
  for (const [k, v] of Object.entries({
    minClaimEth: cfg.minClaimEth, maxMinePerRoundEth: cfg.maxMinePerRoundEth,
    maxBuybackPerCycleEth: cfg.maxBuybackPerCycleEth, maxEthPerBuy: cfg.maxEthPerBuy,
    maxBuysPerDay: cfg.maxBuysPerDay, maxDailySpendEth: cfg.maxDailySpendEth,
  })) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
  }
}

export function saveConfig(cfg: AppConfig): void {
  validateConfig(cfg);
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

export function loadState(): AppState {
  if (!existsSync(STATE_PATH)) {
    return { mineBudgetWei: '0', buybackBudgetWei: '0', buybackSince: 0, lastBuybackTs: 0, openMineRounds: [], lastMineTs: 0, holdKeptWei: '0', spendLog: [], autoResume: false };
  }
  const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  return {
    mineBudgetWei: raw.mineBudgetWei ?? '0',
    buybackBudgetWei: raw.buybackBudgetWei ?? '0',
    buybackSince: raw.buybackSince ?? 0,
    lastBuybackTs: raw.lastBuybackTs ?? 0,
    openMineRounds: raw.openMineRounds ?? [],
    lastMineTs: raw.lastMineTs ?? 0,
    holdKeptWei: raw.holdKeptWei ?? '0',
    spendLog: Array.isArray(raw.spendLog) ? raw.spendLog : [],
    autoResume: raw.autoResume ?? false,
  };
}

export function saveState(state: AppState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/** Read PRIVATE_KEY from .env (we parse it ourselves so the UI can rewrite it safely). */
export function loadPrivateKey(): `0x${string}` | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const line = readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('PRIVATE_KEY='));
  const value = line?.slice('PRIVATE_KEY='.length).trim();
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : undefined;
}

export function savePrivateKey(pk: `0x${string}`): void {
  let lines: string[] = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, 'utf8').split('\n').filter((l) => !l.startsWith('PRIVATE_KEY='));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
  }
  lines.push(`PRIVATE_KEY=${pk}`);
  writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

/**
 * The RPC endpoint to use: config.json's rpcUrl (set in the UI), else a
 * RPC_URL in .env, else undefined — which means the public Robinhood Chain
 * RPC that ships with the SDK.
 */
export function loadRpcUrl(): string | undefined {
  try {
    if (existsSync(CONFIG_PATH)) {
      const url = String(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).rpcUrl ?? '').trim();
      if (url) return url;
    }
  } catch {
    // fall through to .env
  }
  if (!existsSync(ENV_PATH)) return undefined;
  const line = readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('RPC_URL='));
  const value = line?.slice('RPC_URL='.length).trim();
  return value || undefined;
}
