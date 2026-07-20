/**
 * Wallet-spending guardrail shared by every ETH-spending path (hold
 * transfers, buybacks, mining bets). Kept in its own tiny module so both
 * cycle.ts and mining.ts can use it without importing each other.
 */
import { parseEther } from 'viem';
import type { Ctx } from './chain';
import type { AppConfig, AppState } from './config';

/**
 * Never spend the wallet below this — it's the gas reserve. Every ETH-spending
 * path is capped by spendable(), so the automation can never drain the last
 * ETH and strand itself without gas. 0.002 ETH covers hundreds of transactions
 * on Robinhood Chain and matches the low-gas warning threshold in app.ts.
 */
export const GAS_RESERVE_WEI = parseEther('0.002');

/** How much the wallet can spend right now without touching the gas reserve. */
export async function spendable(ctx: Ctx): Promise<bigint> {
  const bal = await ctx.publicClient.getBalance({ address: ctx.account!.address });
  return bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n;
}

/**
 * Rolling 24h spend accounting for the per-day limits (maxBuysPerDay,
 * maxDailySpendEth). These govern AUTOMATED spending only — buybacks and
 * mining bets. The manual Buy & Lock button is the user's own explicit
 * allocation and is never recorded here or limited by these caps.
 *
 * The ledger lives in AppState.spendLog and is kept tiny by pruning anything
 * older than the window on every read. A rolling window (not a calendar day)
 * is used so the cap can't be sidestepped at midnight.
 */
const DAY_SECONDS = 24 * 60 * 60;

/** Drop ledger entries older than 24h. Mutates and returns the state. */
export function pruneSpend(state: AppState, nowSec: number): AppState {
  const cutoff = nowSec - DAY_SECONDS;
  if (state.spendLog.length) {
    state.spendLog = state.spendLog.filter((e) => e.ts >= cutoff);
  }
  return state;
}

/** Total ETH (wei) spent by the automation in the last 24h. */
export function spent24hWei(state: AppState, nowSec: number): bigint {
  const cutoff = nowSec - DAY_SECONDS;
  let sum = 0n;
  for (const e of state.spendLog) {
    if (e.ts >= cutoff) sum += BigInt(e.wei);
  }
  return sum;
}

/** Number of automated BUYBACKS in the last 24h (mining bets don't count). */
export function buys24h(state: AppState, nowSec: number): number {
  const cutoff = nowSec - DAY_SECONDS;
  let n = 0;
  for (const e of state.spendLog) {
    if (e.ts >= cutoff && e.kind === 'buy') n++;
  }
  return n;
}

/** Append a spend to the ledger (caller persists via saveState). */
export function recordSpend(state: AppState, wei: bigint, kind: 'buy' | 'mine', nowSec: number): void {
  state.spendLog.push({ ts: nowSec, wei: wei.toString(), kind });
}

/**
 * ETH (wei) the automation may still spend today under maxDailySpendEth.
 * Returns null when there is no daily cap (maxDailySpendEth <= 0) — callers
 * treat null as "unlimited".
 */
export function dailyRemainingWei(cfg: AppConfig, state: AppState, nowSec: number): bigint | null {
  if (!(cfg.maxDailySpendEth > 0)) return null;
  const cap = parseEther(String(cfg.maxDailySpendEth));
  const spent = spent24hWei(state, nowSec);
  return cap > spent ? cap - spent : 0n;
}
