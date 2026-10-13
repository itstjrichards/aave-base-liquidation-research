import Database from "better-sqlite3";
import { config } from "../config/config";
import type { ProfitResult } from "../pricing/profitCalculator";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    borrower_address TEXT NOT NULL,
    collateral_asset TEXT NOT NULL,
    debt_asset TEXT NOT NULL,
    health_factor TEXT NOT NULL,
    gross_profit_usd REAL NOT NULL,
    net_profit_usd REAL NOT NULL,
    collateral_received_usd REAL NOT NULL,
    debt_repaid_usd REAL NOT NULL,
    swap_proceeds_usd REAL NOT NULL,
    flash_loan_fee_usd REAL NOT NULL,
    gas_cost_usd REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    liquidated_block_number INTEGER,
    outcome_checked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status);
  CREATE INDEX IF NOT EXISTS idx_opportunities_borrower ON opportunities (borrower_address);
`);

/** A row exactly as stored — snake_case to match the SQL schema directly, no mapping layer. */
export interface OpportunityRow {
  id: number;
  detected_at: string;
  block_number: number;
  borrower_address: string;
  collateral_asset: string;
  debt_asset: string;
  /** Stored as text (the raw 18-decimal integer, as a string) to avoid float precision loss. */
  health_factor: string;
  gross_profit_usd: number;
  net_profit_usd: number;
  collateral_received_usd: number;
  debt_repaid_usd: number;
  swap_proceeds_usd: number;
  flash_loan_fee_usd: number;
  gas_cost_usd: number;
  status: "pending" | "liquidated" | "expired";
  liquidated_block_number: number | null;
  outcome_checked_at: string | null;
}

/** Everything needed to log a newly-detected opportunity, before its outcome is known. */
export interface NewOpportunity {
  blockNumber: number;
  borrowerAddress: string;
  collateralAsset: string;
  debtAsset: string;
  /** Raw 18-decimal health factor (e.g. from getUserAccountData), not a human-readable float. */
  healthFactor: bigint;
  profit: ProfitResult;
}

const insertOpportunityStmt = db.prepare(`
  INSERT INTO opportunities (
    detected_at, block_number, borrower_address, collateral_asset, debt_asset, health_factor,
    gross_profit_usd, net_profit_usd, collateral_received_usd, debt_repaid_usd,
    swap_proceeds_usd, flash_loan_fee_usd, gas_cost_usd
  ) VALUES (
    @detected_at, @block_number, @borrower_address, @collateral_asset, @debt_asset, @health_factor,
    @gross_profit_usd, @net_profit_usd, @collateral_received_usd, @debt_repaid_usd,
    @swap_proceeds_usd, @flash_loan_fee_usd, @gas_cost_usd
  )
