/**
 * The automation cycle. Each pass:
 *
 *   0. adopt — no position selected yet? Adopt a veNFT the wallet already
 *      owns (created explicitly by the user via Buy & Lock / Max-lock). The
 *      automation NEVER buys or locks your wallet balance on its own.
 *   1. make sure the veNFT is staked (it can't earn otherwise)
 *   2. claim accrued ETH rewards once they pass the user's threshold
 *   3. split the claim:  hold% is transferred to the hold wallet (or kept) ·
 *      mine% is earmarked for grid mining · buyback% buys SLVR on the market
 *      and MAX-LOCKS it (compounding the position)
 *   4. spend the mining budget on good rounds (spread over all 25 squares,
 *      so the position always includes the winning square)
 *   5. settle finished mining rounds — claim winnings + mined SLVR
 *
 * Every action is recorded in the SQLite database so the UI can show
 * lifetime earnings and history.
 */
import { formatEther, parseEther, type Address } from 'viem';
import type { AppConfig, AppState } from './config';
import { loadState, saveState, saveConfig } from './config';
import type { Ctx } from './chain';
import { ensureStaked, getPosition, listPositions, maxLockSlvr } from './position';
import { buySlvr, capBuyByPriceImpact } from './swap';
import { logEvent, logSnapshot, seriesSince } from './db';
import { pickAllocationStrategy, pickBuybackStrategy } from './strategies';
import { spendable, pruneSpend, buys24h, dailyRemainingWei, recordSpend } from './budget';
import { runMining, isMiningFavorable } from './mining';

const fmtEth = (wei: bigint) => `${formatEther(wei)} ETH`;

function pctOf(amount: bigint, pct: number): bigint {
  return (amount * BigInt(Math.round(pct * 100))) / 10_000n;
}

export async function runCycle(ctx: Ctx, cfg: AppConfig, log: (line: string) => void = console.log): Promise<void> {
  const state = loadState();
  const me = ctx.account!.address as Address;

  // -- 0a. adopt a position the wallet already owns (created by the user via
  // Buy & Lock / Max-lock). The automation NEVER spends or converts your
  // wallet balance to create a position — that is an explicit choice you make
  // with the buttons, so importing a funded wallet can't auto-buy and lock it.
  if (!cfg.tokenId) {
    await adoptExistingPosition(ctx, cfg, log);
  }
  const position = cfg.tokenId ? await getPosition(ctx, BigInt(cfg.tokenId)) : null;

  // -- 0b. record a snapshot for the trend chart -----------------------------
  const [ethBal, slvrBal, price] = await Promise.all([
    ctx.publicClient.getBalance({ address: me }),
    ctx.sdk.token.balanceOf(me),
    ctx.sdk.getSlvrPrice().catch(() => null),
  ]);
  logSnapshot({
    pendingEthWei: (position?.pendingRewardsWei ?? 0n).toString(),
    ethBalanceWei: ethBal.toString(),
    slvrBalanceWei: slvrBal.toString(),
    lockedSlvrWei: (position?.lockedSlvr ?? 0n).toString(),
    slvrPriceEth: price?.eth ?? null,
  });

  if (ethBal < parseEther('0.002')) {
    log(`  ⚠ LOW GAS: the miner wallet holds only ${fmtEth(ethBal)} — fund it so transactions keep flowing`);
  }

  if (position) await earnAndClaim(ctx, cfg, state, position, log);

  // NOTE: the automation only ever spends CLAIMED REWARDS. Your wallet ETH and
  // SLVR are principal + gas and are never auto-spent, swept, or locked. The
  // mining and buyback budgets below are funded solely by the mine%/buyback%
  // split of each claim (see earnAndClaim).

  // -- 3. smart buybacks: buy the dip when the budget and signal line up -----
  await maybeBuyback(ctx, cfg, state, price?.eth ?? null, log);

  // -- 4+5. mining engine: settle finished rounds, then place a paced bet.
  // All the mining logic (sizing, gas rails, pacing) lives in mining.ts —
  // customize it there without touching the money-splitting above.
  await runMining(ctx, cfg, state, log);
}

type Position = Awaited<ReturnType<typeof getPosition>>;

