// Aave V3 Oracle on Base. Verified on-chain: getSourceOfAsset(WETH) matches the address book's
// WETH_ORACLE constant, and getAssetPrice(WETH) matched that source's own latestAnswer() exactly
// (BASE_CURRENCY_UNIT = 1e8, BASE_CURRENCY = address(0), i.e. plain 8-decimal USD prices).
export const AAVE_ORACLE_ADDRESS = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156";

export const AAVE_ORACLE_ABI = [
  "function getSourceOfAsset(address asset) view returns (address)",
  "function getAssetPrice(address asset) view returns (uint256)",
] as const;
