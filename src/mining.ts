/**
 * ═══ THE MINING ENGINE ═══ (isolated on purpose — tune it here)
 *
 * Everything about HOW the auto-staker mines lives in this one module, apart
 * from the rest of the automation (claiming, holding, buybacks) in cycle.ts.
 * The cycle just calls `runMining()` each pass; this file decides the bet
 * size, respects the gas economics, paces the budget, places the bet, and
 * settles winnings. Customize mining by editing the knobs and functions here
 * — you won't touch the money-splitting logic in cycle.ts.
 *
 * What the engine guarantees:
 *   • never bets below the gas-efficient minimum (gas can't eat the edge)
 *   • never bets above your Max ETH per round cap
 *   • paces the budget so it lasts until the next claim tops it up
 *   • only bets rounds that are +EV *after gas* and clear your edge bar
 *   • pauses entirely when network gas spikes
 *   • records the bet before sending (no double-bet) and only advances the
 *     pacing clock after a bet actually lands
 *
 * The DECISION of whether a priced round is worth playing lives in the
 * strategy registry (strategies.ts / strategies.custom.ts) — this engine
 * sizes the bet and hands the strategy a gas-adjusted EV to judge. To change
 * WHICH rounds are played, write a strategy; to change bet SIZING, pacing, or
 * the gas rails, edit the knobs below.
 *
 * Public API:
 *   runMining(ctx, cfg, state, log)   settle finished rounds, then place a
 *                                     paced bet on the current round
 *   isMiningFavorable(ctx, cfg)       is mining +EV after gas right now?
 *                                     (used by the allocation strategy)
 *   miningPlan(ctx, cfg, state, id)   the current plan for the UI: bet size,
 *                                     cadence, runway
 */
import { formatEther, parseAbi, parseEther } from 'viem';
import { GRID_SIZE, type GridMiningEv } from '@slvr-labs/sdk';
import type { AppConfig, AppState } from './config';
import { loadState, saveState } from './config';
import { ADDRESSES, type Ctx } from './chain';
import { maxLockSlvr } from './position';
import { logEvent, seriesSince } from './db';
import { pickMiningStrategy } from './strategies';
import { spendable, pruneSpend, dailyRemainingWei, recordSpend } from './budget';

// ── Tuning knobs ─────────────────────────────────────────────────────────

/** Absolute dust floor for mining bets — the real minimum is gas-based, below. */
const MIN_MINE_BET_WEI = parseEther('0.0002');

/**
 * Mining gas economics. A 25-square bet is gas-heavy (measured live: ~6.5M
 * units; claim adds more), so small bets lose to gas even in +EV rounds. Two
 * rails handle this: a MINIMUM stake of MIN_STAKE_GAS_MULTIPLE × the
 * round-trip gas cost (so gas drag stays ≤ ~5% of the stake), and EV that is
 * gas-adjusted before every strategy decision. Recomputed from the live gas
 * price each time, so the floor tracks the network.
 */
const MINE_ROUND_TRIP_GAS_UNITS = 11_000_000n; // bet (~6.5M measured) + claim, padded
const MIN_STAKE_GAS_MULTIPLE = 20n;

/**
 * Gas-spike circuit breaker: when the round-trip cost climbs past this, don't
 * mine at all — rather than chasing the floor with ever-bigger bets, hold and
 * wait for gas to settle (rounds recur; waiting is nearly free). Normal on
 * Robinhood Chain is ~0.0008 ETH, so this trips at roughly 5x.
 */
const MINE_GAS_CEILING_WEI = parseEther('0.004');

/**
 * Sustainable pacing: make the mining budget last until the next claim tops it
 * up, so the miner stays in the game continuously instead of burning the
 * budget in a burst and going dark. The horizon is the estimated time to the
 * next claim, from the live reward accrual rate; when that can't be measured
 * yet, assume a day. A new deposit simply raises the budget and the per-round
 * size adapts on the next round.
 */
const MINE_HORIZON_FALLBACK_SEC = 24 * 3600;
const MINE_HORIZON_MIN_SEC = 3600;
const MINE_HORIZON_MAX_SEC = 72 * 3600;
const ROUND_CYCLE_FALLBACK_SEC = 300;

