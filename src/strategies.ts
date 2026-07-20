/**
 * The strategy layer — every DECISION the automation makes lives here, split
 * from the execution in cycle.ts. Each kind of decision has a registry keyed
 * by name; the active strategy is chosen from the user's config.
 *
 * ── Writing a new strategy ──────────────────────────────────────────────
 * 1. Add a function to the right registry below (pure function: inputs in,
 *    decision + human-readable reason out — no I/O, no transactions).
 * 2. Expose it: map a config value to your key in the pick* function.
 * 3. (Optional) add a Settings control for it in public/index.html.
 * That's it — cycle.ts logs your `reason` to the activity feed and executes
 * the decision with all the existing safety rails (gas reserve, caps,
 * dry-run) untouched.
 */
import type { GridMiningEv } from '@slvr-labs/sdk';
import type { AppConfig } from './config';
import { CUSTOM_MINING, CUSTOM_BUYBACK, CUSTOM_ALLOCATION, CUSTOM_MINING_META } from './strategies.custom';

// ── Strategy metadata: a plain-English explanation + tunable parameters ──
// The UI renders the description as help text and the params as number inputs
// for whichever strategy is selected. Param values are stored in
// `cfg.strategyParams` keyed by `key`; read them with `sparam()`.

export interface StrategyParam {
  key: string; // config key under cfg.strategyParams
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  /** 'pct' shows a % suffix, 'eth' an ETH suffix, 'hours'/'x' likewise. */
  unit?: 'pct' | 'eth' | 'hours' | 'x' | '';
}

export interface StrategyMeta {
  description: string;
  params: StrategyParam[];
}

