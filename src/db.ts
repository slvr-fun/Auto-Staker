/**
 * Small SQLite database (data.sqlite in the app folder) tracking everything
 * the automation does, so the UI can show earnings and history.
 *
 *   events    — every action taken (claims, transfers, buybacks, bets, …)
 *   snapshots — periodic position/balance readings, for the trend chart
 *
 * Uses Node's built-in `node:sqlite` (Node 22.13+) — no native module to
 * compile, which matters for non-technical users installing this.
 * Amounts are stored as wei strings; sums are computed in JS with BigInt so
 * precision is never lost.
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config';

export type EventType =
  | 'claim'          // claimed ETH staking rewards        (eth_wei = amount claimed)
  | 'hold_transfer'  // sent hold % to the hold wallet     (eth_wei = amount sent)
  | 'buyback'        // bought SLVR with ETH               (eth_wei spent, slvr_wei received)
  | 'max_lock'       // SLVR added to the max lock         (slvr_wei locked)
  | 'mine_bet'       // placed a mining bet                (eth_wei = stake)
  | 'mine_settle'    // settled a mining round             (eth_wei winnings, slvr_wei mined)
  | 'stake'          // staked the veNFT
  | 'error';

export interface AppEvent {
  id: number;
  ts: number;
  type: EventType;
  ethWei: string;
  slvrWei: string;
  txHash: string | null;
  detail: string | null;
}

export interface Snapshot {
  ts: number;
  pendingEthWei: string;
  ethBalanceWei: string;
  slvrBalanceWei: string;
  lockedSlvrWei: string;
  slvrPriceEth: number | null;
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    type     TEXT    NOT NULL,
    eth_wei  TEXT    NOT NULL DEFAULT '0',
    slvr_wei TEXT    NOT NULL DEFAULT '0',
    tx_hash  TEXT,
    detail   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE TABLE IF NOT EXISTS price_history (
    ts       INTEGER PRIMARY KEY,
    price_eth REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    pending_eth_wei  TEXT NOT NULL DEFAULT '0',
    eth_balance_wei  TEXT NOT NULL DEFAULT '0',
    slvr_balance_wei TEXT NOT NULL DEFAULT '0',
    locked_slvr_wei  TEXT NOT NULL DEFAULT '0',
    slvr_price_eth   REAL
  );
`);

export function logEvent(
  type: EventType,
  fields: { ethWei?: bigint; slvrWei?: bigint; txHash?: string; detail?: string } = {}
): void {
  db.prepare(
    'INSERT INTO events (ts, type, eth_wei, slvr_wei, tx_hash, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    Math.floor(Date.now() / 1000),
    type,
    (fields.ethWei ?? 0n).toString(),
    (fields.slvrWei ?? 0n).toString(),
    fields.txHash ?? null,
    fields.detail ?? null
  );
}

export function recentEvents(limit = 50): AppEvent[] {
  const rows = db
    .prepare('SELECT id, ts, type, eth_wei, slvr_wei, tx_hash, detail FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    type: r.type,
    ethWei: r.eth_wei,
    slvrWei: r.slvr_wei,
    txHash: r.tx_hash,
    detail: r.detail,
  }));
}

export function logSnapshot(s: Omit<Snapshot, 'ts'>): void {
  // Guard against transient RPC zero-reads: the public RPC occasionally
  // returns 0 for eth_getBalance on a funded wallet, which would plot a false
  // dip to the floor on the chart. If this reads 0 but the most recent
  // snapshot within the last few minutes was nonzero, carry that value
  // forward. A genuine drain persists and is accepted once the recent-nonzero
  // window ages out.
  const ethBalanceWei = sanitizeZeroRead(s.ethBalanceWei);
  db.prepare(
    'INSERT INTO snapshots (ts, pending_eth_wei, eth_balance_wei, slvr_balance_wei, locked_slvr_wei, slvr_price_eth) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    Math.floor(Date.now() / 1000),
    s.pendingEthWei,
    ethBalanceWei,
    s.slvrBalanceWei,
    s.lockedSlvrWei,
    s.slvrPriceEth
  );
}

const ZERO_READ_CARRY_SEC = 300;
// Track the last GENUINE (measured) nonzero balance — NOT carried-forward
// writes. Anchoring to genuine reads is what lets the carry window age out: a
// real drain to 0 stops being masked after ZERO_READ_CARRY_SEC. (Anchoring to
// "the last row written" would re-stamp a recent nonzero row on every carry,
// so the window never expired and a genuine drain was masked forever.)
let lastGenuineEthWei = '';
let lastGenuineTs = 0;
function sanitizeZeroRead(ethBalanceWei: string): string {
  const now = Math.floor(Date.now() / 1000);
  if (ethBalanceWei && ethBalanceWei !== '0') {
    lastGenuineEthWei = ethBalanceWei;
    lastGenuineTs = now;
    return ethBalanceWei;
  }
  if (lastGenuineTs === 0) {
    // first zero-read this process — seed from the last known nonzero snapshot
    const last = db
      .prepare("SELECT eth_balance_wei, ts FROM snapshots WHERE eth_balance_wei != '0' ORDER BY id DESC LIMIT 1")
      .get() as { eth_balance_wei: string; ts: number } | undefined;
    if (last) { lastGenuineEthWei = last.eth_balance_wei; lastGenuineTs = last.ts; }
  }
  if (lastGenuineEthWei && lastGenuineEthWei !== '0' && now - lastGenuineTs < ZERO_READ_CARRY_SEC) {
    return lastGenuineEthWei;
  }
  return ethBalanceWei;
}

export function recentSnapshots(limit = 300): Snapshot[] {
  const rows = db
    .prepare(
      'SELECT ts, pending_eth_wei, eth_balance_wei, slvr_balance_wei, locked_slvr_wei, slvr_price_eth FROM snapshots ORDER BY id DESC LIMIT ?'
    )
    .all(limit) as any[];
  return rows.reverse().map((r) => ({
    ts: r.ts,
    pendingEthWei: r.pending_eth_wei,
    ethBalanceWei: r.eth_balance_wei,
    slvrBalanceWei: r.slvr_balance_wei,
    lockedSlvrWei: r.locked_slvr_wei,
    slvrPriceEth: r.slvr_price_eth,
  }));
}

/** Chartable snapshot columns (whitelist — column names never come from input). */
const SERIES_COLUMNS = {
  pending: 'pending_eth_wei',
  balance: 'eth_balance_wei',
  slvr: 'slvr_balance_wei',
  locked: 'locked_slvr_wei',
  price: 'slvr_price_eth',
} as const;
export type SeriesKey = keyof typeof SERIES_COLUMNS;

