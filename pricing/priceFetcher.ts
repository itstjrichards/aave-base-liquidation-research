import { Contract, type Provider } from "ethers";
import { AAVE_ORACLE_ABI, AAVE_ORACLE_ADDRESS } from "../config/aaveOracleAbi";
import { ERC20_ABI, WETH_ADDRESS } from "../config/uniswapAbi";
import type { ProfitCalculatorPrices } from "./profitCalculator";

/**
 * Fetches everything calculateLiquidationProfit needs to value a simulation result in USD:
 * both assets' decimals and Aave-oracle USD prices, plus WETH's price to convert the
 * simulation's gas price (paid in ETH) into USD.
 *
 * `blockTag` reads the oracle as of a specific historical block (needs an archive-capable RPC
 * for old blocks) — used when re-valuing a liquidation that already happened, so it's priced
 * with the prices the liquidator actually saw rather than today's. Omit it for the latest block.
 */
export async function fetchProfitPrices(
  provider: Provider,
  collateralAsset: string,
  debtAsset: string,
  gasPriceWei: bigint,
  blockTag?: number,
): Promise<ProfitCalculatorPrices> {
  const oracle = new Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);
  const collateralToken = new Contract(collateralAsset, ERC20_ABI, provider);
  const debtToken = new Contract(debtAsset, ERC20_ABI, provider);
  const overrides = blockTag === undefined ? {} : { blockTag };

  const [collateralDecimals, debtDecimals, collateralPriceRaw, debtPriceRaw, ethPriceRaw] = await Promise.all([
    collateralToken.decimals(overrides),
    debtToken.decimals(overrides),
    oracle.getAssetPrice(collateralAsset, overrides),
    oracle.getAssetPrice(debtAsset, overrides),
    oracle.getAssetPrice(WETH_ADDRESS, overrides),
  ]);

  // Aave/Chainlink prices on Base are 8-decimal USD (see aaveOracleAbi.ts).
  return {
    collateralAssetDecimals: Number(collateralDecimals),
    collateralAssetPriceUsd: Number(collateralPriceRaw) / 1e8,
    debtAssetDecimals: Number(debtDecimals),
    debtAssetPriceUsd: Number(debtPriceRaw) / 1e8,
    gasPriceWei,
    ethPriceUsd: Number(ethPriceRaw) / 1e8,
  };
}