/** Steps 1-2: keep the veNFT staked, claim rewards past the threshold, split the claim. */
async function earnAndClaim(ctx: Ctx, cfg: AppConfig, state: AppState, position: Position, log: (line: string) => void): Promise<void> {
  const tokenId = BigInt(cfg.tokenId);
  const tag = cfg.live ? '' : ' [dry-run]';

  // -- 1. make sure we're actually earning -----------------------------------
  if (await ensureStaked(ctx, position, cfg.live)) {
    logEvent('stake', { detail: `staked veNFT #${tokenId}` });
  }

  // -- 2. claim ETH rewards when they pass the threshold ---------------------
  const pending = position.pendingRewardsWei;
  const threshold = parseEther(String(cfg.minClaimEth));
  log(`  rewards accrued: ${fmtEth(pending)} (claims at ${cfg.minClaimEth} ETH)`);

  if (pending >= threshold && pending > 0n) {
    const holdWei = pctOf(pending, cfg.holdPct);
    let mineWei = pctOf(pending, cfg.minePct);
    let buybackWei = pending - holdWei - mineWei; // remainder → no rounding dust lost

    // Allocation strategy: decide where the non-hold share goes.
    {
      const decide = pickAllocationStrategy(cfg);
      const d = decide(cfg, { miningFavorable: await isMiningFavorable(ctx, cfg) });
      if (d.route === 'mine') { mineWei = mineWei + buybackWei; buybackWei = 0n; }
      else if (d.route === 'buyback') { buybackWei = mineWei + buybackWei; mineWei = 0n; }
      log(`  ⚖ ${d.reason}`);
    }

    log(
      `  → claiming${tag}: hold ${fmtEth(holdWei)} · mine ${fmtEth(mineWei)} · buyback ${fmtEth(buybackWei)}`
    );

    if (cfg.live) {
      const hash = await ctx.sdk.staking.claimStakerRewards(tokenId);
      await ctx.publicClient.waitForTransactionReceipt({ hash });
      log(`  ✅ claimed ${fmtEth(pending)} (tx ${hash.slice(0, 12)}…)`);
      logEvent('claim', { ethWei: pending, txHash: hash, detail: `veNFT #${tokenId}` });

      // Earmark the mining share; it is spent gradually by step 4.
      state.mineBudgetWei = (BigInt(state.mineBudgetWei) + mineWei).toString();
      saveState(state);

      // Hold share: sent to the hold wallet, or — with none configured —
      // kept in this wallet and tracked as held rewards so the automation
      // never re-spends it.
      if (holdWei > 0n && !cfg.holdWalletAddress) {
        state.holdKeptWei = (BigInt(state.holdKeptWei) + holdWei).toString();
        saveState(state);
      }
      if (holdWei > 0n && cfg.holdWalletAddress) {
        const budget = await spendable(ctx);
        const toSend = holdWei <= budget ? holdWei : budget;
        if (toSend > 0n) {
          const txHash = await ctx.walletClient!.sendTransaction({
            account: ctx.account!,
            chain: ctx.publicClient.chain,
            to: cfg.holdWalletAddress as Address,
            value: toSend,
          });
          await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
          log(`  ✅ sent ${fmtEth(toSend)} to hold wallet ${cfg.holdWalletAddress.slice(0, 10)}… (tx ${txHash.slice(0, 12)}…)`);
          logEvent('hold_transfer', { ethWei: toSend, txHash, detail: cfg.holdWalletAddress });
        }
      }

      // Earmark the buyback share. The actual buying — and EVERY spend limit
      // (per-buy cap, per-day count/total caps, price impact, rate limit) —
      // happens in one place: maybeBuyback below. It buys immediately in
      // 'instant' mode or waits for a price dip in 'smart' mode, so a big
      // budget is always deployed in measured, limit-respecting slices.
      if (buybackWei > 0n) {
        state.buybackBudgetWei = (BigInt(state.buybackBudgetWei) + buybackWei).toString();
        if (!state.buybackSince) state.buybackSince = Math.floor(Date.now() / 1000);
        saveState(state);
        log(
          cfg.buybackMode === 'smart'
            ? `  → earmarked ${fmtEth(buybackWei)} for buybacks — waiting for a dip in the price`
            : `  → earmarked ${fmtEth(buybackWei)} for buyback — buying now, within your spend limits`
        );
      }
    }
  }
}

/** Don't dip-buy amounts smaller than this (gas would eat them). */
const MIN_BUYBACK_WEI = parseEther('0.0002');

