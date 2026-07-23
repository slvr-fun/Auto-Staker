/**
 * Read-only terminal views: `status` (your position + lifetime earnings) and
 * `check` (protocol snapshot, needs no wallet — verifies the install works).
 */
import { formatEther } from 'viem';
import { hasConfig, loadConfig, loadState, UI_PORT } from './config';
import { readOnlyCtx, walletCtx, lotteryFor } from './chain';
import { describePosition, getPosition, lockExpired } from './position';
import { metrics } from './db';

export async function showStatus(): Promise<void> {
  if (!hasConfig()) {
    console.log(`Not set up yet — run "npm start" and finish setup at http://localhost:${UI_PORT}.`);
    return;
  }
  const cfg = loadConfig();
  const state = loadState();
  const ctx = walletCtx();
  const me = ctx.account.address;

  const [ethBal, slvrBal, position, price] = await Promise.all([
    ctx.publicClient.getBalance({ address: me }),
    ctx.sdk.token.balanceOf(me),
    getPosition(ctx, BigInt(cfg.tokenId)),
    ctx.sdk.getSlvrPrice().catch(() => null),
  ]);
  const m = metrics();

  console.log('');
  console.log('── Your wallet ─────────────────────────────────────────');
  console.log(`  ${me}`);
  console.log(`  ETH:  ${formatEther(ethBal)}`);
  console.log(`  SLVR: ${formatEther(slvrBal)}`);
  console.log('');
  console.log('── Your position ───────────────────────────────────────');
  console.log(`  ${describePosition(position)}`);
  if (lockExpired(position)) {
    console.log('  ⚠ lock has EXPIRED — max-lock again (UI button) so it keeps earning.');
  }
  console.log('');
  console.log('── Automation ──────────────────────────────────────────');
  console.log(`  mode:         ${cfg.live ? 'LIVE' : 'DRY-RUN (printing only)'}`);
  console.log(`  split:        hold ${cfg.holdPct}% · mine ${cfg.minePct}% · buyback ${cfg.buybackPct}%`);
  console.log(`  hold wallet:  ${cfg.holdWalletAddress || '(none — hold share stays in this wallet)'}`);
  console.log(`  claims at:    ${cfg.minClaimEth} ETH accrued`);
  // Mirror pickMiningStrategy's precedence: an explicit miningStrategy wins,
  // otherwise it derives from the "only when profitable" switch.
  const potNote = cfg.maxPotEth > 0 ? ` (pot < ${cfg.maxPotEth} ETH)` : '';
  const strategy = cfg.miningStrategy
    ? `${cfg.miningStrategy}${potNote}`
    : cfg.mineOnlyWhenProfitable
      ? `EV-gated (edge ≥ ${cfg.minEdgePct}%${cfg.maxPotEth > 0 ? `, pot < ${cfg.maxPotEth} ETH` : ''})`
      : `always mine${potNote}`;
  console.log(`  strategy:     ${strategy}`);
  console.log(`  mine budget:  ${formatEther(BigInt(state.mineBudgetWei))} ETH waiting`);
  if (state.openMineRounds.length) {
    console.log(`  open rounds:  ${state.openMineRounds.map((r) => `#${r}`).join(', ')} (waiting to settle)`);
  }
  if (price) {
    console.log(`  SLVR price:   ${price.eth.toExponential(4)} ETH${price.usd != null ? ` ($${price.usd.toFixed(4)})` : ''}`);
  }
  console.log('');
  console.log('── Lifetime earnings ───────────────────────────────────');
  console.log(`  ETH claimed:        ${formatEther(BigInt(m.totalClaimedEthWei))} (${m.claimCount} claims)`);
  console.log(`  ETH sent to hold:   ${formatEther(BigInt(m.totalHeldEthWei))}`);
  console.log(`  SLVR bought/locked: ${formatEther(BigInt(m.totalSlvrBoughtWei))} / ${formatEther(BigInt(m.totalSlvrLockedWei))}`);
  console.log(`  SLVR mined:         ${formatEther(BigInt(m.totalSlvrMinedWei))} over ${m.mineRoundCount} rounds`);
  console.log('');
}

/** No-wallet sanity check: proves the install + RPC connection work. */
export async function showCheck(): Promise<void> {
  const ctx = readOnlyCtx();
  const roundId = await ctx.sdk.lottery.currentRoundId();
  const [open, round, price, totalWeight] = await Promise.all([
    lotteryFor(ctx, roundId).roundOpen(roundId),
    lotteryFor(ctx, roundId).getRound(roundId),
    ctx.sdk.getSlvrPrice().catch(() => null),
    ctx.sdk.staking.getTotalWeight(),
  ]);
  console.log('');
  console.log('✅ Connected to Robinhood Chain.');
  console.log(`  current round:  #${roundId} (${open ? 'open' : 'closed'}) · pot ${formatEther(round.totalWager)} ETH`);
  if (price) {
    console.log(`  SLVR price:     ${price.eth.toExponential(4)} ETH${price.usd != null ? ` ($${price.usd.toFixed(4)})` : ''}`);
  }
  console.log(`  total staked weight: ${formatEther(totalWeight)}`);
  console.log('');
}