const fmtEth = (wei: bigint) => `${formatEther(wei)} ETH`;

// ── Gas + timing helpers ───────────────────────────────────────────────────

/** Current cost of a full mining round trip (bet + claim) at the live gas price. */
async function mineGasCostWei(ctx: Ctx): Promise<bigint> {
  const gasPrice = await ctx.publicClient.getGasPrice();
  return gasPrice * MINE_ROUND_TRIP_GAS_UNITS;
}

/** Subtract the round-trip gas from an EV estimate so decisions are net-of-gas. */
function gasAdjustEv(ev: GridMiningEv, stakeWei: bigint, gasWei: bigint): GridMiningEv {
  const gasEth = Number(formatEther(gasWei));
  const stakeEth = Number(formatEther(stakeWei));
  const netEth = ev.netEth - gasEth;
  return {
    ...ev,
    netEth,
    edgeRatio: ev.edgeRatio - (stakeEth > 0 ? gasEth / stakeEth : 0),
    profitable: ev.profitable && netEth > 0,
  };
}

/**
 * Estimated seconds until the next claim refills the budget: time for pending
 * rewards to reach the claim threshold at the accrual rate measured over the
 * last hour of snapshots.
 */
function claimHorizonSec(cfg: AppConfig): number {
  try {
    const now = Math.floor(Date.now() / 1000);
    const pts = seriesSince('pending', now - 3600, 60);
    if (pts.length >= 5) {
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      const rate = (last.v - first.v) / Math.max(1, last.t - first.t); // wei per second
      if (rate > 0) {
        const remainWei = Number(parseEther(String(cfg.minClaimEth))) - last.v;
        if (remainWei <= 0) return MINE_HORIZON_MIN_SEC;
        return Math.min(MINE_HORIZON_MAX_SEC, Math.max(MINE_HORIZON_MIN_SEC, remainWei / rate));
      }
    }
  } catch {
    // fall through to the fallback
  }
  return MINE_HORIZON_FALLBACK_SEC;
}

const ROUND_START_ABI = parseAbi(['function roundStart(uint256 roundId) view returns (uint256)']);

/** Full length of one lottery round (betting + reveal), measured on-chain. */
async function roundCycleSec(ctx: Ctx, roundId: bigint): Promise<number> {
  try {
    const [a, b] = await Promise.all([
      ctx.publicClient.readContract({ address: ADDRESSES.lottery, abi: ROUND_START_ABI, functionName: 'roundStart', args: [roundId] }),
      ctx.publicClient.readContract({ address: ADDRESSES.lottery, abi: ROUND_START_ABI, functionName: 'roundStart', args: [roundId + 1n] }),
    ]);
    const sec = Number(b - a);
    if (sec > 30 && sec < 24 * 3600) return sec;
  } catch {
    // fall through to the fallback
  }
  return ROUND_CYCLE_FALLBACK_SEC;
}

/**
 * Mining pace → bet SIZE and CADENCE.
 *   bets:       split the budget into this many stakes. Fewer ⇒ bigger
 *               stakes ⇒ lower gas drag (gas is a fixed cost per bet).
 *   maxGapSec:  never wait longer than this between bets. Without a cap, a
 *               slow reward-accrual rate makes the "spread to the next claim"
 *               horizon many hours long, which stretches the gap between bets
 *               to hours — this keeps the miner visibly active. Mining is +EV,
 *               so deploying the budget at a steady clip and then waiting for
 *               claims/deposits to refill it is fine.
 * Tune both here.
 */
const PACE: Record<AppConfig['minePace'], { bets: number; maxGapSec: number }> = {
  large: { bets: 3, maxGapSec: 25 * 60 }, // fewer, larger bets, least frequent
  balanced: { bets: 6, maxGapSec: 10 * 60 },
  small: { bets: 12, maxGapSec: 4 * 60 }, // more, smaller bets, ~every round
};
function pace(cfg: AppConfig): { bets: number; maxGapSec: number } {
  return PACE[cfg.minePace] ?? PACE.balanced;
}

/**
 * Seconds to wait between bets: spread the budget toward the next claim, but
 * never longer than the pace's max gap (so a long claim horizon can't make the
 * miner sit idle for hours). Floored at one round so we never bet twice in a
 * round.
 */
