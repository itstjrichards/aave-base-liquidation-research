// Aave's flash loan premium has changed over time and across markets (it launched at 0.09%,
// the value most people still quote, but governance has since lowered it on many markets —
// Base's Pool.FLASHLOAN_PREMIUM_TOTAL() currently reports 5 bps (0.05%), not 9). Kept as an
// overridable default rather than a silent assumption, since it directly affects net profit.
export const DEFAULT_FLASH_LOAN_PREMIUM_BPS = 9;

/** The four measured outputs of a liquidation simulation that profit depends on. */
export interface SimulatedLiquidationOutput {
  /** Amount of collateral seized, in the collateral asset's smallest unit. Informational here —
   *  its realized USD value is already captured by `debtAssetReceivedFromDisposal` below. */
  actualCollateralSeized: bigint;
  /** Amount of debt repaid (and so flash-loaned), in the debt asset's smallest unit. */
  actualDebtRepaid: bigint;
  /** Total gas used across the liquidation and both swaps. */
  totalGasUsed: bigint;
  /** Amount of debt asset recovered by swapping the seized collateral. */
  debtAssetReceivedFromDisposal: bigint;
}

/** Market data needed to convert the raw simulation output into USD. */
export interface ProfitCalculatorPrices {
  /** Decimals of the debt asset (e.g. 6 for USDC, 18 for DAI/WETH). */
  debtAssetDecimals: number;
  /** USD price of one whole unit of the debt asset (e.g. ~1.00 for USDC). */
  debtAssetPriceUsd: number;
  /** Decimals of the collateral asset, for the informational breakdown line. */
  collateralAssetDecimals: number;
  /** USD price of one whole unit of the collateral asset. */
  collateralAssetPriceUsd: number;
  /** Effective gas price actually paid, in wei (e.g. from the simulation's tx receipts). */
  gasPriceWei: bigint;
  /** USD price of one ETH, to convert the gas cost (paid in ETH) into USD. */
  ethPriceUsd: number;
  /** Flash loan premium in basis points. Defaults to `DEFAULT_FLASH_LOAN_PREMIUM_BPS`. */
  flashLoanPremiumBps?: number;
}

/** USD value of every cost/revenue component that feeds into gross and net profit. */
export interface ProfitBreakdown {
  /** USD value of the collateral seized (informational; not itself part of the profit formula). */
  collateralReceivedUsd: number;
  /** USD value of the debt repaid — the amount flash-loaned and later owed back. */
  debtRepaidUsd: number;
  /** USD value recovered by swapping the seized collateral back into the debt asset. */
  swapProceedsUsd: number;
  /** USD cost of the flash loan premium, charged on the amount borrowed (debtRepaidUsd). */
  flashLoanFeeUsd: number;
  /** USD cost of gas used, converted from wei via the supplied ETH/USD price. */
  gasCostUsd: number;
}

export interface ProfitResult {
  /** Swap proceeds minus debt repaid — profit before flash loan fee and gas. */
  grossProfitUsd: number;
  /** Gross profit minus the flash loan fee and gas cost — the bottom line. */
  netProfitUsd: number;
  breakdown: ProfitBreakdown;
}

/** Converts a raw token amount (smallest unit) to a human-readable whole-token float. */
function toHumanAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Computes the USD profit of a simulated liquidation, given the simulation's measured output
 * and the market prices needed to value it. Pure arithmetic — no network calls — so callers
 * are responsible for supplying current prices/decimals (e.g. from Aave's oracle) themselves.
 *
 * Gross profit is what swapping the seized collateral recovers, minus the debt that was repaid
 * (and so must be flash-loaned). Net profit additionally subtracts the flash loan's premium and
 * the USD cost of gas — the two costs a real liquidation bot pays that a bare simulation result
 * doesn't already reflect.
 */
export function calculateLiquidationProfit(
  simulation: SimulatedLiquidationOutput,
  prices: ProfitCalculatorPrices,
): ProfitResult {
  const {
    debtAssetDecimals,
    debtAssetPriceUsd,
    collateralAssetDecimals,
    collateralAssetPriceUsd,
    gasPriceWei,
    ethPriceUsd,
    flashLoanPremiumBps = DEFAULT_FLASH_LOAN_PREMIUM_BPS,
  } = prices;

  const collateralReceivedUsd =
    toHumanAmount(simulation.actualCollateralSeized, collateralAssetDecimals) * collateralAssetPriceUsd;
  const debtRepaidUsd = toHumanAmount(simulation.actualDebtRepaid, debtAssetDecimals) * debtAssetPriceUsd;
  const swapProceedsUsd =
    toHumanAmount(simulation.debtAssetReceivedFromDisposal, debtAssetDecimals) * debtAssetPriceUsd;

  const grossProfitUsd = swapProceedsUsd - debtRepaidUsd;

  const flashLoanFeeUsd = debtRepaidUsd * (flashLoanPremiumBps / 10_000);

  const gasCostWei = simulation.totalGasUsed * gasPriceWei;
  const gasCostEth = Number(gasCostWei) / 1e18;
  const gasCostUsd = gasCostEth * ethPriceUsd;

  const netProfitUsd = grossProfitUsd - flashLoanFeeUsd - gasCostUsd;

  return {
    grossProfitUsd,
    netProfitUsd,
    breakdown: {
      collateralReceivedUsd,
      debtRepaidUsd,
      swapProceedsUsd,
      flashLoanFeeUsd,
      gasCostUsd,
    },
  };
}
