// Uniswap V3 SwapRouter02 on Base. Verified on-chain: factory() and WETH9() return the
// canonical Uniswap V3 factory and Base's canonical WETH address, confirming this is the
// genuine router and not an impersonating contract.
export const UNISWAP_V3_ROUTER_ADDRESS = "0x2626664c2603336E57B271c5C0b26F421741e481";

// SwapRouter02 (unlike the original SwapRouter) takes no `deadline` param — it enforces
// deadlines at the block level instead. Both exactInput* functions are used: exactOutputSingle
// to acquire a precise amount of the debt asset, exactInputSingle to liquidate all of the
// seized collateral back into the debt asset.
export const UNISWAP_V3_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
] as const;

// Standard Uniswap V3 fee tiers, tried in order until one has a liquid enough pool.
export const UNISWAP_V3_FEE_TIERS = [500, 3000, 10000] as const;

export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
] as const;

// Base's canonical WETH9, used to acquire the debt asset via Uniswap before liquidating.
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

export const WETH_ABI = [
  "function deposit() payable",
  ...ERC20_ABI,
] as const;
