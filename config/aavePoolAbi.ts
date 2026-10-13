// Minimal Aave V3 Pool ABI: just the event/function signatures the watcher and simulator need.
// All entries were cross-checked against live Base mainnet data/source before use:
// - Supply/Borrow/getUserAccountData: matched against real emitted events and a real call.
// - liquidationCall/LiquidationCall: matched against Aave's official IPool.sol interface and
//   LiquidationLogic.sol, which confirms the event's debtToCover/liquidatedCollateralAmount
//   fields carry the ACTUAL amounts repaid/seized, not an echo of the input parameter.
export const AAVE_POOL_ABI = [
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() view returns (address[])",
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external",
] as const;