function betGapSec(horizonSec: number, roundsAffordable: number, cycleSec: number, maxGapSec: number): number {
  const spread = horizonSec / Math.max(1, roundsAffordable);
  return Math.max(cycleSec, Math.min(spread, maxGapSec));
}

/**
 * Split the budget into `targetBets` meaningful bets (grows with the budget),
 * floored at the gas-efficient minimum so gas never eats the edge, and capped
 * at the user's Max ETH per round. The time spacing between bets is derived
 * from this in maybeMine so the budget lasts until the next claim.
 */
function sizeStake(budget: bigint, gasWei: bigint, targetBets: number, maxPerRound: bigint): bigint {
  const minStakeWei = gasWei * MIN_STAKE_GAS_MULTIPLE;
  let stakeWei = budget / BigInt(Math.max(1, targetBets));
  if (stakeWei < minStakeWei) stakeWei = minStakeWei;
  if (stakeWei > maxPerRound) stakeWei = maxPerRound;
  if (stakeWei > budget) stakeWei = budget;
  return stakeWei;
}

// ── Public: allocation + display ───────────────────────────────────────────

/**
 * Is grid mining +EV right now, NET OF GAS, at a representative stake that
 * meets the user's edge bar? Used by the allocation strategy to route claims.
 * Errors → no.
 *
 * Evaluated at the gas-efficient MINIMUM bet (the smallest stake the miner
 * would actually place), not the Max-per-round cap. The cap makes gas
 * negligible and overstates favorability; the floor is where gas drag is
 * worst, so if it clears here it clears at the larger paced bets too —
 * a conservative match for what the miner will really do.
 */
export async function isMiningFavorable(ctx: Ctx, cfg: AppConfig): Promise<boolean> {
  try {
    const gasWei = await mineGasCostWei(ctx);
    if (gasWei > MINE_GAS_CEILING_WEI) return false; // gas spike — don't route funds to mining
    const minStakeWei = gasWei * MIN_STAKE_GAS_MULTIPLE;
    const capWei = parseEther(String(cfg.maxMinePerRoundEth));
    if (capWei < minStakeWei) return false; // cap too low to out-earn gas
    const stakeWei = minStakeWei;
    const roundId = await ctx.sdk.lottery.currentRoundId();
    const round = await ctx.sdk.lottery.getRound(roundId);
    const raw = await ctx.sdk.estimateRoundEv({
      stake: Number(formatEther(stakeWei)),
      roundId,
      pot: Number(formatEther(round.totalWager + stakeWei)),
      cashOut: cfg.valueSlvrAsCashOut,
    });
    const ev = gasAdjustEv(raw, stakeWei, gasWei);
    return ev.profitable && ev.edgeRatio * 100 >= cfg.minEdgePct;
  } catch {
    return false;
  }
}

/**
 * The current mining plan, for display: how big the next bet is, how often
 * bets go out, and how long the budget lasts. Mirrors the sizing in runMining.
 */
export interface MiningPlan {
  stakeWei: bigint;
  minStakeWei: bigint;
  spacingSec: number;
  roundsAffordable: number;
  horizonSec: number;
  blockedByCap: boolean;
}

export async function miningPlan(ctx: Ctx, cfg: AppConfig, state: AppState, roundId: bigint): Promise<MiningPlan | null> {
  const budget = BigInt(state.mineBudgetWei);
  if (budget < MIN_MINE_BET_WEI) return null;
  const gasWei = await mineGasCostWei(ctx);
  const minStakeWei = gasWei * MIN_STAKE_GAS_MULTIPLE;
  const maxPerRound = parseEther(String(cfg.maxMinePerRoundEth));
  const horizonSec = claimHorizonSec(cfg);
  const cycleSec = await roundCycleSec(ctx, roundId);
  const p = pace(cfg);
  const stakeWei = sizeStake(budget, gasWei, p.bets, maxPerRound);
  const roundsAffordable = Math.max(1, Number(budget / (stakeWei > 0n ? stakeWei : 1n)));
  return {
    stakeWei,
    minStakeWei,
    spacingSec: betGapSec(horizonSec, roundsAffordable, cycleSec, p.maxGapSec),
    roundsAffordable,
    horizonSec,
    blockedByCap: maxPerRound < minStakeWei,
  };
}