/** Read a strategy parameter from config, falling back to its default. */
export function sparam(cfg: AppConfig, key: string, fallback: number): number {
  const v = cfg.strategyParams?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ── Mining: should the miner play this round? ───────────────────────────

export interface MiningInput {
  /** Is betting open, and how long is left in the window? */
  open: boolean;
  secondsLeft: number;
  /** The round's pot in ETH (before our stake). */
  potEth: number;
  /**
   * Full EV breakdown for our intended stake, or null if it couldn't be
   * priced. GAS-ADJUSTED: the bet+claim gas cost is already subtracted from
   * netEth/edgeRatio, and `profitable` means profitable after gas.
   */
  ev: GridMiningEv | null;
  /** Seconds since the last bet — lets a strategy relax its patience over time. */
  waitedSec: number;
}

export interface Decision {
  act: boolean;
  reason: string;
  /**
   * Optional bet-size multiplier on the paced base stake (default 1). Used by
   * profitability-optimizing strategies to bet more on higher-edge rounds. The
   * engine clamps the result to the gas floor, your Max ETH per round, and the
   * spendable balance, so this can only ever scale UP within those limits.
   */
  sizeMultiplier?: number;
}

export type MiningStrategy = (cfg: AppConfig, input: MiningInput) => Decision;

export const MINING_STRATEGIES: Record<string, MiningStrategy> = {
  /** Only play rounds whose expected value clears the user's edge bar. */
  'ev-gated': (cfg, { open, secondsLeft, potEth, ev }) => {
    const gate = commonMiningGates(cfg, open, secondsLeft, potEth);
    if (gate) return gate;
    if (!ev) return { act: false, reason: 'round could not be priced, skipping' };
    if (!ev.profitable) {
      // `ev` is gas-adjusted, so "not profitable" can mean the pot is over
      // break-even OR the edge just doesn't cover gas at this bet size.
      const why = potEth >= ev.breakEvenPot
        ? `pot ${potEth.toFixed(4)} ETH is over the break-even ${ev.breakEvenPot.toFixed(4)} ETH`
        : `at this bet size the edge doesn't cover gas yet — waiting for a smaller pot`;
      return { act: false, reason: `not profitable after gas (${why}), holding the mining budget` };
    }
    const edgePct = ev.edgeRatio * 100;
    if (edgePct < cfg.minEdgePct) {
      return { act: false, reason: `edge ${edgePct.toFixed(2)}% is below your ${cfg.minEdgePct}% minimum, holding the mining budget` };
    }
    return { act: true, reason: `round qualifies: edge +${edgePct.toFixed(2)}% of stake (≈${ev.netEth >= 0 ? '+' : ''}${ev.netEth.toFixed(6)} ETH/round)` };
  },

  /** Play every round the budget allows (still respects the shared gates). */
  always: (cfg, { open, secondsLeft, potEth }) => {
    const gate = commonMiningGates(cfg, open, secondsLeft, potEth);
    if (gate) return gate;
    return { act: true, reason: 'always-mine strategy: playing this round' };
  },

  /**
   * Optimize for profitability: hold out for higher-edge rounds and bet more
   * when the edge is bigger. The patience bar starts at OPP_HIGH_EDGE and
   * relaxes toward your minimum over OPP_MAX_WAIT_HOURS, so a quiet market
   * never freezes the budget. Bet size scales with edge (capped), so the best
   * rounds get the biggest bets — the engine clamps to the gas floor, your
   * Max ETH per round, and the spendable balance.
   */
  opportunistic: (cfg, { open, secondsLeft, potEth, ev, waitedSec }) => {
    const gate = commonMiningGates(cfg, open, secondsLeft, potEth);
    if (gate) return gate;
    if (!ev) return { act: false, reason: 'round could not be priced, skipping' };
    if (!ev.profitable) {
      return { act: false, reason: 'not profitable after gas, holding the mining budget' };
    }
    const highEdge = sparam(cfg, 'opp.highEdge', 6);
    const maxWaitHours = sparam(cfg, 'opp.maxWaitHours', 6);
    const referenceEdge = Math.max(0.1, sparam(cfg, 'opp.referenceEdge', 3));
    const maxMult = Math.max(1, sparam(cfg, 'opp.maxMult', 3));
    const edgePct = ev.edgeRatio * 100;
    const relax = maxWaitHours > 0 ? Math.min(1, Math.max(0, waitedSec) / 3600 / maxWaitHours) : 1;
    const targetEdge = Math.max(cfg.minEdgePct, highEdge - (highEdge - cfg.minEdgePct) * relax);
    if (edgePct < targetEdge) {
      return { act: false, reason: `waiting for a better round: edge +${edgePct.toFixed(2)}% is below the +${targetEdge.toFixed(2)}% target (relaxes the longer the budget waits)` };
    }
    const mult = Math.max(1, Math.min(maxMult, edgePct / referenceEdge));
    return { act: true, sizeMultiplier: mult, reason: `high-edge round +${edgePct.toFixed(2)}% — betting ${mult.toFixed(1)}x the base stake (≈${ev.netEth >= 0 ? '+' : ''}${ev.netEth.toFixed(6)} ETH/round)` };
  },
};

/**
 * Plain-English explanation + tunable params for each built-in strategy. The
 * common gates (min edge, max pot, betting-window guard) live in the main
 * Mining settings and apply to every strategy, so they're not repeated here.
 */
export const MINING_STRATEGY_META: Record<string, StrategyMeta> = {
  'ev-gated': {
    description:
      'Bets only rounds whose expected value clears your minimum edge, after gas. Holds the budget through weak rounds. The bet size is the paced amount. Tune it with the Minimum edge and Max pot settings above.',
    params: [],
  },
  always: {
    description:
      'Bets every round the budget and betting window allow, ignoring EV. Simple and aggressive — use only if you want maximum SLVR mined regardless of ETH cost.',
    params: [],
  },
  opportunistic: {
    description:
      'Optimizes for profitability: holds out for high-edge rounds and bets more when the edge is bigger. The patience target starts high and relaxes to your minimum over a few hours so the budget never freezes.',
    params: [
      { key: 'opp.highEdge', label: 'Target edge', default: 6, min: 0, max: 50, step: 0.5, unit: 'pct', hint: 'Hold out for rounds with at least this edge when the budget is fresh.' },
      { key: 'opp.maxWaitHours', label: 'Patience', default: 6, min: 0.5, max: 48, step: 0.5, unit: 'hours', hint: 'Relax the target down to your minimum edge over this long, so the budget never sits idle forever.' },
      { key: 'opp.referenceEdge', label: 'Full-size edge', default: 3, min: 0.5, max: 30, step: 0.5, unit: 'pct', hint: 'Edge at which the bet is 1x the base stake; higher edges scale up from here.' },
      { key: 'opp.maxMult', label: 'Max bet multiple', default: 3, min: 1, max: 10, step: 0.5, unit: 'x', hint: 'Never bet more than this multiple of the base stake, however high the edge.' },
    ],
  },
};

/** Built-in strategy metadata merged with any custom strategies declare. */
export function allMiningStrategyMeta(): Record<string, StrategyMeta> {
  return { ...MINING_STRATEGY_META, ...CUSTOM_MINING_META };
}

/** Gates every mining strategy respects: window timing and the pot cap. */
function commonMiningGates(cfg: AppConfig, open: boolean, secondsLeft: number, potEth: number): Decision | null {
  if (!open) return { act: false, reason: 'round is closed' };
  if (secondsLeft < cfg.minSecondsLeft) return { act: false, reason: `only ${secondsLeft}s left in the betting window (need ${cfg.minSecondsLeft}s)` };
  if (cfg.maxPotEth > 0 && potEth > cfg.maxPotEth) {
    return { act: false, reason: `pot ${potEth.toFixed(4)} ETH is over your ${cfg.maxPotEth} ETH cap, holding the mining budget` };
  }
  return null;
}

/** Built-ins merged with the user's custom strategies (custom wins on name clash). */
export function allMiningStrategies(): Record<string, MiningStrategy> {
  return { ...MINING_STRATEGIES, ...CUSTOM_MINING };
}

export function pickMiningStrategy(cfg: AppConfig): MiningStrategy {
  const all = allMiningStrategies();
  if (cfg.miningStrategy && all[cfg.miningStrategy]) return all[cfg.miningStrategy]!;
  return all[cfg.mineOnlyWhenProfitable ? 'ev-gated' : 'always']!;
}

// ── Buybacks: should the earmarked budget buy right now? ────────────────

export interface BuybackInput {
  /** Current SLVR price in ETH, or null if unavailable. */
  priceEth: number | null;
  /** Moving average over the configured lookback, or null if too little history. */
  smaEth: number | null;
  /** Hours the budget has been waiting. */
  waitedHours: number;
}

export type BuybackStrategy = (cfg: AppConfig, input: BuybackInput) => Decision;

export const BUYBACK_STRATEGIES: Record<string, BuybackStrategy> = {
  /** Buy immediately, no signal needed (used at claim time, not budget time). */
  instant: () => ({ act: true, reason: 'instant buyback' }),

  /** Buy into sell pressure: only below the recent average, with a time valve. */
  'smart-dip': (cfg, { priceEth, smaEth, waitedHours }) => {
    if (waitedHours >= cfg.buybackMaxWaitHours) {
      return { act: true, reason: `budget has waited ${waitedHours.toFixed(1)}h (max ${cfg.buybackMaxWaitHours}h), buying regardless` };
    }
    if (priceEth == null) return { act: false, reason: 'waiting for price data' };
    if (smaEth == null) return { act: false, reason: 'collecting price history for the dip signal' };
    const dip = (1 - priceEth / smaEth) * 100; // % below average (negative = above)
    if (dip >= cfg.buybackDipPct) {
      return { act: true, reason: `price is ${dip.toFixed(2)}% below its ${cfg.buybackLookbackMin}m average, buying the dip` };
    }
    return {
      act: false,
      reason: `price is ${dip >= 0 ? dip.toFixed(2) + '% below' : Math.abs(dip).toFixed(2) + '% above'} the ${cfg.buybackLookbackMin}m average (needs ${cfg.buybackDipPct}%+ dip)`,
    };
  },
};

export function pickBuybackStrategy(cfg: AppConfig): BuybackStrategy {
  const all = { ...BUYBACK_STRATEGIES, ...CUSTOM_BUYBACK };
  return all[cfg.buybackMode === 'smart' ? 'smart-dip' : 'instant']!;
}

// ── Allocation: where does the non-hold share of a claim go? ────────────

export interface AllocationInput {
  /** Is mining +EV right now (already includes the user's edge bar)? */
  miningFavorable: boolean;
}

export interface AllocationDecision {
  route: 'mine' | 'buyback' | 'split';
  reason: string;
}

export type AllocationStrategy = (cfg: AppConfig, input: AllocationInput) => AllocationDecision;

export const ALLOCATION_STRATEGIES: Record<string, AllocationStrategy> = {
  /** Price-aware: mine while it pays, buy back otherwise. */
  auto: (_cfg, { miningFavorable }) =>
    miningFavorable
      ? { route: 'mine', reason: 'auto allocation: mining is profitable right now, routing the share to MINING' }
      : { route: 'buyback', reason: 'auto allocation: mining is not favorable, routing the share to BUYBACKS' },

  /** Fixed: always honor the slider percentages. */
  fixed: () => ({ route: 'split', reason: 'fixed allocation: using the configured split' }),
};

export function pickAllocationStrategy(cfg: AppConfig): AllocationStrategy {
  const all = { ...ALLOCATION_STRATEGIES, ...CUSTOM_ALLOCATION };
  return all[cfg.allocationMode === 'fixed' ? 'fixed' : 'auto']!;
}
