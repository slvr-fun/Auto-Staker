/**
 * ═══ YOUR CUSTOM STRATEGIES LIVE HERE ═══
 *
 * This file belongs to YOU. Template upgrades never modify it, so anything
 * you add here merges cleanly when you pull updates — no conflicts.
 *
 * Add an entry to a registry below and it appears in the app automatically:
 * custom mining strategies show up as choices in Settings → Mining, and you
 * can also select one by putting its key in `miningStrategy` in your
 * config. Each strategy is a pure function: inputs in, a decision and a
 * human-readable reason out. The reason is shown in the Live Activity feed,
 * so make it explain itself. Execution, safety rails (gas reserve, caps,
 * dry-run), and transaction sending all stay in the core app — your code
 * never touches money directly.
 *
 * Example — mine only in quiet rounds with few competitors' ETH in the pot:
 *
 *   export const CUSTOM_MINING: Record<string, MiningStrategy> = {
 *     'quiet-rounds': (cfg, { open, secondsLeft, potEth, ev }) => {
 *       if (!open || secondsLeft < cfg.minSecondsLeft) return { act: false, reason: 'window closed' };
 *       if (potEth > 0.25) return { act: false, reason: `pot ${potEth.toFixed(3)} ETH is too crowded for quiet-rounds` };
 *       if (!ev || !ev.profitable) return { act: false, reason: 'not profitable' };
 *       return { act: true, reason: `quiet round (pot ${potEth.toFixed(3)} ETH) and profitable` };
 *     },
 *   };
 *
 * A mining strategy can also bet MORE on a good round by returning a
 * `sizeMultiplier` (>1) on its decision — the engine scales the paced base
 * stake by it, clamped to the gas floor, your Max ETH per round, and the
 * spendable balance. `MiningInput` also gives you `waitedSec` (time since the
 * last bet) so you can be patient and relax over time. See the built-in
 * `opportunistic` strategy in ./strategies for a worked example.
 *
 * The full input/output types are in ./strategies (MiningInput, Decision,
 * BuybackInput, AllocationInput). Ask Claude to "write me a mining strategy
 * that …" — the modify-autostaker skill knows to put it here.
 */
import type { MiningStrategy, BuybackStrategy, AllocationStrategy, StrategyMeta } from './strategies';

export const CUSTOM_MINING: Record<string, MiningStrategy> = {
  // 'my-strategy': (cfg, input) => ({ act: false, reason: 'todo' }),
};

/**
 * Optional: give your custom mining strategies a description and tunable
 * params. The description shows as help text under the strategy picker, and
 * each param becomes a number input in Settings → Mining. Read a param value
 * inside your strategy with `sparam(cfg, 'my.key', defaultValue)`.
 *
 *   export const CUSTOM_MINING_META: Record<string, StrategyMeta> = {
 *     'my-strategy': {
 *       description: 'What it does, in one sentence.',
 *       params: [{ key: 'my.threshold', label: 'Threshold', default: 5, min: 0, max: 100, step: 1, unit: 'pct', hint: '…' }],
 *     },
 *   };
 */
export const CUSTOM_MINING_META: Record<string, StrategyMeta> = {};

export const CUSTOM_BUYBACK: Record<string, BuybackStrategy> = {};

export const CUSTOM_ALLOCATION: Record<string, AllocationStrategy> = {};
