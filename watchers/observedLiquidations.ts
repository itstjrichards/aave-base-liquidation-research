import { formatUnits, type EventLog } from "ethers";
import {
  findOpportunityForLiquidation,
  insertObservedLiquidation,
  setObservedLiquidationAlertContext,
} from "../storage/db";
import { findAlertHistoryForLiquidation, resolveAlertEpisodeAsLiquidated } from "../storage/alertsDb";

// An episode that ended (recovered) this many blocks or fewer before the liquidation still
// counts as the warning for it: the watcher polls every ~15 blocks, so a borrower can be
// flagged, drop under 1.0, and be liquidated all between two polls, and the episode would be
// closed as "recovered" by the next tick only because the liquidation restored their health.
const MAX_EPISODE_TO_LIQUIDATION_GAP_BLOCKS = 30;

/**
 * Records one on-chain LiquidationCall event: logs it to observed_liquidations, cross-references
 * alerts.db (was this borrower already flagged, how long ago, how bad), links any live
 * opportunity we'd detected for it, closes their alert episode as 'liquidated', and bumps their
 * risk profile's liquidation count. Safe to call repeatedly for the same event — a duplicate
 * (e.g. the startup backfill window being re-read after a restart) is ignored, so the
 * follow-up updates happen exactly once per real liquidation.
 */
export function recordObservedLiquidation(log: EventLog, duringBackfill: boolean): void {
  const borrower = log.args.user as string;

  const id = insertObservedLiquidation({
    txHash: log.transactionHash,
    logIndex: log.index,
    blockNumber: log.blockNumber,
    duringBackfill,
    borrowerAddress: borrower,
    liquidatorAddress: log.args.liquidator as string,
    collateralAsset: log.args.collateralAsset as string,
    debtAsset: log.args.debtAsset as string,
    debtToCover: log.args.debtToCover as bigint,
    collateralSeized: log.args.liquidatedCollateralAmount as bigint,
    receiveAToken: log.args.receiveAToken as boolean,
  });
  if (id === null) return; // Already recorded.

  const history = findAlertHistoryForLiquidation(borrower, log.blockNumber, MAX_EPISODE_TO_LIQUIDATION_GAP_BLOCKS);
  const matchedOpportunityId = findOpportunityForLiquidation(borrower, log.blockNumber);

  setObservedLiquidationAlertContext(id, {
    priorEpisodeId: history?.episodeId ?? null,
    priorMaxSeverity: history?.maxSeverity ?? null,
    priorStartedBlock: history?.startedBlock ?? null,
    warningLeadBlocks: history ? log.blockNumber - history.startedBlock : null,
    lastHealthFactorBefore: history?.lastHealthFactor ?? null,
    matchedOpportunityId,
  });

  // Skipped for backfilled events: those happened before this watcher was running, so any
  // alerts.db state for the borrower predates them and counting a liquidation against it would
  // misstate their history.
  if (!duringBackfill) {
    resolveAlertEpisodeAsLiquidated(borrower, log.blockNumber);
  }

  const warning = history
    ? `warned=${history.maxSeverity} lead=${log.blockNumber - history.startedBlock}blocks ` +
      `lastHF=${formatUnits(history.lastHealthFactor, 18)}`
    : duringBackfill
      ? "warned=unknown(backfill)"
      : "warned=no";
  console.warn(
    `[LIQUIDATION${duringBackfill ? ":BACKFILL" : ""}] borrower=${borrower} block=${log.blockNumber} ` +
      `tx=${log.transactionHash} ${warning}${matchedOpportunityId ? ` opportunity=#${matchedOpportunityId}` : ""}`,
  );
}
