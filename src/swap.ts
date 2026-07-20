/**
 * Buying SLVR with ETH through the Uniswap V2 router.
 *
 * SLVR has a small buy tax (routed to the protocol jackpot), so we use the
 * fee-on-transfer swap variant and fold the tax into the minimum-out check.
 */
import { formatEther, getContract, type Address } from 'viem';
import type { Ctx } from './chain';
import { ADDRESSES, TOKEN_TAX_ABI } from './chain';

export interface SwapResult {
  slvrReceived: bigint;
  txHash: `0x${string}`;
}

/**
 * Cap an ETH buy amount so it moves the SLVR price by at most `maxImpactPct`.
 * Uses the router's own quotes: a small reference trade gives the spot rate,
 * the real trade gives the execution rate, and the shortfall between them is
 * the price impact. If the intended amount exceeds the cap, it's scaled down
 * (impact is ~linear in size, so this lands just under the cap). Returns the
 * amount to actually buy and the impact estimate. `maxImpactPct <= 0` = no cap.
 */
export async function capBuyByPriceImpact(
  ctx: Ctx,
  amountInWei: bigint,
  maxImpactPct: number
): Promise<{ amountWei: bigint; impactPct: number }> {
  if (maxImpactPct <= 0 || amountInWei <= 0n) return { amountWei: amountInWei, impactPct: 0 };
  const weth = await ctx.router.read.WETH();
  const path = [weth, ADDRESSES.token] as const;
  const ref = amountInWei / 200n > 10n ** 14n ? amountInWei / 200n : 10n ** 14n; // ~0.5% or 0.0001 ETH
  const spotOut = (await ctx.router.read.getAmountsOut([ref, [...path]])).at(-1)!;
  const spotRate = Number(spotOut) / Number(ref); // SLVR per wei of ETH at ~spot
  const impactOf = async (amt: bigint): Promise<number> => {
    if (amt <= 0n) return 0;
    const out = (await ctx.router.read.getAmountsOut([amt, [...path]])).at(-1)!;
    const rate = Number(out) / Number(amt);
    return spotRate > 0 ? Math.max(0, 1 - rate / spotRate) : 0;
  };
  const cap = maxImpactPct / 100;
  let amt = amountInWei;
  let impact = await impactOf(amt);
  // Scale down toward the cap. Impact is superlinear in trade size, so a plain
  // proportional step can overshoot; iterate a few times with a small safety
  // margin (0.95) until the estimate is at or under the cap.
  for (let i = 0; i < 4 && impact > cap; i++) {
    const factorBps = BigInt(Math.max(1, Math.floor((cap / impact) * 9500)));
    amt = (amt * factorBps) / 10_000n;
    impact = await impactOf(amt);
  }
  return { amountWei: amt, impactPct: impact * 100 };
}

/**
 * Read-only quote for a prospective buy: expected SLVR out (net of the buy tax)
 * and the price impact at that trade size. Used by the UI to show what a Buy &
 * Lock (or an onboarding allocation) would do BEFORE the user confirms.
 * No wallet or writes needed — works even while the keystore is locked.
 */
export async function quoteBuy(ctx: Ctx, ethWei: bigint): Promise<{ expectedSlvrWei: bigint; impactPct: number }> {
  if (ethWei <= 0n) return { expectedSlvrWei: 0n, impactPct: 0 };
  const tokenTax = getContract({
    address: ADDRESSES.token,
    abi: TOKEN_TAX_ABI,
    client: { public: ctx.publicClient },
  });
  const weth = await ctx.router.read.WETH();
  const path = [weth, ADDRESSES.token] as const;
  const [amounts, buyTaxBps] = await Promise.all([
    ctx.router.read.getAmountsOut([ethWei, [...path]]),
    tokenTax.read.buyTaxBps().catch(() => 0),
  ]);
  const grossOut = amounts[amounts.length - 1];
  const expectedSlvrWei = (grossOut * BigInt(10_000 - Number(buyTaxBps))) / 10_000n;
  // A very high cap never trims — capBuyByPriceImpact just measures the impact.
  const { impactPct } = await capBuyByPriceImpact(ctx, ethWei, 1000);
  return { expectedSlvrWei, impactPct };
}