/**
 * If no position is selected yet, adopt a veNFT the wallet already owns —
 * created by the user via the Buy & Lock or Max-lock buttons (or in a prior
 * run). That is the ONLY way a position comes into being: the automation
 * never converts your wallet ETH or SLVR into a locked position on its own.
 * Importing a funded wallet therefore can't auto-buy and permanently lock
 * your balance — you decide how much to stake, explicitly, with the buttons.
 */
async function adoptExistingPosition(ctx: Ctx, cfg: AppConfig, log: (l: string) => void): Promise<void> {
  const me = ctx.account!.address as Address;
  const owned = (await listPositions(ctx, me)).find((p) => p.lockedSlvr > 0n);
  if (owned) {
    adoptPosition(cfg, owned.tokenId, log);
    return;
  }
  log('  ⓘ no position yet — use Buy & Lock (choose an ETH amount) or Max-lock to create one. Mining and buybacks then run on your CLAIMED rewards only; your wallet balance is never auto-spent.');
}

/** Select a veNFT as THE position in config — same effect as picking it in Settings. */
function adoptPosition(cfg: AppConfig, tokenId: bigint, log: (l: string) => void): void {
  cfg.tokenId = tokenId.toString();
  saveConfig(cfg);
  log(`  ✅ veNFT #${tokenId} is now your position — selected automatically`);
  logEvent('stake', { detail: `adopted veNFT #${tokenId} as the position` });
}

/**
 * Spend the earmarked buyback budget, buying SLVR and max-locking it. This is
 * the ONE place buybacks actually happen (both modes) so every spend limit is
 * enforced in a single spot:
 *   - 'instant' mode buys as soon as a claim earmarks budget;
 *   - 'smart' mode buys only when SLVR trades below its recent average (into
 *     sell pressure), with a time valve so the budget never waits forever.
 * In both modes the trade is bounded by: the rate limit (min interval), the
 * per-buy ETH cap, the rolling per-day count + total-spend caps, the price-
 * impact cap, and the wallet gas reserve. A big budget is therefore always
 * deployed in measured slices instead of all at once.
 */
