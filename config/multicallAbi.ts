// Multicall3 is deployed at this same address on nearly every EVM chain, including Base.
// Verified on-chain: provider.getCode(MULTICALL3_ADDRESS) returns non-empty bytecode on Base.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
] as const;
