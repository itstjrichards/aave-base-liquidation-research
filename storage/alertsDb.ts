import Database from "better-sqlite3";
import { config } from "../config/config";

export const alertsDb = new Database(config.alertsDbPath);
alertsDb.pragma("journal_mode = WAL");

// alert_episodes: one row per continuous stretch of a borrower being below the alert
// threshold, not one row per poll tick. A wallet sitting at HF 1.04 for an hour produces one
// episode (with a start, an end, and the worst HF/severity seen), not ~120 rows at a 30s poll
// interval — that distinction is what makes "how often does this wallet approach the
// threshold" a meaningful count instead of just "how many times did we happen to poll it".
//
// borrower_risk_profiles: a per-wallet rollup, updated incrementally as episodes open, update,
// and resolve, so answering "which wallets are repeat offenders" doesn't require aggregating
// every episode on every query.
alertsDb.exec(`
  CREATE TABLE IF NOT EXISTS alert_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_address TEXT NOT NULL,
    started_at TEXT NOT NULL,
    started_block INTEGER NOT NULL,
    min_health_factor TEXT NOT NULL,
    min_health_factor_block INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_seen_block INTEGER NOT NULL,
    last_health_factor TEXT NOT NULL,
    -- The collateral/debt pair observed when this episode began (a snapshot, not re-checked
    -- every tick — cheap enough to be worth having, not worth polling for on every observation).
    collateral_asset TEXT,
    debt_asset TEXT,
    -- Current severity tier as of last_seen_at, and the worst tier reached at any point in
    -- this episode's lifetime (an episode that touched 'critical' and drifted back to 'watch'
    -- still shows max_severity = 'critical' — that's the more informative stat once resolved).
    severity TEXT NOT NULL DEFAULT 'watch',
    max_severity TEXT NOT NULL DEFAULT 'watch',
    resolved_at TEXT,
    resolved_block INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE INDEX IF NOT EXISTS idx_alert_episodes_borrower ON alert_episodes (borrower_address);
  CREATE INDEX IF NOT EXISTS idx_alert_episodes_status ON alert_episodes (status);

  CREATE TABLE IF NOT EXISTS borrower_risk_profiles (
    borrower_address TEXT PRIMARY KEY,
    total_alert_episodes INTEGER NOT NULL DEFAULT 0,
    total_liquidations INTEGER NOT NULL DEFAULT 0,
    -- Episodes (not ticks) whose max_severity reached 'critical' — a much stronger "more
    -- likely to default" signal than total_alert_episodes alone, since that also counts
    -- wallets that only ever brush the mild 'watch' tier and always self-correct.
    times_reached_critical INTEGER NOT NULL DEFAULT 0,
    lowest_health_factor TEXT,
    lowest_health_factor_block INTEGER,
    first_alert_at TEXT NOT NULL,
    last_alert_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/** Adds `column` to `table` if an earlier version of the schema doesn't already have it. */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = alertsDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    alertsDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Migrate any alerts.db created before severity tiers / asset pairs were tracked.
ensureColumn("alert_episodes", "collateral_asset", "TEXT");
ensureColumn("alert_episodes", "debt_asset", "TEXT");
ensureColumn("alert_episodes", "severity", "TEXT NOT NULL DEFAULT 'watch'");
ensureColumn("alert_episodes", "max_severity", "TEXT NOT NULL DEFAULT 'watch'");
ensureColumn("borrower_risk_profiles", "times_reached_critical", "INTEGER NOT NULL DEFAULT 0");

export type AlertSeverity = "watch" | "warning" | "critical";

// Higher rank = more severe. Used to decide whether a tick escalates an episode's max_severity.
const SEVERITY_RANK: Record<AlertSeverity, number> = { watch: 1, warning: 2, critical: 3 };

/** True if `a` is at least as severe as `b` (e.g. isAtLeastAsSevere("critical", "warning")). */
function isAtLeastAsSevere(a: AlertSeverity, b: AlertSeverity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

/** A row exactly as stored — snake_case to match the SQL schema directly, no mapping layer. */
export interface AlertEpisodeRow {
  id: number;
  borrower_address: string;
  started_at: string;
  started_block: number;
  min_health_factor: string;
  min_health_factor_block: number;
  last_seen_at: string;
  last_seen_block: number;
  last_health_factor: string;
  collateral_asset: string | null;
  debt_asset: string | null;
  severity: AlertSeverity;
  max_severity: AlertSeverity;
  resolved_at: string | null;
  resolved_block: number | null;
  status: "active" | "recovered" | "liquidated";
}

export interface BorrowerRiskProfileRow {
  borrower_address: string;
  total_alert_episodes: number;
  total_liquidations: number;
  times_reached_critical: number;
  lowest_health_factor: string | null;
  lowest_health_factor_block: number | null;
  first_alert_at: string;
  last_alert_at: string;
  updated_at: string;
}

/** The collateral/debt pair to record when a new episode opens (see recordAlertTick). */
export interface AlertAssetPair {
  collateralAsset: string;
  debtAsset: string;
}

const getActiveEpisodeStmt = alertsDb.prepare(
  `SELECT * FROM alert_episodes WHERE borrower_address = ? AND status = 'active'`,
);

/** True if `borrowerAddress` already has an open episode — used to avoid re-fetching its
 *  collateral/debt pair (an RPC-heavy lookup) on every tick of an already-open episode. */
export function hasActiveAlertEpisode(borrowerAddress: string): boolean {
  return getActiveEpisodeStmt.get(borrowerAddress) !== undefined;
}

const insertEpisodeStmt = alertsDb.prepare(`
  INSERT INTO alert_episodes (
    borrower_address, started_at, started_block, min_health_factor, min_health_factor_block,
    last_seen_at, last_seen_block, last_health_factor, collateral_asset, debt_asset,
    severity, max_severity
  ) VALUES (
    @borrower_address, @now, @block, @hf, @block, @now, @block, @hf, @collateral_asset,
    @debt_asset, @severity, @severity
  )
`);

const updateEpisodeStmt = alertsDb.prepare(`
  UPDATE alert_episodes
  SET last_seen_at = @now, last_seen_block = @block, last_health_factor = @hf,
      min_health_factor = @min_health_factor, min_health_factor_block = @min_health_factor_block,
      severity = @severity, max_severity = @max_severity
  WHERE id = @id
`);

const upsertRiskProfileOnAlertStmt = alertsDb.prepare(`
  INSERT INTO borrower_risk_profiles (
    borrower_address, total_alert_episodes, lowest_health_factor, lowest_health_factor_block,
    first_alert_at, last_alert_at, updated_at
  ) VALUES (@borrower_address, 1, @hf, @block, @now, @now, @now)
  ON CONFLICT (borrower_address) DO UPDATE SET
    lowest_health_factor = CASE
      WHEN lowest_health_factor IS NULL OR CAST(@hf AS INTEGER) < CAST(lowest_health_factor AS INTEGER)
      THEN @hf ELSE lowest_health_factor END,
    lowest_health_factor_block = CASE
      WHEN lowest_health_factor IS NULL OR CAST(@hf AS INTEGER) < CAST(lowest_health_factor AS INTEGER)
      THEN @block ELSE lowest_health_factor_block END,
    last_alert_at = @now,
    updated_at = @now
`);

const incrementEpisodeCountStmt = alertsDb.prepare(
  `UPDATE borrower_risk_profiles SET total_alert_episodes = total_alert_episodes + 1, updated_at = ? WHERE borrower_address = ?`,
);

const incrementCriticalCountStmt = alertsDb.prepare(
  `UPDATE borrower_risk_profiles SET times_reached_critical = times_reached_critical + 1, updated_at = ? WHERE borrower_address = ?`,
);

/**
 * Records one poll tick's observation of a borrower at `severity`: starts a new episode if
 * they weren't already in one, or extends the existing one (updating the worst health factor
 * and severity seen) if they were. `assetPair` is only used when starting a new episode — pass
 * it as `null` for ticks on an already-open episode (check with `hasActiveAlertEpisode` first)
 * to avoid an unnecessary lookup. Also updates the borrower's risk profile rollup, including
 * `times_reached_critical`, incremented once per episode the first time it reaches 'critical'.
 */
export function recordAlertTick(
  borrowerAddress: string,
  blockNumber: number,
  healthFactor: bigint,
  severity: AlertSeverity,
  assetPair: AlertAssetPair | null,
): void {
  const now = new Date().toISOString();
  const hf = healthFactor.toString();
  const existing = getActiveEpisodeStmt.get(borrowerAddress) as AlertEpisodeRow | undefined;

  if (existing) {
    const isNewMin = healthFactor < BigInt(existing.min_health_factor);
    const wasCritical = existing.max_severity === "critical";
    const maxSeverity = isAtLeastAsSevere(severity, existing.max_severity) ? severity : existing.max_severity;

    updateEpisodeStmt.run({
      id: existing.id,
      now,
      block: blockNumber,
      hf,
      min_health_factor: isNewMin ? hf : existing.min_health_factor,
      min_health_factor_block: isNewMin ? blockNumber : existing.min_health_factor_block,
      severity,
      max_severity: maxSeverity,
    });

    if (!wasCritical && maxSeverity === "critical") {
      incrementCriticalCountStmt.run(now, borrowerAddress);
    }
  } else {
    insertEpisodeStmt.run({
      borrower_address: borrowerAddress,
      now,
      block: blockNumber,
      hf,
      collateral_asset: assetPair?.collateralAsset ?? null,
      debt_asset: assetPair?.debtAsset ?? null,
      severity,
    });
    incrementEpisodeCountStmt.run(now, borrowerAddress);

    if (severity === "critical") {
      incrementCriticalCountStmt.run(now, borrowerAddress);
    }
  }

  upsertRiskProfileOnAlertStmt.run({ borrower_address: borrowerAddress, hf, block: blockNumber, now });
}

const getAllActiveEpisodesStmt = alertsDb.prepare(`SELECT * FROM alert_episodes WHERE status = 'active'`);

const resolveEpisodeStmt = alertsDb.prepare(
  `UPDATE alert_episodes SET status = ?, resolved_at = ?, resolved_block = ? WHERE id = ?`,
);

/**
 * Closes out any active episode for an address that's no longer below the alert threshold as
 * of this tick — i.e. everyone with an active episode except those in `stillAtRiskAddresses`.
 * Called once per poll tick after all addresses have been checked.
 */
export function resolveRecoveredEpisodes(stillAtRiskAddresses: Set<string>, blockNumber: number): void {
  const now = new Date().toISOString();
  const activeEpisodes = getAllActiveEpisodesStmt.all() as AlertEpisodeRow[];
  for (const episode of activeEpisodes) {
    if (!stillAtRiskAddresses.has(episode.borrower_address)) {
      resolveEpisodeStmt.run("recovered", now, blockNumber, episode.id);
    }
  }
}

const incrementLiquidationCountStmt = alertsDb.prepare(
  `UPDATE borrower_risk_profiles SET total_liquidations = total_liquidations + 1, updated_at = ? WHERE borrower_address = ?`,
);

/**
 * Closes out an address's active episode (if any) as 'liquidated' rather than 'recovered', and
 * bumps their risk profile's liquidation count. Called by the outcome tracker once a logged
 * opportunity is confirmed as an actual on-chain liquidation.
 */
export function resolveAlertEpisodeAsLiquidated(borrowerAddress: string, blockNumber: number): void {
  const now = new Date().toISOString();
  const existing = getActiveEpisodeStmt.get(borrowerAddress) as AlertEpisodeRow | undefined;
  if (existing) {
    resolveEpisodeStmt.run("liquidated", now, blockNumber, existing.id);
  }
  incrementLiquidationCountStmt.run(now, borrowerAddress);
}

/** What alerts.db knew about a borrower at the moment they were liquidated. */
export interface LiquidationAlertHistory {
  episodeId: number;
  maxSeverity: AlertSeverity;
  startedBlock: number;
  /** Last health factor recorded for the episode — i.e. as of the last poll before liquidation. */
  lastHealthFactor: string;
}

const findEpisodeBeforeBlockStmt = alertsDb.prepare(`
  SELECT * FROM alert_episodes
  WHERE borrower_address = ? AND started_block <= ?
  ORDER BY started_block DESC LIMIT 1
`);

/**
 * Finds the most recent alert episode that had opened on or before `liquidationBlock` for
 * this borrower, i.e. the warning (if any) the watcher had already raised. Only episodes that
 * are still active or ended right at the liquidation count — an episode that recovered long
 * ago says nothing about this liquidation, so those are ignored (the caller passes how many
 * blocks of recovery-to-liquidation gap it will still accept).
 */
export function findAlertHistoryForLiquidation(
  borrowerAddress: string,
  liquidationBlock: number,
  maxGapBlocks: number,
): LiquidationAlertHistory | null {
  const episode = findEpisodeBeforeBlockStmt.get(borrowerAddress, liquidationBlock) as
    | AlertEpisodeRow
    | undefined;
  if (!episode) return null;

  const endedBlock = episode.status === "active" ? liquidationBlock : episode.resolved_block ?? episode.last_seen_block;
  if (liquidationBlock - endedBlock > maxGapBlocks) return null;

  return {
    episodeId: episode.id,
    maxSeverity: episode.max_severity,
    startedBlock: episode.started_block,
    lastHealthFactor: episode.last_health_factor,
  };
}