export interface SeriesPoint {
  t: number;
  v: number;
}

/**
 * A charting series from the snapshots table: raw readings for short ranges,
 * time-bucketed averages for long ones (so a week is ~150 points, not 20k).
 * Values are plain numbers — wei columns come back as floats, which is fine
 * for drawing (charts don't need 18-decimal precision).
 */
export function seriesSince(key: SeriesKey, sinceTs: number, bucketSeconds: number): SeriesPoint[] {
  const col = SERIES_COLUMNS[key];
  // price merges the live snapshots with backfilled market history
  const source = key === 'price'
    ? `(SELECT ts, CAST(${col} AS REAL) AS val FROM snapshots WHERE ${col} IS NOT NULL
        UNION ALL SELECT ts, price_eth AS val FROM price_history)`
    : `(SELECT ts, CAST(${col} AS REAL) AS val FROM snapshots WHERE ${col} IS NOT NULL)`;
  if (bucketSeconds <= 30) {
    const rows = db
      .prepare(`SELECT ts AS t, avg(val) AS v FROM ${source} WHERE ts >= ? GROUP BY ts ORDER BY ts ASC LIMIT 2000`)
      .all(sinceTs) as any[];
    return rows.map((r) => ({ t: r.t, v: r.v }));
  }
  const rows = db
    .prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS t, avg(val) AS v FROM ${source}
       WHERE ts >= ? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY t ASC LIMIT 2000`
    )
    .all(bucketSeconds, bucketSeconds, sinceTs, bucketSeconds) as any[];
  return rows.map((r) => ({ t: r.t, v: r.v }));
}

/**
 * Cumulative ETH earned over time: the unclaimed (pending) rewards at each
 * point PLUS everything already claimed before it. Unlike the pending
 * sawtooth — which drops to ~0 every time the automation claims — this only
 * ever rises, because a claim just moves value from "pending" into "claimed".
 * It's the honest earnings curve. Same wei-float units as the pending series.
 */
export function earnedSeriesSince(sinceTs: number, bucketSeconds: number): SeriesPoint[] {
  const pending = seriesSince('pending', sinceTs, bucketSeconds);
  const baseRow = db
    .prepare("SELECT COALESCE(SUM(CAST(eth_wei AS REAL)), 0) AS s FROM events WHERE type = 'claim' AND ts < ?")
    .get(sinceTs) as { s: number } | undefined;
  const baseline = baseRow?.s ?? 0;
  const claims = db
    .prepare("SELECT ts, CAST(eth_wei AS REAL) AS w FROM events WHERE type = 'claim' AND ts >= ? ORDER BY ts ASC")
    .all(sinceTs) as Array<{ ts: number; w: number }>;
  let ci = 0;
  let running = 0;
  let floor = 0; // cumulative earned only ever rises; clamp bucketing dips
  return pending.map((pt) => {
    while (ci < claims.length && claims[ci]!.ts <= pt.t) { running += claims[ci]!.w; ci++; }
    // A claim landing mid-bucket makes the *averaged* pending dip before the
    // claim amount is folded in; take the running max so the curve stays
    // monotonic (which is what "cumulative earned" means).
    floor = Math.max(floor, pt.v + baseline + running);
    return { t: pt.t, v: floor };
  });
}

/** Insert backfilled market prices (ignores timestamps we already have). */
export function insertPriceHistory(rows: Array<{ ts: number; priceEth: number }>): number {
  const stmt = db.prepare('INSERT OR IGNORE INTO price_history (ts, price_eth) VALUES (?, ?)');
  let n = 0;
  for (const r of rows) {
    if (Number.isFinite(r.priceEth) && r.priceEth > 0) n += Number(stmt.run(r.ts, r.priceEth).changes);
  }
  return n;
}

/** Earliest price reading we have (snapshots or backfill), or null. */
export function earliestPriceTs(): number | null {
  const row = db.prepare(
    `SELECT min(ts) AS t FROM (
       SELECT ts FROM snapshots WHERE slvr_price_eth IS NOT NULL
       UNION ALL SELECT ts FROM price_history)`
  ).get() as any;
  return row?.t ?? null;
}

export interface Metrics {
  totalClaimedEthWei: string;
  totalHeldEthWei: string;
  totalBuybackEthWei: string;
  totalSlvrBoughtWei: string;
  totalSlvrLockedWei: string;
  totalMineSpentEthWei: string;
  totalMineWinningsEthWei: string;
  totalSlvrMinedWei: string;
  claimCount: number;
  mineRoundCount: number;
}

/** Lifetime totals, summed with BigInt (events tables stay small — this is cheap). */
export function metrics(): Metrics {
  const rows = db.prepare('SELECT type, eth_wei, slvr_wei FROM events').all() as any[];
  const sum: Record<string, { eth: bigint; slvr: bigint; n: number }> = {};
  for (const r of rows) {
    const bucket = (sum[r.type] ??= { eth: 0n, slvr: 0n, n: 0 });
    bucket.eth += BigInt(r.eth_wei);
    bucket.slvr += BigInt(r.slvr_wei);
    bucket.n += 1;
  }
  const get = (t: EventType) => sum[t] ?? { eth: 0n, slvr: 0n, n: 0 };
  return {
    totalClaimedEthWei: get('claim').eth.toString(),
    totalHeldEthWei: get('hold_transfer').eth.toString(),
    totalBuybackEthWei: get('buyback').eth.toString(),
    totalSlvrBoughtWei: get('buyback').slvr.toString(),
    totalSlvrLockedWei: get('max_lock').slvr.toString(),
    totalMineSpentEthWei: get('mine_bet').eth.toString(),
    totalMineWinningsEthWei: get('mine_settle').eth.toString(),
    totalSlvrMinedWei: get('mine_settle').slvr.toString(),
    claimCount: get('claim').n,
    mineRoundCount: get('mine_bet').n,
  };
}