// ── Public: the engine ─────────────────────────────────────────────────────

/** Settle finished mining rounds, then place a paced bet on the current one. */
export async function runMining(ctx: Ctx, cfg: AppConfig, state: AppState, log: (l: string) => void): Promise<void> {
  await settleMiningRounds(ctx, cfg, state, log);
  await maybeMine(ctx, cfg, state, log);
}

async function settleMiningRounds(ctx: Ctx, cfg: AppConfig, state: AppState, log: (l: string) => void): Promise<void> {
  if (!cfg.live || state.openMineRounds.length === 0) return;
  const me = ctx.account!.address;

  for (const rs of [...state.openMineRounds]) {
    const roundId = BigInt(rs);
    try {
      const round = await ctx.sdk.lottery.getRound(roundId);
      if (!round.resolved) continue;

      if (await ctx.sdk.canClaim(roundId, me)) {
        const slvrBefore = await ctx.sdk.token.balanceOf(me);
        const ethBefore = await ctx.publicClient.getBalance({ address: me });
        const hash = await ctx.sdk.lottery.claim({ roundId });
        await ctx.publicClient.waitForTransactionReceipt({ hash });
        const slvrGained = (await ctx.sdk.token.balanceOf(me)) - slvrBefore;
        const ethAfter = await ctx.publicClient.getBalance({ address: me });
        const ethGained = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
        log(`  💰 mining round #${roundId} settled: +${formatEther(slvrGained)} SLVR, ~+${fmtEth(ethGained)} winnings`);
        logEvent('mine_settle', { ethWei: ethGained, slvrWei: slvrGained, txHash: hash, detail: `round #${roundId}` });
        if (cfg.restakeMinedSlvr && slvrGained > 0n) {
          log('  → max-locking mined SLVR (permanent — burned into your position)…');
          const lockedInto = await maxLockSlvr(ctx, slvrGained);
          logEvent('max_lock', { slvrWei: slvrGained, detail: `mined, veNFT #${lockedInto}` });
        }
      } else {
        log(`  · mining round #${roundId} resolved — nothing to claim`);
        logEvent('mine_settle', { detail: `round #${roundId} — nothing to claim` });
      }
      state.openMineRounds = state.openMineRounds.filter((r) => r !== rs);
      saveState(state);
    } catch {
      // RPC hiccup or round still settling — retry next cycle.
    }
  }
}

