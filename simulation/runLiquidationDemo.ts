import { Contract, formatUnits } from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import { startAnvilFork } from "./forkManager";
import { findLiquidatableAssetPair, simulateLiquidationOnFork } from "./liquidationSim";
import { setMockAssetPrice } from "./priceManipulation";

/**
 * Demonstrates the liquidation simulator's full success path on demand. Real liquidatable
 * (health factor < 1) positions on a live, competitive chain like Base typically get sniped
 * by other bots within seconds, so one usually isn't sitting there to test against. This picks
 * a real borrower with an active position, crashes their collateral's price on a throwaway
 * fork until they're genuinely eligible, then runs the exact same `simulateLiquidationOnFork`
 * used in production against them — never touching a live network or real funds.
 *
 * Usage: npx tsx simulation/runLiquidationDemo.ts <borrowerAddress> [crashPriceRaw8Decimals]
 *
 * crashPriceRaw8Decimals is the forced price in Aave's own 8-decimal USD units (100000000 = $1),
 * not dollars — a fixed dollar amount like "$1" would do nothing to a stablecoin collateral
 * asset that's already worth about $1. The default (1, i.e. $0.00000001) works regardless of
 * what the collateral asset is.
 */
async function main(): Promise<void> {
  const user = process.argv[2];
  if (!user) {
    console.error("Usage: npx tsx simulation/runLiquidationDemo.ts <borrowerAddress> [crashPriceRaw8Decimals]");
    process.exit(1);
  }
  const crashPrice8Decimals = process.argv[3] ? BigInt(process.argv[3]) : 1n;

  const fork = await startAnvilFork();
  try {
    const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, fork.provider);

    const pair = await findLiquidatableAssetPair(user, fork.provider);
    if (!pair) {
      throw new Error(`${user} has no reserve with both seizable collateral and outstanding debt`);
    }
    console.log(`Collateral asset: ${pair.collateralAsset}`);
    console.log(`Debt asset:       ${pair.debtAsset}`);

    const before = await pool.getUserAccountData(user);
    console.log(`\nHealth factor before price crash: ${formatUnits(before.healthFactor, 18)}`);

    console.log(`Crashing collateral price to ${formatUnits(crashPrice8Decimals, 8)} USD on the fork...`);
    await setMockAssetPrice(fork.provider, pair.collateralAsset, crashPrice8Decimals);

    const after = await pool.getUserAccountData(user);
    console.log(`Health factor after price crash:  ${formatUnits(after.healthFactor, 18)}`);
    if (after.healthFactor >= 10n ** 18n) {
      throw new Error("Price crash wasn't enough to push the health factor below 1 — try a lower crashPriceUsd");
    }

    console.log("\nRunning liquidation simulation against the now-eligible position...");
    const result = await simulateLiquidationOnFork(fork, {
      user,
      collateralAsset: pair.collateralAsset,
      debtAsset: pair.debtAsset,
    });

    console.log("\n=== SIMULATION RESULT ===");
    console.log("Fork block:                 ", result.forkBlockNumber);
    console.log("Liquidation gas used:       ", result.liquidationGasUsed.toString());
    console.log("Acquisition swap gas used:  ", result.acquisitionSwapGasUsed.toString());
    console.log("Disposal swap gas used:     ", result.disposalSwapGasUsed.toString());
    console.log("Total gas used:             ", result.totalGasUsed.toString());
    console.log("Actual debt repaid:         ", result.actualDebtRepaid.toString());
    console.log("Actual collateral seized:   ", result.actualCollateralSeized.toString());
    console.log("Debt asset from disposal:   ", result.debtAssetReceivedFromDisposal.toString());
    console.log("Disposal swap fee tier:     ", result.disposalSwapFeeTier);
  } finally {
    await fork.stop();
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