/** How many times to re-quote a buy that REVERTED before giving up. */
const SWAP_ATTEMPTS = 3;
/** Hard ceiling on the retry slippage — we widen toward this, never past it. */
const SWAP_MAX_SLIPPAGE_PCT = 15;

/**
 * Swap `ethWei` for SLVR. `slippagePct` is on top of the quoted price and the
 * buy tax. Returns the SLVR actually received (measured by balance change).
 *
 * Resilient — but never double-spends. A thin, volatile pool can move between
 * quote and execution and REVERT the swap; a revert returns the ETH, so we
 * safely re-quote and retry (widening slippage a gentle step each time) up to
 * SWAP_ATTEMPTS times. Any THROWN error (the send is rejected, or the receipt
 * wait times out) is an INDETERMINATE outcome — the tx may already have landed
 * — so we do NOT resend a second value-bearing tx (that would double-spend the
 * ETH); we surface the error and let the caller refund + reconcile next cycle,
 * exactly like the mining engine does. At most one successful value tx per call.
 *
 * Execution PRICE is protected by the caller capping trade size with
 * capBuyByPriceImpact before calling (buybacks), and by the user's slippage
 * tolerance; the widen is kept modest so it never balloons an uncapped buy.
 */
export async function buySlvr(ctx: Ctx, ethWei: bigint, slippagePct: number): Promise<SwapResult> {
  if (!ctx.account) throw new Error('wallet required');
  const me = ctx.account.address as Address;

  const tokenTax = getContract({
    address: ADDRESSES.token,
    abi: TOKEN_TAX_ABI,
    client: { public: ctx.publicClient },
  });

  const weth = await ctx.router.read.WETH();
  const path = [weth, ADDRESSES.token] as const;
  const buyTaxBps = await tokenTax.read.buyTaxBps().catch(() => 0);

  let lastRevert = '';
  for (let attempt = 1; attempt <= SWAP_ATTEMPTS; attempt++) {
    // Gentle widen on each retry (a transient move is the usual revert cause);
    // +2% per attempt, never past the ceiling. Only reverts reach a retry, and
    // a revert returns the ETH, so this can never over-spend.
    const attemptSlippage = Math.min(SWAP_MAX_SLIPPAGE_PCT, slippagePct + (attempt - 1) * 2);

    // Re-quote fresh every attempt so minOut reflects the current pool.
    const [amounts, balanceBefore] = await Promise.all([
      ctx.router.read.getAmountsOut([ethWei, [...path]]),
      ctx.sdk.token.balanceOf(me),
    ]);
    const quotedOut = amounts[amounts.length - 1];

    // minOut = quote, minus buy tax, minus the slippage tolerance.
    const afterTax = (quotedOut * BigInt(10_000 - Number(buyTaxBps))) / 10_000n;
    const slippageBps = BigInt(Math.round(attemptSlippage * 100));
    const minOut = (afterTax * (10_000n - slippageBps)) / 10_000n;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    // A throw from EITHER the send or the receipt wait is indeterminate — the
    // tx may have landed. Never retry it; rethrow so the caller can reconcile.
    let txHash: `0x${string}`;
    let receipt: { status: 'success' | 'reverted' };
    try {
      txHash = await ctx.router.write.swapExactETHForTokensSupportingFeeOnTransferTokens(
        [minOut, [...path], me, deadline],
        { value: ethWei, account: ctx.account, chain: ctx.publicClient.chain }
      );
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (receipt.status === 'success') {
      const balanceAfter = await ctx.sdk.token.balanceOf(me);
      const slvrReceived = balanceAfter - balanceBefore;
      console.log(
        `  ✅ bought ${formatEther(slvrReceived)} SLVR for ${formatEther(ethWei)} ETH (tx ${txHash.slice(0, 12)}…)`
      );
      return { slvrReceived, txHash };
    }

    // Definitive revert — ETH was returned. Safe to re-quote and retry.
    lastRevert = `swap reverted (tx ${txHash.slice(0, 12)}…)`;
    if (attempt < SWAP_ATTEMPTS) console.log(`  ↻ buy attempt ${attempt} reverted; re-quoting and retrying…`);
  }
  throw new Error(lastRevert || 'swap failed after retries');
}
