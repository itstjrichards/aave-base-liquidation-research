// Aave V3 Protocol Data Provider on Base. Verified on-chain: getUserReserveData() returned
// sane, decodable values (collateral/debt balances) for a real borrower address.
export const AAVE_DATA_PROVIDER_ADDRESS = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";

export const AAVE_DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
] as const;
