import { Contract, JsonRpcProvider } from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import { AAVE_ORACLE_ABI, AAVE_ORACLE_ADDRESS } from "../config/aaveOracleAbi";
import { setMockAssetPrice } from "./priceManipulation";
import { startAnvilFork } from "./forkManager";
import { simulateLiquidationOnFork, type LiquidationSimulationResult } from "./liquidationSim";
import { calculateLiquidationProfit, type ProfitResult } from "../pricing/profitCalculator";
import { fetchProfitPrices } from "../pricing/priceFetcher";
import type { ObservedLiquidationRow } from "../storage/db";

/** Outcome of replaying one real, already-mined liquidation on a fork. */
export interface HistoricalSimulationResult {
  /** Block the fork was pinned at: one before the real liquidation. */
  forkBlock: number;
  simulation: LiquidationSimulationResult;
  profit: ProfitResult;
  /** Gas price the real liquidation transaction paid, used to price the simulation's gas. */
  actualGasPriceWei: bigint;
  /** How many reserves' oracle prices had to be moved to their end-of-block values on the fork. */
  repricedAssetCount: number;
}

/** Substrings that mean the replay can never succeed, so retrying it is pointless. */
const PERMANENT_FAILURE_MARKERS = [
  // HealthFactorNotBelowThreshold: the position still isn't liquidatable even after moving
  // prices to their end-of-block values, so something other than a price change enabled it.
  "0x930bb771",
  "HealthFactorNotBelowThreshold",
  // The borrower's debt in this asset was already fully repaid by the fork block.
  "nothing to liquidate",
];

/**
 * True if `err` is a deterministic reason a historical replay can't work (as opposed to a
 * transient failure like an RPC rate limit or timeout, which is worth retrying).
 */
export function isPermanentHistoricalSimFailure(err: unknown): boolean {
  const text = String(err);
  return PERMANENT_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Moves the fork's oracle prices to what they were at the END of the liquidation's block, for
 * every reserve whose price changed during that block. Why this is needed: a liquidation is
 * very often only possible because of a price update in its own block — with Chainlink SVR
 * feeds, the liquidator even bundles the price update into the liquidation transaction itself —
 * so the state at the end of the previous block isn't liquidatable yet, and replaying earlier
 * transactions in the block can't recover an update that happens inside the liquidation. Reads
 * each reserve's price at both blocks from the live chain and only overrides the ones that
 * differ (fork-only, via the same mock feed the price-manipulation demo uses). Returns how many
 * were overridden.
 */
async function repriceToEndOfBlock(
  liveProvider: JsonRpcProvider,
  forkProvider: JsonRpcProvider,
  liquidationBlock: number,
): Promise<number> {
  const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, liveProvider);
  const oracle = new Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, liveProvider);
  const reserves: string[] = await pool.getReservesList();

  let repriced = 0;
  for (const asset of reserves) {
    const [before, after] = await Promise.all([
      oracle.getAssetPrice(asset, { blockTag: liquidationBlock - 1 }) as Promise<bigint>,
      oracle.getAssetPrice(asset, { blockTag: liquidationBlock }) as Promise<bigint>,
    ]);
    if (before !== after) {
      await setMockAssetPrice(forkProvider, asset, after);
      repriced++;
    }
  }
  return repriced;
}

/**
 * Replays a real liquidation that has already happened, to measure what it would have paid a
 * liquidator running our flow: forks Anvil at the block BEFORE the liquidation, moves any oracle
 * prices that changed during the liquidation's own block to their end-of-block values (see
 * repriceToEndOfBlock — this is what makes the position liquidatable, as it was for the real
 * liquidator), repays exactly the debt amount the real event repaid, swaps the seized collateral
 * back to the debt asset on Uniswap V3, and prices the result with those same end-of-block
 * oracle prices and the gas price the real transaction paid. Uses the same simulation and profit math as the live path, so historical
 * and live numbers are directly comparable.
 *
 * Caveats worth knowing when reading the results: end-of-block prices approximate the price at
 * the exact moment of the liquidation (they match when the update is the block's last change to
 * that feed); a liquidation that still isn't possible after repricing fails permanently (see
 * PERMANENT_FAILURE_MARKERS); and the replay always takes the underlying collateral rather than
 * aTokens, even if the real liquidator chose receiveAToken.
 */
export async function simulateHistoricalLiquidation(row: ObservedLiquidationRow): Promise<HistoricalSimulationResult> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  try {
    const forkBlock = row.block_number - 1;

    const realReceipt = await provider.getTransactionReceipt(row.tx_hash);
    if (!realReceipt) {
      throw new Error(`Could not fetch the real liquidation transaction ${row.tx_hash}`);
    }
    const actualGasPriceWei = realReceipt.gasPrice;

    const fork = await startAnvilFork(forkBlock);
    let simulation: LiquidationSimulationResult;
    let repricedAssetCount: number;
    try {
      repricedAssetCount = await repriceToEndOfBlock(provider, fork.provider, row.block_number);
      simulation = await simulateLiquidationOnFork(fork, {
        user: row.borrower_address,
        collateralAsset: row.collateral_asset,
        debtAsset: row.debt_asset,
        debtToCover: BigInt(row.debt_to_cover_raw),
      });
    } finally {
      await fork.stop();
    }

    const prices = await fetchProfitPrices(
      provider,
      row.collateral_asset,
      row.debt_asset,
      actualGasPriceWei,
      row.block_number,
    );
    const profit = calculateLiquidationProfit(simulation, prices);

    return { forkBlock, simulation, profit, actualGasPriceWei, repricedAssetCount };
  } finally {
    provider.destroy();
  }
}