`);

/** Logs a newly-detected liquidation opportunity. Returns its row id. */
export function insertOpportunity(opportunity: NewOpportunity): number {
  const result = insertOpportunityStmt.run({
    detected_at: new Date().toISOString(),
    block_number: opportunity.blockNumber,
    borrower_address: opportunity.borrowerAddress,
    collateral_asset: opportunity.collateralAsset,
    debt_asset: opportunity.debtAsset,
    health_factor: opportunity.healthFactor.toString(),
    gross_profit_usd: opportunity.profit.grossProfitUsd,
    net_profit_usd: opportunity.profit.netProfitUsd,
    collateral_received_usd: opportunity.profit.breakdown.collateralReceivedUsd,
    debt_repaid_usd: opportunity.profit.breakdown.debtRepaidUsd,
    swap_proceeds_usd: opportunity.profit.breakdown.swapProceedsUsd,
    flash_loan_fee_usd: opportunity.profit.breakdown.flashLoanFeeUsd,
    gas_cost_usd: opportunity.profit.breakdown.gasCostUsd,
  });
  return Number(result.lastInsertRowid);
}

const hasPendingStmt = db.prepare(
  `SELECT 1 FROM opportunities WHERE borrower_address = ? AND status = 'pending' LIMIT 1`,
);

/** True if `borrowerAddress` already has an unresolved opportunity logged. */
export function hasPendingOpportunity(borrowerAddress: string): boolean {
  return hasPendingStmt.get(borrowerAddress) !== undefined;
}

const getPendingStmt = db.prepare(`SELECT * FROM opportunities WHERE status = 'pending'`);

/** All opportunities still awaiting an outcome check. */
export function getPendingOpportunities(): OpportunityRow[] {
  return getPendingStmt.all() as OpportunityRow[];
}

const markLiquidatedStmt = db.prepare(
  `UPDATE opportunities SET status = 'liquidated', liquidated_block_number = ?, outcome_checked_at = ? WHERE id = ?`,
);

/** Records that `id`'s position was actually liquidated on-chain at `liquidatedBlockNumber`. */
export function markOpportunityLiquidated(id: number, liquidatedBlockNumber: number): void {
  markLiquidatedStmt.run(liquidatedBlockNumber, new Date().toISOString(), id);
}

const markExpiredStmt = db.prepare(`UPDATE opportunities SET status = 'expired', outcome_checked_at = ? WHERE id = ?`);

/** Gives up on `id`: no LiquidationCall was seen within the configured follow-up window. */
export function markOpportunityExpired(id: number): void {
  markExpiredStmt.run(new Date().toISOString(), id);
}

// observed_liquidations: every real on-chain LiquidationCall on the pool, whether or not the
// watcher saw the position go below 1.0 first. Positions are usually liquidated by bots within
// a block or two of becoming eligible — faster than the 30s health factor poll — so these are
// the opportunities the live path can't catch. Each row is later replayed on an Anvil fork one
// block before the real liquidation (the sim_* columns) to measure what it would have paid us.
//
// (tx_hash, log_index) is unique so that rescanning a block range — the startup backfill window
// is re-read on every restart — never double-counts the same liquidation.
db.exec(`
  CREATE TABLE IF NOT EXISTS observed_liquidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    -- 1 if found while backfilling history at startup rather than live. The watcher was not
    -- running for those, so "was there a prior warning" is meaningless for them — filter these
    -- out when measuring warning lead time.
    during_backfill INTEGER NOT NULL DEFAULT 0,
    borrower_address TEXT NOT NULL,
    liquidator_address TEXT NOT NULL,
    collateral_asset TEXT NOT NULL,
    debt_asset TEXT NOT NULL,
    -- The ACTUAL amounts from the event, as raw integer strings (see the ABI comment: the
    -- event's debtToCover field is the amount really repaid, not the caller's input).
    debt_to_cover_raw TEXT NOT NULL,
    collateral_seized_raw TEXT NOT NULL,
    receive_a_token INTEGER NOT NULL,

    -- Cross-reference against alerts.db, filled in when the liquidation is recorded.
    prior_episode_id INTEGER,
    prior_max_severity TEXT,
    prior_started_block INTEGER,
    -- Blocks between the borrower's alert episode opening and the liquidation: how much
    -- warning the watcher actually had. NULL if the borrower was never in an alert episode.
    warning_lead_blocks INTEGER,
    -- Last health factor the watcher saw for them before liquidation (raw 18-decimal string).
    last_health_factor_before TEXT,
    matched_opportunity_id INTEGER,

    -- Historical simulation: pending -> done | failed.
    sim_status TEXT NOT NULL DEFAULT 'pending',
    sim_attempts INTEGER NOT NULL DEFAULT 0,
    sim_error TEXT,
    sim_at TEXT,
    sim_fork_block INTEGER,
    sim_gross_profit_usd REAL,
    sim_net_profit_usd REAL,
    sim_collateral_received_usd REAL,
    sim_debt_repaid_usd REAL,
    sim_swap_proceeds_usd REAL,
    sim_flash_loan_fee_usd REAL,
    sim_gas_cost_usd REAL,
    sim_total_gas_used INTEGER,
    -- How many reserves' oracle prices were moved to end-of-block values before replaying.
    sim_repriced_assets INTEGER,
    -- Gas price the real liquidation tx paid (wei), used to price the simulation's gas.
    actual_gas_price_wei TEXT,

    UNIQUE (tx_hash, log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_observed_liq_borrower ON observed_liquidations (borrower_address);
  CREATE INDEX IF NOT EXISTS idx_observed_liq_sim_status ON observed_liquidations (sim_status);
  CREATE INDEX IF NOT EXISTS idx_observed_liq_block ON observed_liquidations (block_number);
`);

// Migrate an observed_liquidations table created before sim_repriced_assets existed.
const observedColumns = db.prepare("PRAGMA table_info(observed_liquidations)").all() as { name: string }[];
if (!observedColumns.some((c) => c.name === "sim_repriced_assets")) {
  db.exec("ALTER TABLE observed_liquidations ADD COLUMN sim_repriced_assets INTEGER");
}

/** A row exactly as stored — snake_case to match the SQL schema directly. */
export interface ObservedLiquidationRow {
  id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  observed_at: string;
  during_backfill: number;
  borrower_address: string;
  liquidator_address: string;
  collateral_asset: string;
  debt_asset: string;
  debt_to_cover_raw: string;
  collateral_seized_raw: string;
  receive_a_token: number;
  prior_episode_id: number | null;
  prior_max_severity: string | null;
  prior_started_block: number | null;
  warning_lead_blocks: number | null;
  last_health_factor_before: string | null;
  matched_opportunity_id: number | null;
  sim_status: "pending" | "done" | "failed";
  sim_attempts: number;
  sim_error: string | null;
  sim_at: string | null;
  sim_fork_block: number | null;
  sim_gross_profit_usd: number | null;
  sim_net_profit_usd: number | null;
  sim_collateral_received_usd: number | null;
  sim_debt_repaid_usd: number | null;
  sim_swap_proceeds_usd: number | null;
  sim_flash_loan_fee_usd: number | null;
  sim_gas_cost_usd: number | null;
  sim_total_gas_used: number | null;
  sim_repriced_assets: number | null;
  actual_gas_price_wei: string | null;
}

/** What's read straight off a LiquidationCall log, before any cross-referencing. */
export interface NewObservedLiquidation {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  duringBackfill: boolean;
  borrowerAddress: string;
  liquidatorAddress: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: bigint;
  collateralSeized: bigint;
  receiveAToken: boolean;
}

/** The alerts.db cross-reference computed for a newly observed liquidation. */
export interface LiquidationAlertContext {
  priorEpisodeId: number | null;
  priorMaxSeverity: string | null;
  priorStartedBlock: number | null;
  warningLeadBlocks: number | null;
  lastHealthFactorBefore: string | null;
  matchedOpportunityId: number | null;
}

// INSERT OR IGNORE against the UNIQUE (tx_hash, log_index) constraint: a duplicate silently
// inserts nothing, which insertObservedLiquidation reports by returning null.
const insertObservedLiquidationStmt = db.prepare(`
  INSERT OR IGNORE INTO observed_liquidations (
    tx_hash, log_index, block_number, observed_at, during_backfill, borrower_address,
    liquidator_address, collateral_asset, debt_asset, debt_to_cover_raw, collateral_seized_raw,
    receive_a_token
  ) VALUES (
    @tx_hash, @log_index, @block_number, @observed_at, @during_backfill, @borrower_address,
    @liquidator_address, @collateral_asset, @debt_asset, @debt_to_cover_raw,
    @collateral_seized_raw, @receive_a_token
  )
`);

/**
 * Logs an observed on-chain liquidation. Returns the new row's id, or null if this exact
 * liquidation (same tx + log index) was already recorded — callers use that to make sure
 * follow-up work (alert-episode updates, risk-profile counts) happens exactly once per event.
 */
export function insertObservedLiquidation(liquidation: NewObservedLiquidation): number | null {
  const result = insertObservedLiquidationStmt.run({
    tx_hash: liquidation.txHash,
    log_index: liquidation.logIndex,
    block_number: liquidation.blockNumber,
    observed_at: new Date().toISOString(),
    during_backfill: liquidation.duringBackfill ? 1 : 0,
    borrower_address: liquidation.borrowerAddress,
    liquidator_address: liquidation.liquidatorAddress,
    collateral_asset: liquidation.collateralAsset,
    debt_asset: liquidation.debtAsset,
    debt_to_cover_raw: liquidation.debtToCover.toString(),
    collateral_seized_raw: liquidation.collateralSeized.toString(),
    receive_a_token: liquidation.receiveAToken ? 1 : 0,
  });
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

const setAlertContextStmt = db.prepare(`
  UPDATE observed_liquidations
  SET prior_episode_id = @prior_episode_id, prior_max_severity = @prior_max_severity,
      prior_started_block = @prior_started_block, warning_lead_blocks = @warning_lead_blocks,
      last_health_factor_before = @last_health_factor_before,
      matched_opportunity_id = @matched_opportunity_id
  WHERE id = @id
`);

/** Stores the alerts.db cross-reference on an observed liquidation's row. */
export function setObservedLiquidationAlertContext(id: number, context: LiquidationAlertContext): void {
  setAlertContextStmt.run({
    id,
    prior_episode_id: context.priorEpisodeId,
    prior_max_severity: context.priorMaxSeverity,
    prior_started_block: context.priorStartedBlock,
    warning_lead_blocks: context.warningLeadBlocks,
    last_health_factor_before: context.lastHealthFactorBefore,
    matched_opportunity_id: context.matchedOpportunityId,
  });
}

// A live opportunity "matches" a real liquidation if it's for the same borrower and was
// detected shortly before (or at) the liquidation block. The window mirrors the outcome
// tracker's follow-up window (liquidationCheckMaxBlocks) since that's how long it waits for one.
const findOpportunityForLiquidationStmt = db.prepare(`
  SELECT id FROM opportunities
  WHERE borrower_address = @borrower
    AND block_number <= @block
    AND block_number >= @block - @window
  ORDER BY block_number DESC LIMIT 1
`);

/** Finds the live-detected opportunity (if any) that this on-chain liquidation resolved. */
export function findOpportunityForLiquidation(borrowerAddress: string, liquidationBlock: number): number | null {
  const row = findOpportunityForLiquidationStmt.get({
    borrower: borrowerAddress,
    block: liquidationBlock,
    window: config.liquidationCheckMaxBlocks,
  }) as { id: number } | undefined;
  return row?.id ?? null;
}

const nextPendingSimStmt = db.prepare(
  `SELECT * FROM observed_liquidations WHERE sim_status = 'pending' ORDER BY block_number ASC LIMIT 1`,
);

/** The oldest observed liquidation still waiting for its historical simulation, if any. */
export function getNextPendingHistoricalSim(): ObservedLiquidationRow | null {
  return (nextPendingSimStmt.get() as ObservedLiquidationRow | undefined) ?? null;
}

const recordSimSuccessStmt = db.prepare(`
  UPDATE observed_liquidations
  SET sim_status = 'done', sim_attempts = sim_attempts + 1, sim_error = NULL, sim_at = @sim_at,
      sim_fork_block = @sim_fork_block, sim_gross_profit_usd = @gross, sim_net_profit_usd = @net,
      sim_collateral_received_usd = @collateral_received, sim_debt_repaid_usd = @debt_repaid,
      sim_swap_proceeds_usd = @swap_proceeds, sim_flash_loan_fee_usd = @flash_fee,
      sim_gas_cost_usd = @gas_cost, sim_total_gas_used = @gas_used,
      sim_repriced_assets = @repriced, actual_gas_price_wei = @gas_price
  WHERE id = @id
`);

/** Stores a successful historical simulation's profit result on its observed-liquidation row. */
export function recordHistoricalSimSuccess(
  id: number,
  forkBlock: number,
  profit: ProfitResult,
  totalGasUsed: bigint,
  actualGasPriceWei: bigint,
  repricedAssetCount: number,
): void {
  recordSimSuccessStmt.run({
    id,
    sim_at: new Date().toISOString(),
    sim_fork_block: forkBlock,
    gross: profit.grossProfitUsd,
    net: profit.netProfitUsd,
    collateral_received: profit.breakdown.collateralReceivedUsd,
    debt_repaid: profit.breakdown.debtRepaidUsd,
    swap_proceeds: profit.breakdown.swapProceedsUsd,
    flash_fee: profit.breakdown.flashLoanFeeUsd,
    gas_cost: profit.breakdown.gasCostUsd,
    gas_used: Number(totalGasUsed),
    repriced: repricedAssetCount,
    gas_price: actualGasPriceWei.toString(),
  });
}

const recordSimFailureStmt = db.prepare(`
  UPDATE observed_liquidations
  SET sim_status = @status, sim_attempts = sim_attempts + 1, sim_error = @error, sim_at = @sim_at
  WHERE id = @id
`);

/**
 * Records a failed simulation attempt. `permanent` failures (a deterministic reason the replay
 * can never work, e.g. the position wasn't yet liquidatable one block earlier) are final;
 * otherwise the row goes back to 'pending' for another try, until historicalSimMaxAttempts.
 */
export function recordHistoricalSimFailure(row: ObservedLiquidationRow, error: string, permanent: boolean): void {
  const outOfAttempts = row.sim_attempts + 1 >= config.historicalSimMaxAttempts;
  recordSimFailureStmt.run({
    id: row.id,
    status: permanent || outOfAttempts ? "failed" : "pending",
    error: error.slice(0, 500),
    sim_at: new Date().toISOString(),
  });
}
