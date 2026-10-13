import Database from "better-sqlite3";
import { config } from "../config/config";

export const borrowersDb = new Database(config.borrowersDbPath);
borrowersDb.pragma("journal_mode = WAL");

// borrowers: every address that has ever taken out a loan (a Borrow event) within the
// discovery window, kept across restarts so the expensive deep history scan runs once.
//   - status 'dormant' means the last health-factor check found no debt; a new Borrow event
//     revives it (debt can only originate from a Borrow event, so dormant addresses never need
//     re-checking on a timer).
//   - tier says how often an active borrower is polled: 'hot' (close to liquidation, polled every
//     tick on the primary RPC) or 'cold' (safely healthy, swept occasionally on the free RPC).
//
// kv_state: small key/value store for scan progress (which blocks have been covered), so a
// restart resumes where it left off instead of rescanning.
borrowersDb.exec(`
  CREATE TABLE IF NOT EXISTS borrowers (
    address TEXT PRIMARY KEY,
    first_seen_block INTEGER NOT NULL,
    last_borrow_block INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    tier TEXT NOT NULL DEFAULT 'cold',
    last_health_factor TEXT,
    last_checked_block INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_borrowers_status_tier ON borrowers (status, tier);

  CREATE TABLE IF NOT EXISTS kv_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export type BorrowerTier = "hot" | "cold";
export type BorrowerStatus = "active" | "dormant";

export interface StoredBorrower {
  address: string;
  tier: BorrowerTier;
  /** Health factor at the last check (raw 18-decimal string), or null if never checked. */
  lastHealthFactor: string | null;
}

/** Result of recording a Borrow event for an address. */
export type UpsertResult = "new" | "revived" | "existing";

const getBorrowerStmt = borrowersDb.prepare(
  `SELECT status, tier, last_checked_block FROM borrowers WHERE address = ?`,
);

const insertBorrowerStmt = borrowersDb.prepare(`
  INSERT INTO borrowers (address, first_seen_block, last_borrow_block, status, tier, updated_at)
  VALUES (@address, @block, @block, 'active', @tier, @now)
`);

const updateBorrowerOnEventStmt = borrowersDb.prepare(`
  UPDATE borrowers
  SET last_borrow_block = MAX(last_borrow_block, @block), first_seen_block = MIN(first_seen_block, @block),
      status = 'active', tier = @tier, updated_at = @now
  WHERE address = @address
`);

/**
 * Records a Borrow event for `address` at `blockNumber`. `tier` is the tier to store for a NEW or
 * REVIVED borrower: live events pass 'hot' (so the position gets checked immediately), deep
 * history scans pass 'cold' (the first cold sweep classifies them). An already-active borrower's
 * tier is left alone unless `forceTier` is set (a fresh live Borrow changes their position, so it
 * should be re-checked promptly).
 */
export function upsertBorrower(
  address: string,
  blockNumber: number,
  tier: BorrowerTier,
  forceTier = false,
): UpsertResult {
  const now = new Date().toISOString();
  const existing = getBorrowerStmt.get(address) as
    | { status: BorrowerStatus; tier: BorrowerTier; last_checked_block: number | null }
    | undefined;

  if (!existing) {
    insertBorrowerStmt.run({ address, block: blockNumber, tier, now });
    return "new";
  }

  // A dormant borrower is only revived by a Borrow that happened AFTER the check that found them
  // debt-free. Re-reading an older event (e.g. when the history scan is re-run further back) says
  // nothing about their current position, so it must not undo that.
  const revived =
    existing.status === "dormant" &&
    (existing.last_checked_block === null || blockNumber > existing.last_checked_block);
  if (existing.status === "dormant" && !revived) return "existing";

  const stored = revived || forceTier ? tier : existing.tier;
  updateBorrowerOnEventStmt.run({ address, block: blockNumber, tier: stored, now });
  return revived ? "revived" : "existing";
}

/** Runs many upsertBorrower calls in one transaction (much faster for a bulk history scan). */
export const upsertBorrowersBulk = borrowersDb.transaction(
  (events: { address: string; blockNumber: number }[], tier: BorrowerTier): { newAddresses: string[] } => {
    const newAddresses: string[] = [];
    for (const event of events) {
      if (upsertBorrower(event.address, event.blockNumber, tier) === "new") {
        newAddresses.push(event.address);
      }
    }
    return { newAddresses };
  },
);

const loadActiveStmt = borrowersDb.prepare(
  `SELECT address, tier, last_health_factor AS lastHealthFactor FROM borrowers WHERE status = 'active'`,
);

/** Every borrower not known to be debt-free, with the tier it was last placed in. */
export function loadActiveBorrowers(): StoredBorrower[] {
  return loadActiveStmt.all() as StoredBorrower[];
}

const setStateStmt = borrowersDb.prepare(`
  UPDATE borrowers
  SET tier = @tier, status = @status, last_health_factor = @hf, last_checked_block = @block, updated_at = @now
  WHERE address = @address
`);

/** Records a health-factor check's outcome: the borrower's new tier/status and the value seen. */
export const setBorrowerStates = borrowersDb.transaction(
  (
    updates: { address: string; tier: BorrowerTier; status: BorrowerStatus; healthFactor: bigint | null; block: number }[],
  ): void => {
    const now = new Date().toISOString();
    for (const u of updates) {
      setStateStmt.run({
        address: u.address,
        tier: u.tier,
        status: u.status,
        hf: u.healthFactor === null ? null : u.healthFactor.toString(),
        block: u.block,
        now,
      });
    }
  },
);

const recordHfStmt = borrowersDb.prepare(
  `UPDATE borrowers SET last_health_factor = @hf, last_checked_block = @block, updated_at = @now WHERE address = @address`,
);

/** Saves the health factor just observed for many borrowers at once (used by the cold sweep). */
export const recordHealthFactorsBulk = borrowersDb.transaction(
  (entries: { address: string; healthFactor: bigint; block: number }[]): void => {
    const now = new Date().toISOString();
    for (const e of entries) {
      recordHfStmt.run({ address: e.address, hf: e.healthFactor.toString(), block: e.block, now });
    }
  },
);

const getKvStmt = borrowersDb.prepare(`SELECT value FROM kv_state WHERE key = ?`);
const setKvStmt = borrowersDb.prepare(
  `INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
);

/** Reads a persisted number (e.g. scan progress), or null if it was never set. */
export function getStateNumber(key: string): number | null {
  const row = getKvStmt.get(key) as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

/** Persists a number under `key`. */
export function setStateNumber(key: string, value: number): void {
  setKvStmt.run(key, String(value));
}

const countStmt = borrowersDb.prepare(
  `SELECT status, tier, COUNT(*) AS n FROM borrowers GROUP BY status, tier`,
);

/** Row counts by status/tier, for startup and progress logging. */
export function countBorrowers(): { status: BorrowerStatus; tier: BorrowerTier; n: number }[] {
  return countStmt.all() as { status: BorrowerStatus; tier: BorrowerTier; n: number }[];
}
