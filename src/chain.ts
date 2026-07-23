/**
 * Chain wiring: the Slvr SDK plus the two contracts this app talks to directly —
 * the SlvrVoteEscrow NFT (your lock) and the Uniswap V2 router (for buying SLVR).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
  type GetContractReturnType,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SlvrSDK, SlvrGridLottery, robinhoodChain, deployments, lotteryForRound, isMigrationLive } from '@slvr-labs/sdk';
import { loadRpcUrl } from './config';
import { getKey, keyStatus } from './keystore';

export const ADDRESSES = deployments.robinhood.addresses;

/** Live Uniswap V2 router on Robinhood Chain (same one the official interface uses). */
export const UNISWAP_V2_ROUTER: Address = '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba';

export const VOTE_ESCROW_ABI = parseAbi([
  'function getUserTokens(address user) view returns (uint256[])',
  'function getLock(uint256 tokenId) view returns ((uint256 amount, uint256 lockStart, uint256 lockEnd, bool permanent, bool isMaxTime))',
  'function getStakingWeight(uint256 tokenId) view returns (uint256)',
  'function getVotingPower(uint256 tokenId) view returns (uint256)',
  'function getMaxLockTokenId(address user) view returns (uint256)',
  'function getPermanentLockTokenId(address user) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function TMAX() view returns (uint256)',
  'function createLock(uint256 amount, uint256 duration) returns (uint256)',
  'function createPermanentLock(uint256 amount) returns (uint256)',
  'function increaseLock(uint256 tokenId, uint256 amount, uint256 newDuration)',
  'function increasePermanentLock(uint256 tokenId, uint256 amount)',
]);

export const ROUTER_ABI = parseAbi([
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
]);

// The SLVR token has a small buy tax; we read it so the swap's minimum-out is honest.
export const TOKEN_TAX_ABI = parseAbi(['function buyTaxBps() view returns (uint16)']);

// Contracts typed against a wallet-full client so `.write` is available; the
// write methods are only ever called from wallet-backed contexts.
type FullClient = { public: PublicClient; wallet: WalletClient };
export type VoteEscrowContract = GetContractReturnType<typeof VOTE_ESCROW_ABI, FullClient>;
export type RouterContract = GetContractReturnType<typeof ROUTER_ABI, FullClient>;

export interface Ctx {
  sdk: SlvrSDK;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  account?: Account;
  voteEscrow: VoteEscrowContract;
  router: RouterContract;
}

/**
 * ═══ THE GRID LOTTERY MIGRATION ═══ (read before touching mining)
 *
 * The grid game moved to a new lottery contract at `deployments.robinhood
 * .cutoverRound`. Round numbering is CONTINUOUS across the migration, so a
 * round id alone does not tell you which contract holds it:
 *
 *   round <  cutoverRound  → the legacy contract (`addresses.lotteryLegacy`)
 *   round >= cutoverRound  → the current contract (`addresses.lottery`)
 *
 * Both stay live — the old contract is never paused, so its rounds remain
 * resolvable and claimable forever (no deadline). That matters for us in two
 * ways, and getting either wrong loses real money:
 *
 *   1. BETTING must go to whichever contract is active for the CURRENT round.
 *      Before the cutover the new contract is deployed but NOT live: it
 *      accepts bets while minting no SLVR and holding no jackpot — betting
 *      there burns ETH for nothing.
 *   2. SETTLING must go to the contract that holds THAT round. A round we bet
 *      before the cutover is claimed on the legacy contract even long after
 *      the migration; claiming it on the new one would forfeit the winnings.
 *
 * `sdk.lottery` is bound to `addresses.lottery` (the current generation) and is
 * therefore NOT safe to use for either purpose on its own. Always resolve the
 * contract per round with `lotteryFor()` / `lotteryAddressFor()` below.
 */
export function lotteryAddressFor(roundId: bigint): Address {
  return lotteryForRound(deployments.robinhood, roundId);
}

/** A lottery client bound to the contract that actually holds `roundId`. */
export function lotteryFor(ctx: Ctx, roundId: bigint): SlvrGridLottery {
  return new SlvrGridLottery(ctx.publicClient, ctx.walletClient, lotteryAddressFor(roundId));
}

/** Has the migration to the current lottery actually happened at this round? */
export function migrationLive(currentRoundId: bigint): boolean {
  return isMigrationLive(deployments.robinhood, currentRoundId);
}

function makeTransport() {
  // Generous timeout + retries: the public RPC can be slow under polling.
  return http(loadRpcUrl(), { timeout: 20_000, retryCount: 4, retryDelay: 800 });
}

function makeVoteEscrow(publicClient: PublicClient, walletClient?: WalletClient): VoteEscrowContract {
  if (!ADDRESSES.voteEscrow) throw new Error('SDK deployment has no voteEscrow address');
  return getContract({
    address: ADDRESSES.voteEscrow,
    abi: VOTE_ESCROW_ABI,
    client: { public: publicClient, wallet: walletClient },
  }) as unknown as VoteEscrowContract;
}

function makeRouter(publicClient: PublicClient, walletClient?: WalletClient): RouterContract {
  return getContract({
    address: UNISWAP_V2_ROUTER,
    abi: ROUTER_ABI,
    client: { public: publicClient, wallet: walletClient },
  }) as unknown as RouterContract;
}

/** Read-only context — works with no private key at all. */
export function readOnlyCtx(): Ctx {
  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: makeTransport(),
    batch: { multicall: true },
  });
  const sdk = new SlvrSDK({ publicClient, addresses: ADDRESSES });
  return {
    sdk,
    publicClient,
    voteEscrow: makeVoteEscrow(publicClient),
    router: makeRouter(publicClient),
  };
}

/** Wallet-backed context — needs a stored (and unlocked) wallet. */
export function walletCtx(): Ctx & { account: Account; walletClient: WalletClient } {
  const pk = getKey();
  if (!pk) {
    const status = keyStatus();
    throw new Error(
      status.locked
        ? 'The wallet is locked — unlock it with your password in the UI.'
        : 'No wallet found. Create or import one in the UI (npm start).'
    );
  }
  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: makeTransport(),
    batch: { multicall: true },
  });
  const walletClient = createWalletClient({ chain: robinhoodChain, transport: makeTransport(), account });
  const sdk = new SlvrSDK({ publicClient, walletClient, addresses: ADDRESSES });
  return {
    sdk,
    publicClient,
    walletClient,
    account,
    voteEscrow: makeVoteEscrow(publicClient, walletClient),
    router: makeRouter(publicClient, walletClient),
  };
}