async function maybeBuyback(ctx: Ctx, cfg: AppConfig, state: AppState, priceEth: number | null, log: (l: string) => void): Promise<void> {
  const budget = BigInt(state.buybackBudgetWei);
  if (budget < MIN_BUYBACK_WEI) return;

  const now = Math.floor(Date.now() / 1000);
  pruneSpend(state, now);

  // Rate limit: don't buy more often than the configured interval.
  const sinceLast = now - (state.lastBuybackTs || 0);
  if (cfg.buybackMinIntervalMin > 0 && state.lastBuybackTs && sinceLast < cfg.buybackMinIntervalMin * 60) {
    const mins = Math.ceil((cfg.buybackMinIntervalMin * 60 - sinceLast) / 60);
    log(`  🛒 buyback budget ${fmtEth(budget)} waiting: next buy allowed in ~${mins}m (rate limit)`);
    return;
  }
  // Rolling per-day count cap (buybacks only).
  if (cfg.maxBuysPerDay > 0 && buys24h(state, now) >= cfg.maxBuysPerDay) {
    log(`  🛒 buyback budget ${fmtEth(budget)} waiting: daily buy limit reached (${cfg.maxBuysPerDay}/day)`);
    return;
  }

  // Decide whether to buy this cycle: instant = always; smart = dip signal.
  let why: string;
  if (cfg.buybackMode === 'smart') {
    const waitedHours = state.buybackSince ? (now - state.buybackSince) / 3600 : 0;
    const hist = seriesSince('price', now - cfg.buybackLookbackMin * 60, 30);
    const smaEth = hist.length >= 5 ? hist.reduce((a, p) => a + p.v, 0) / hist.length : null;
    const decide = pickBuybackStrategy(cfg);
    const d = decide(cfg, { priceEth, smaEth, waitedHours });
    if (!d.act) {
      log(`  🛒 buyback budget ${fmtEth(budget)} waiting: ${d.reason}`);
      return;
    }
    why = d.reason;
  } else {
    why = 'instant buyback: buying the claim share now';
  }

  // --- Size the trade under every spend limit ------------------------------
  let toSwap = budget;
  // Smart mode's per-cycle slice (spreads a big budget over cycles).
  if (cfg.buybackMode === 'smart') {
    const maxSlice = parseEther(String(cfg.maxBuybackPerCycleEth));
    if (toSwap > maxSlice) toSwap = maxSlice;
  }
  // Per-buy hard ceiling (both modes).
  if (cfg.maxEthPerBuy > 0) {
    const perBuy = parseEther(String(cfg.maxEthPerBuy));
    if (toSwap > perBuy) toSwap = perBuy;
  }
  // Rolling per-day total-spend ceiling (mining + buybacks combined).
  const remain = dailyRemainingWei(cfg, state, now);
  if (remain !== null && toSwap > remain) {
    toSwap = remain;
    if (remain < MIN_BUYBACK_WEI) {
      log(`  🛒 buyback budget ${fmtEth(budget)} waiting: daily spend cap reached (${cfg.maxDailySpendEth} ETH/day)`);
      return;
    }
  }
  // Never touch the gas reserve.
  if (cfg.live) {
    const cap = await spendable(ctx);
    if (toSwap > cap) toSwap = cap;
  }
  if (toSwap < MIN_BUYBACK_WEI) return;

  // Cap the trade so it doesn't move the SLVR price more than the user's limit.
  let impactNote = '';
  if (cfg.maxBuybackPriceImpactPct > 0) {
    const { amountWei, impactPct } = await capBuyByPriceImpact(ctx, toSwap, cfg.maxBuybackPriceImpactPct);
    if (amountWei < toSwap) {
      log(`  🛒 trimming buy from ${fmtEth(toSwap)} to ${fmtEth(amountWei)} to keep price impact ≤ ${cfg.maxBuybackPriceImpactPct}%`);
      toSwap = amountWei;
    }
    impactNote = ` · ~${impactPct.toFixed(2)}% impact`;
    if (toSwap < MIN_BUYBACK_WEI) return;
  }

  log(`  🛒 ${why}${impactNote}`);
  if (!cfg.live) {
    log(`  🛒 [dry-run] would buy SLVR with ${fmtEth(toSwap)} and max-lock it`);
    return;
  }

  // Deduct before sending so a slow RPC can't double-spend the budget.
  const buybackSinceBefore = state.buybackSince; // preserve if the swap fails
  state.buybackBudgetWei = (budget - toSwap).toString();
  if (BigInt(state.buybackBudgetWei) < MIN_BUYBACK_WEI) state.buybackSince = 0;
  saveState(state);

  // The BUY and the LOCK are separated on purpose. The refund below covers ONLY
  // a failed buy (no ETH spent). Once the buy lands, the ETH is gone: the budget
  // stays deducted and the spend is recorded, whatever happens with the lock —
  // otherwise a lock failure would refund the budget and re-buy the same ETH
  // next cycle (a double-spend). A failed lock just leaves the SLVR in the
  // wallet to be locked later.
  let slvrReceived: bigint;
  try {
    const r = await buySlvr(ctx, toSwap, cfg.slippagePct);
    slvrReceived = r.slvrReceived;
    logEvent('buyback', { ethWei: toSwap, slvrWei: slvrReceived, txHash: r.txHash, detail: cfg.buybackMode === 'smart' ? (why.startsWith('budget') ? 'time valve' : 'dip buy') : 'instant buy' });
    // ETH is spent — record the buy time (rate limit) + the rolling daily ledger.
    const done = loadState();
    done.lastBuybackTs = Math.floor(Date.now() / 1000);
    recordSpend(done, toSwap, 'buy', done.lastBuybackTs);
    saveState(done);
    state.lastBuybackTs = done.lastBuybackTs;
    state.spendLog = done.spendLog;
  } catch (err) {
    // The buy never landed — put the slice back and keep the ORIGINAL wait clock
    // so the max-wait valve isn't reset every time a swap fails.
    const fresh = loadState();
    fresh.buybackBudgetWei = (BigInt(fresh.buybackBudgetWei) + toSwap).toString();
    fresh.buybackSince = buybackSinceBefore || fresh.buybackSince || now;
    saveState(fresh);
    throw err;
  }

  // Max-lock the bought SLVR. A failure here does NOT refund the budget (the ETH
  // is already spent) — the SLVR sits in the wallet and locks on a later buyback
  // or a manual Max-lock.
  if (slvrReceived > 0n) {
    try {
      const lockedInto = await maxLockSlvr(ctx, slvrReceived);
      logEvent('max_lock', { slvrWei: slvrReceived, detail: `veNFT #${lockedInto}` });
    } catch (err) {
      log(`  ⚠ bought ${formatEther(slvrReceived)} SLVR but max-lock failed — it's in your wallet and will lock on a later buyback (or use Max-lock). ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
}
