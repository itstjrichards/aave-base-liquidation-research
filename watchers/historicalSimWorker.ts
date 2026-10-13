import { config } from "../config/config";
import {
  getNextPendingHistoricalSim,
  recordHistoricalSimFailure,
  recordHistoricalSimSuccess,
} from "../storage/db";
import { isPermanentHistoricalSimFailure, simulateHistoricalLiquidation } from "../simulation/historicalLiquidationSim";

// How often to check whether a simulation is due. Much shorter than the minimum gap between
// simulations so a newly observed liquidation doesn't wait a full gap just to get noticed.
const POLL_INTERVAL_MS = 15_000;

/**
 * Takes the oldest observed liquidation that hasn't been replayed yet and runs its historical
 * simulation, recording either the profit result or the failure. Returns true if it processed
 * one (so the caller can enforce the minimum gap before the next), false if nothing was pending.
 */
async function processNextPendingSimulation(): Promise<boolean> {
  const row = getNextPendingHistoricalSim();
  if (!row) return false;

  console.log(
    `[HIST-SIM] replaying liquidation #${row.id} (borrower=${row.borrower_address} block=${row.block_number}, ` +
      `attempt ${row.sim_attempts + 1}/${config.historicalSimMaxAttempts})...`,
  );

  try {
    const result = await simulateHistoricalLiquidation(row);
    recordHistoricalSimSuccess(
      row.id,
      result.forkBlock,
      result.profit,
      result.simulation.totalGasUsed,
      result.actualGasPriceWei,
      result.repricedAssetCount,
    );
    console.log(
      `[HIST-SIM] #${row.id}: grossProfit=$${result.profit.grossProfitUsd.toFixed(2)} ` +
        `netProfit=$${result.profit.netProfitUsd.toFixed(2)} (repaid $${result.profit.breakdown.debtRepaidUsd.toFixed(2)})`,
    );
  } catch (err) {
    const permanent = isPermanentHistoricalSimFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    recordHistoricalSimFailure(row, message, permanent);
    console.warn(
      `[HIST-SIM] #${row.id} failed${permanent ? " (permanent)" : ""}: ${message.slice(0, 200)}`,
    );
  }
  return true;
}

/**
 * Starts the background worker that replays observed liquidations one at a time, at least
 * config.historicalSimMinIntervalMs apart (each replay spins up an Anvil fork, which spends RPC
 * compute units). Does nothing if HISTORICAL_SIM_ENABLED is false. Returns a function that
 * stops it; a replay already in progress is left to finish on its own.
 */
export function startHistoricalSimWorker(): () => void {
  if (!config.historicalSimEnabled) {
    console.log("Historical liquidation simulation disabled (HISTORICAL_SIM_ENABLED=false).");
    return () => {};
  }

  let inFlight = false;
  let nextAllowedAt = 0;

  const interval = setInterval(() => {
    if (inFlight || Date.now() < nextAllowedAt) return;
    inFlight = true;
    processNextPendingSimulation()
      .then((processed) => {
        if (processed) nextAllowedAt = Date.now() + config.historicalSimMinIntervalMs;
      })
      .catch((err) => console.error("Historical simulation worker failed:", err))
      .finally(() => {
        inFlight = false;
      });
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
