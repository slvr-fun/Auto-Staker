/**
 * Reading and growing the user's veNFT position.
 */
import { formatEther, type Address } from 'viem';
import type { Ctx } from './chain';

export interface VePosition {
  tokenId: bigint;
  /** SLVR locked inside the veNFT. */
  lockedSlvr: bigint;
  lockEnd: bigint;
  permanent: boolean;
  isMaxTime: boolean;
  /** Weight currently counted by the staking contract (0 = not staked / expired). */
  stakedWeight: bigint;
  /** Weight the lock is worth right now. */
  currentWeight: bigint;
  /** ETH rewards claimable right now. */
  pendingRewardsWei: bigint;
}

export async function getPosition(ctx: Ctx, tokenId: bigint): Promise<VePosition> {
  const [lock, stakedWeight, currentWeight, pendingRewardsWei] = await Promise.all([
    ctx.voteEscrow.read.getLock([tokenId]),
    ctx.sdk.staking.balance(tokenId),
    ctx.voteEscrow.read.getStakingWeight([tokenId]),
    ctx.sdk.staking.getStakerRewards(tokenId),
  ]);
  return {
    tokenId,
    lockedSlvr: lock.amount,
    lockEnd: lock.lockEnd,
    permanent: lock.permanent,
    isMaxTime: lock.isMaxTime,
    stakedWeight,
    currentWeight,
    pendingRewardsWei,
  };
}

/** All veNFTs owned by an address, with their positions. */
export async function listPositions(ctx: Ctx, owner: Address): Promise<VePosition[]> {
  const ids = await ctx.voteEscrow.read.getUserTokens([owner]);
  return Promise.all(ids.map((id) => getPosition(ctx, id)));
}

export function describePosition(p: VePosition): string {
  const lockKind = p.permanent
    ? 'permanent lock'
    : `locked until ${new Date(Number(p.lockEnd) * 1000).toLocaleDateString()}`;
  const staked = p.stakedWeight > 0n ? 'earning rewards' : 'NOT currently staked';
  return (
    `veNFT #${p.tokenId} — ${formatEther(p.lockedSlvr)} SLVR (${lockKind}, ${staked})` +
    ` · claimable now: ${formatEther(p.pendingRewardsWei)} ETH`
  );
}

/** True if a non-permanent lock has already expired (adding to it would be pointless). */
export function lockExpired(p: VePosition, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return !p.permanent && p.lockEnd <= BigInt(nowSec);
}

/**
 * Make sure the veNFT is actually staked so it earns ETH rewards.
 * Returns true if a stake transaction was sent.
 */
export async function ensureStaked(ctx: Ctx, p: VePosition, live: boolean): Promise<boolean> {
  if (p.stakedWeight > 0n) return false;
  if (p.currentWeight === 0n) {
    console.log('  ⚠ veNFT has zero staking weight (expired lock?) — cannot stake it.');
    return false;
  }
  if (!live) {
    console.log('  [dry-run] would stake the veNFT so it starts earning ETH rewards');
    return false;
  }
  console.log('  → staking your veNFT so it starts earning ETH rewards…');
  const hash = await ctx.sdk.staking.stake(p.tokenId);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ✅ staked (tx ${hash.slice(0, 12)}…)`);
  return true;
}

/** Approve the vote-escrow to pull `amountSlvr` (it uses transferFrom), if needed. */
async function ensureAllowance(ctx: Ctx, amountSlvr: bigint): Promise<void> {
  if (!ctx.account) throw new Error('wallet required');
  const allowance = await ctx.sdk.token.allowance(ctx.account.address as Address, ctx.voteEscrow.address);
  if (allowance < amountSlvr) {
    const approveHash = await ctx.sdk.token.approve(ctx.voteEscrow.address, amountSlvr);
    await ctx.publicClient.waitForTransactionReceipt({ hash: approveHash });
  }
}

/**
 * MAX-LOCK `amountSlvr` from the wallet — the PERMANENT lock: the SLVR is
 * burned into the position, which earns ETH forever at the highest weight and
 * can never be withdrawn. Adds to the user's existing permanent lock, or
 * creates it (each account has exactly one). New locks are auto-staked by the
 * protocol, so they start earning immediately.
 *
 * Returns the tokenId that received the SLVR.
 */
export async function maxLockSlvr(ctx: Ctx, amountSlvr: bigint): Promise<bigint> {
  if (!ctx.account) throw new Error('wallet required');
  const me = ctx.account.address as Address;

  await ensureAllowance(ctx, amountSlvr);
  const existingId = await ctx.voteEscrow.read.getPermanentLockTokenId([me]);

  const writeOpts = { account: ctx.account, chain: ctx.publicClient.chain };
  if (existingId !== 0n) {
    const hash = await ctx.voteEscrow.write.increasePermanentLock([existingId, amountSlvr], writeOpts);
    await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✅ max-locked (burned) ${formatEther(amountSlvr)} SLVR into veNFT #${existingId} (tx ${hash.slice(0, 12)}…)`);
    return existingId;
  }
  const hash = await ctx.voteEscrow.write.createPermanentLock([amountSlvr], writeOpts);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  const newId = await ctx.voteEscrow.read.getPermanentLockTokenId([me]);
  console.log(`  ✅ created the permanent lock with ${formatEther(amountSlvr)} SLVR burned (veNFT #${newId}, tx ${hash.slice(0, 12)}…)`);
  return newId;
}

/**
 * Add SLVR from the wallet into a specific lock (compounds the position:
 * more locked SLVR → more staking weight → more ETH rewards).
 *
 * Handles both lock kinds: permanent locks use increasePermanentLock, timed
 * locks use increaseLock with duration 0 (keep the current end date).
 */
export async function addToLock(ctx: Ctx, p: VePosition, amountSlvr: bigint): Promise<void> {
  if (!ctx.account) throw new Error('wallet required');
  await ensureAllowance(ctx, amountSlvr);

  const hash = p.permanent
    ? await ctx.voteEscrow.write.increasePermanentLock([p.tokenId, amountSlvr], {
        account: ctx.account,
        chain: ctx.publicClient.chain,
      })
    : await ctx.voteEscrow.write.increaseLock([p.tokenId, amountSlvr, 0n], {
        account: ctx.account,
        chain: ctx.publicClient.chain,
      });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ✅ added ${formatEther(amountSlvr)} SLVR to veNFT #${p.tokenId} (tx ${hash.slice(0, 12)}…)`);
}