async function maybeMine(ctx: Ctx, cfg: AppConfig, state: AppState, log: (l: string) => void): Promise<void> {
  let budget = BigInt(state.mineBudgetWei);
  if (cfg.minePct > 0 && budget > 0n) {
    log(`  mining budget waiting: ${fmtEth(budget)}`);
  }
  if (!cfg.live && cfg.minePct > 0 && budget < MIN_MINE_BET_WEI) {
    // Dry-run preview: pretend one round's budget is available so the user can
    // watch the EV gate make decisions before going live.
    budget = parseEther(String(cfg.maxMinePerRoundEth));
  }
  if (budget < MIN_MINE_BET_WEI) return;

  const roundId = await ctx.sdk.lottery.currentRoundId();
  if (state.openMineRounds.includes(roundId.toString())) return; // one bet per round

  const [open, bettingEnd, round, price] = await Promise.all([
    ctx.sdk.lottery.roundOpen(roundId),
    ctx.sdk.lottery.bettingEnd(roundId),
    ctx.sdk.lottery.getRound(roundId),
    ctx.sdk.getSlvrPrice().catch(() => ({ eth: undefined as number | undefined, usd: null })),
  ]);
  const secondsLeft = Number(bettingEnd) - Math.floor(Date.now() / 1000);

  // Size the bet gradually: pace the budget over the rounds until the next
  // claim so it lasts (and grows as you add more ETH — bigger budget, bigger
  // per-round bet), never below the gas-efficient minimum, never above your
  // Max ETH per round cap.
  const gasWei = await mineGasCostWei(ctx);
  if (gasWei > MINE_GAS_CEILING_WEI) {
    if (open && secondsLeft >= cfg.minSecondsLeft) {
      log(`  ⛏ holding: network gas is unusually high (round trip ≈ ${fmtEth(gasWei)}, normal ~0.0008) — waiting for it to settle`);
    }
    return;
  }
  const minStakeWei = gasWei * MIN_STAKE_GAS_MULTIPLE;
  const maxPerRound = parseEther(String(cfg.maxMinePerRoundEth));
  const horizonSec = claimHorizonSec(cfg);
  const cycleSec = await roundCycleSec(ctx, roundId);
  const p = pace(cfg);
  let stakeWei = sizeStake(budget, gasWei, p.bets, maxPerRound);
  let accountFeeWei = 0n;
  let capForStake = budget; // dry-run: only the earmarked budget limits us
  if (cfg.live) {
    // The first bet ever also opens the miner account (one-time contract
    // fee, ~0.0001 ETH) — leave room for it beside the stake.
    if (!(await ctx.sdk.lottery.hasAccount(ctx.account!.address))) {
      accountFeeWei = await ctx.sdk.lottery.accountDeposit();
    }
    const cap = await spendable(ctx);
    capForStake = cap > accountFeeWei ? cap - accountFeeWei : 0n;
    if (stakeWei > capForStake) stakeWei = capForStake;
  }
  if (stakeWei < minStakeWei || stakeWei < MIN_MINE_BET_WEI) {
    if (open && secondsLeft >= cfg.minSecondsLeft) {
      const blocker = maxPerRound < minStakeWei
        ? `your Max ETH per round (${cfg.maxMinePerRoundEth}) is below it — raise it in Settings to mine`
        : `the budget can field only ${fmtEth(stakeWei)}`;
      log(`  ⛏ holding: a gas-efficient bet needs ≥ ${fmtEth(minStakeWei)} (round-trip gas ≈ ${fmtEth(gasWei)}), ${blocker}`);
    }
    return;
  }

  // When the gas floor forces a bigger bet than an even spread would use,
  // keep the cadence sustainable by spacing bets out in time instead — the
  // budget still lasts to the horizon, just in fewer, larger bets.
  if (cfg.live) {
    const roundsAffordable = Math.max(1, Number(budget / stakeWei));
    const spacingSec = betGapSec(horizonSec, roundsAffordable, cycleSec, p.maxGapSec);
    const sinceLast = Math.floor(Date.now() / 1000) - (state.lastMineTs || 0);
    if (spacingSec > cycleSec * 1.5 && sinceLast < spacingSec) {
      if (open && secondsLeft >= cfg.minSecondsLeft) {
        const etaMin = Math.max(1, Math.ceil((spacingSec - sinceLast) / 60));
        log(`  ⛏ pacing: next bet in ~${etaMin}m (bets of ${fmtEth(stakeWei)}, ${fmtEth(budget)} budget)`);
      }
      return;
    }
  }

  // Price the round for the strategy, NET OF GAS. The pot passed in includes
  // our own stake (what the pot becomes once we bet) — this also keeps a
  // brand-new round (pot 0) from tripping the math.
  const rawEv = await ctx.sdk
    .estimateRoundEv({
      stake: Number(formatEther(stakeWei)),
      roundId,
      pot: Number(formatEther(round.totalWager + stakeWei)),
      cashOut: cfg.valueSlvrAsCashOut,
      ...(price.eth !== undefined ? { slvrPriceEth: price.eth } : {}),
    })
    .catch(() => null);
  const ev = rawEv ? gasAdjustEv(rawEv, stakeWei, gasWei) : null;

  const decide = pickMiningStrategy(cfg);
  const waitedSec = Math.floor(Date.now() / 1000) - (state.lastMineTs || 0);
  const d = decide(cfg, { open, secondsLeft, potEth: Number(formatEther(round.totalWager)), ev, waitedSec });
  if (!d.act) {
    // Quiet skips for the uninteresting cases; reasons for the strategic ones.
    if (open && secondsLeft >= cfg.minSecondsLeft) log(`  ⛏ round #${roundId}: ${d.reason}`);
    return;
  }
  log(`  ⛏ round #${roundId}: ${d.reason}`);

  // A strategy may ask to bet more on a high-edge round. Scale the base stake,
  // clamped to your Max ETH per round, the budget, and the spendable balance.
  // (The EV above was priced at the base stake; a bigger bet inflates the pot
  // slightly more, so the realized edge is marginally lower — negligible at
  // the ≤3x cap, and we only scale when the edge is already high.)
  if (d.sizeMultiplier && d.sizeMultiplier > 1) {
    let want = stakeWei * BigInt(Math.round(d.sizeMultiplier * 100)) / 100n;
    if (want > maxPerRound) want = maxPerRound;
    if (want > budget) want = budget;
    if (want > capForStake) want = capForStake;
    if (want > stakeWei) {
      log(`  ⛏ scaling up ${(Number(want) / Number(stakeWei)).toFixed(1)}x for the high edge → ${fmtEth(want)}`);
      stakeWei = want;
    }
  }

  // Rolling per-day total-spend ceiling (shared with buybacks): never let a
  // mining bet push the day's automated spend over maxDailySpendEth. Trim to
  // what's left, or hold if what's left won't cover a gas-efficient bet.
  {
    const now = Math.floor(Date.now() / 1000);
    const remain = dailyRemainingWei(cfg, state, now);
    if (remain !== null && stakeWei > remain) {
      if (remain < minStakeWei || remain < MIN_MINE_BET_WEI) {
        if (open && secondsLeft >= cfg.minSecondsLeft) {
          log(`  ⛏ holding: daily spend cap reached (${cfg.maxDailySpendEth} ETH/day) — mining resumes as the rolling 24h window frees up`);
        }
        return;
      }
      log(`  ⛏ trimming bet to ${fmtEth(remain)} to stay under the daily spend cap (${cfg.maxDailySpendEth} ETH/day)`);
      stakeWei = remain;
    }
  }

  if (!cfg.live) {
    log(`  ⛏ [dry-run] would bet ${fmtEth(stakeWei)} across all ${GRID_SIZE} squares in round #${roundId}`);
    return;
  }

  // Spread evenly over all 25 squares → we always hold the winning square.
  const per = stakeWei / BigInt(GRID_SIZE);
  const amounts = Array.from({ length: GRID_SIZE }, () => per);
  amounts[0] += stakeWei - per * BigInt(GRID_SIZE);
  const squares = Array.from({ length: GRID_SIZE }, (_, i) => i);

  // Record the bet before sending so a slow RPC can't double-bet the round.
  state.openMineRounds.push(roundId.toString());
  state.mineBudgetWei = (budget - stakeWei).toString();
  saveState(state);

  if (accountFeeWei > 0n) {
    log(`  ⛏ first bet: also opening your miner account (one-time ${fmtEth(accountFeeWei)} contract fee)`);
  }
  log(`  ⛏ betting ${fmtEth(stakeWei)} across ${GRID_SIZE} squares in round #${roundId}…`);
  try {
    const hash = await ctx.sdk.lottery.bet({ roundId, squares, amounts });
    await ctx.publicClient.waitForTransactionReceipt({ hash });
    // Advance the pacing clock ONLY after a bet actually lands — a failed
    // attempt must not delay the next real bet by a full spacing interval —
    // and record the spend in the rolling daily ledger (shared with buybacks).
    const done = loadState();
    done.lastMineTs = Math.floor(Date.now() / 1000);
    pruneSpend(done, done.lastMineTs);
    recordSpend(done, stakeWei, 'mine', done.lastMineTs);
    saveState(done);
    state.lastMineTs = done.lastMineTs;
    state.spendLog = done.spendLog;
    log(`  ✅ mining bet placed (tx ${hash.slice(0, 12)}…)`);
    logEvent('mine_bet', { ethWei: stakeWei, txHash: hash, detail: `round #${roundId}` });
  } catch (err) {
    // The send OR the receipt failed — we can't know if the bet landed. Put
    // the slice back in the budget (worst case: slightly inflated accounting,
    // capped by the real wallet balance) but KEEP the round tracked: if the
    // bet did land, settle claims its winnings next cycle; if it didn't,
    // settle finds nothing to claim and retires the round. Never drop a
    // possibly-live bet from tracking — that would forfeit real winnings.
    const fresh = loadState();
    fresh.mineBudgetWei = (BigInt(fresh.mineBudgetWei) + stakeWei).toString();
    saveState(fresh);
    throw err;
  }
}
