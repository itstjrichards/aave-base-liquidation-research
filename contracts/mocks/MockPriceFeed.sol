// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Minimal Chainlink AggregatorInterface stand-in: only `latestAnswer()` is needed,
/// since that's the only function Aave's AaveOracle actually calls on a price source
/// (see AaveOracle.getAssetPrice). Never deployed anywhere but a local Anvil fork — its
/// compiled *runtime* bytecode is injected in place of a real Chainlink feed via
/// `anvil_setCode` purely to test the liquidation simulator's success path against an
/// artificially undercollateralized position, without ever touching a live network or
/// real funds.
///
/// `answer` is a plain storage variable, not a constructor argument or immutable: since
/// `anvil_setCode` only replaces an address's code and never runs a constructor, the price
/// is set afterward with a direct `anvil_setStorageAt` write to slot 0 (this contract's only
/// state variable). A constructor-initialized value would silently stay zero.
contract MockPriceFeed {
  int256 public answer;

  function latestAnswer() external view returns (int256) {
    return answer;
  }
}
