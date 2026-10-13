import { Contract, toBeHex, zeroPadValue, type JsonRpcProvider } from "ethers";
import { AAVE_ORACLE_ABI, AAVE_ORACLE_ADDRESS } from "../config/aaveOracleAbi";

// Compiled *runtime* bytecode of contracts/mocks/MockPriceFeed.sol (via `forge build`).
// Exposes only `latestAnswer()` (selector 0x50d25bcd) reading a single storage slot — the
// only function Aave's AaveOracle calls on a price source. Embedded as a constant so
// simulations don't depend on `forge` being available at run time; recompile with
// `forge build` and copy `out/MockPriceFeed.sol/MockPriceFeed.json`'s `deployedBytecode.object`
// here if the contract ever changes.
const MOCK_PRICE_FEED_RUNTIME_BYTECODE =
  "0x6080604052348015600e575f5ffd5b50600436106030575f3560e01c806350d25bcd14603457806385bb7d6914604e575b5f5ffd5b603a6068565b60405160459190608b565b60405180910390f35b60546070565b604051605f9190608b565b60405180910390f35b5f5f54905090565b5f5481565b5f819050919050565b6085816075565b82525050565b5f602082019050609c5f830184607e565b9291505056fea264697066735822122004bb2d4f3080ddd4f2eee6e2ee7f9997a0f2286d2545aef72a6f700a7183eb3964736f6c63430008250033";

// `answer` is MockPriceFeed's only state variable, so it lives at storage slot 0.
const ANSWER_STORAGE_SLOT = zeroPadValue("0x00", 32);

/**
 * Testing/demo utility ONLY — never used by the simulation's normal path. Forces an asset's
 * Aave-reported price on a fork to `newPriceUsd8Decimals` (8-decimal USD, matching Base's
 * Aave deployment — see aaveOracleAbi.ts), by replacing its real Chainlink-style price feed's
 * code with a trivial mock and writing the desired price straight into that mock's storage.
 *
 * This exists to test the liquidation simulator's success path on demand, without waiting for
 * (or needing) a naturally-occurring undercollateralized position on the live chain — real
 * liquidatable positions get sniped by other bots within seconds, so one may not be available
 * to test against at any given moment. Entirely confined to the local fork: `anvil_setCode`/
 * `anvil_setStorageAt` only affect the throwaway fork process and are reverted the instant it's
 * stopped; nothing here is ever broadcast to a live network.
 */
export async function setMockAssetPrice(
  provider: JsonRpcProvider,
  asset: string,
  newPriceUsd8Decimals: bigint,
): Promise<void> {
  const oracle = new Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);
  const priceFeedAddress: string = await oracle.getSourceOfAsset(asset);
  if (priceFeedAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No price source registered for asset ${asset}`);
  }

  await provider.send("anvil_setCode", [priceFeedAddress, MOCK_PRICE_FEED_RUNTIME_BYTECODE]);
  await provider.send("anvil_setStorageAt", [
    priceFeedAddress,
    ANSWER_STORAGE_SLOT,
    zeroPadValue(toBeHex(newPriceUsd8Decimals), 32),
  ]);

  const actualPrice: bigint = await oracle.getAssetPrice(asset);
  if (actualPrice !== newPriceUsd8Decimals) {
    throw new Error(
      `Price override didn't take effect: expected ${newPriceUsd8Decimals}, oracle reports ${actualPrice}`,
    );
  }
}
