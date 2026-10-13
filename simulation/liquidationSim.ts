import {
  Contract,
  MaxUint256,
  Transaction,
  Wallet,
  type Provider,
  type TransactionReceipt,
} from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import { AAVE_DATA_PROVIDER_ABI, AAVE_DATA_PROVIDER_ADDRESS } from "../config/aaveDataProviderAbi";
import { AAVE_ORACLE_ABI, AAVE_ORACLE_ADDRESS } from "../config/aaveOracleAbi";
import {
  ERC20_ABI,
  UNISWAP_V3_FEE_TIERS,
  UNISWAP_V3_ROUTER_ABI,
  UNISWAP_V3_ROUTER_ADDRESS,
  WETH_ABI,
  WETH_ADDRESS,
} from "../config/uniswapAbi";
import { startAnvilFork, type AnvilFork } from "./forkManager";

/** A liquidation opportunity to simulate: which position, which asset pair, how much to repay. */
export interface LiquidationOpportunity {
  /** The borrower being liquidated. */
  user: string;
  /** The collateral asset to seize. */
  collateralAsset: string;
  /** The debt asset to repay. */
  debtAsset: string;
  /**
   * Amount of debtAsset to repay, in that asset's smallest unit. Defaults to `MaxUint256`,
   * which tells Aave to repay as much as its own close-factor rules allow — the simulation
   * reads back the real amount from the emitted event either way (see `actualDebtRepaid`).
   */
  debtToCover?: bigint;
}

/** Real, measured outcome of simulating a liquidation + collateral disposal on a local fork. */
export interface LiquidationSimulationResult {
  /** The block the Anvil fork was pinned at. */
  forkBlockNumber: number;
  /** Gas actually used by the liquidationCall transaction. */
  liquidationGasUsed: bigint;
  /** Gas used acquiring the debt asset up front (wrap-only if debtAsset is WETH). */
  acquisitionSwapGasUsed: bigint;
  /** Gas used swapping seized collateral back into the debt asset (0 if none was needed). */
  disposalSwapGasUsed: bigint;
  /** Sum of all three gas figures above — the total cost of the whole simulated flow. */
  totalGasUsed: bigint;
  /** Effective gas price (wei) paid for the liquidationCall transaction, for USD cost conversion. */
  effectiveGasPriceWei: bigint;
  /** Actual amount of debtAsset repaid, read from the LiquidationCall event (not the input). */
  actualDebtRepaid: bigint;
  /** Actual amount of collateral seized, read from the LiquidationCall event. */
  actualCollateralSeized: bigint;
  /** Actual amount of debtAsset received from swapping the seized collateral. */
  debtAssetReceivedFromDisposal: bigint;
  /** Which Uniswap V3 fee tier the disposal swap succeeded on (0 if no swap was needed). */
  disposalSwapFeeTier: number;
}

/** Case-insensitive address equality (checksummed and lowercase addresses both compare equal). */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Hands out sequentially increasing nonces for a single signer's transactions within one
 * simulation run. Needed because relying on ethers' default per-send "pending" nonce fetch
 * raced with Anvil's own nonce bookkeeping in practice: querying the nonce immediately after
 * a transaction is confirmed can briefly return the pre-confirmation value, causing the next
 * transaction to be signed with an already-used nonce and rejected as "nonce too low". Tracking
 * it ourselves, starting from one fetch at the very beginning, sidesteps that race entirely.
 */
class NonceTracker {
  private next: number;

  private constructor(start: number) {
    this.next = start;
  }

  static async start(provider: Provider, address: string): Promise<NonceTracker> {
    return new NonceTracker(await provider.getTransactionCount(address, "latest"));
  }

  take(): number {
    return this.next++;
  }
}

function isNonceTooLowError(err: unknown): boolean {
  return (err as { code?: string })?.code === "NONCE_EXPIRED";
}

/**
 * Recovers from a "nonce too low" send failure by checking whether the transaction actually
 * landed anyway. Ethers' NONCE_EXPIRED error carries the raw signed transaction it tried (and
 * failed) to send in `err.transaction` — its hash is deterministic from those bytes regardless
 * of whether *our* client got a confirmation, so if a client-side timeout caused a resend of an
 * already-accepted transaction, looking that hash up directly finds the real, successful
 * receipt. Polls briefly in case it's still landing. Returns null if it genuinely never landed.
 */
async function recoverFromNonceCollision(
  provider: Provider,
  err: unknown,
): Promise<TransactionReceipt | null> {
  const rawTx = (err as { transaction?: string })?.transaction;
  if (!rawTx) return null;

  let hash: string | null;
  try {
    hash = Transaction.from(rawTx).hash;
  } catch {
    return null;
  }
  if (!hash) return null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * Sends a contract transaction, but performs the identical call via `staticCall` first — a
 * plain eth_call, safe to retry — so Anvil has already fetched any previously-untouched fork
 * state the call needs before the real send.
 *
 * Why this matters: Anvil lazily fetches state it hasn't seen yet from the upstream RPC. Under
 * a slow or rate-limited upstream (e.g. a free-tier key already used heavily this session),
 * that fetch can take long enough that the local RPC client times out and retries sending the
 * already-signed transaction — while the first attempt is still landing. Both eventually land,
 * and the second surfaces as a spurious "nonce too low". The staticCall warm-up reduces how
 * often this happens; `recoverFromNonceCollision` handles it on the (rarer) occasions it still
 * does, by finding the real receipt of whichever attempt actually landed.
 */
async function sendWarmed<A extends unknown[]>(
  method: {
    (...args: unknown[]): Promise<{ wait: () => Promise<TransactionReceipt> }>;
    staticCall: (...args: unknown[]) => Promise<unknown>;
  },
  provider: Provider,
  nonceTracker: NonceTracker,
  args: A,
  overrides: Record<string, unknown> = {},
): Promise<TransactionReceipt> {
  await method.staticCall(...args, overrides);
  try {
    const tx = await method(...args, { ...overrides, nonce: nonceTracker.take() });
    return await tx.wait();
  } catch (err) {
    if (isNonceTooLowError(err)) {
      const recovered = await recoverFromNonceCollision(provider, err);
      if (recovered) return recovered;
    }
    throw err;
  }
}

/**
 * Tries `attempt` against each of `feeTiers` in order, returning the first one that doesn't
 * throw. Uniswap V3 pools are per-fee-tier, and not every pair has liquidity at every tier.
 */
async function tryFeeTiers<T>(
  feeTiers: readonly number[],
  attempt: (feeTier: number) => Promise<T>,
): Promise<T & { feeTier: number }> {
  let lastError: unknown;
  for (const feeTier of feeTiers) {
    try {
      const result = await attempt(feeTier);
      return { ...result, feeTier };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No Uniswap V3 fee tier had enough liquidity: ${String(lastError)}`);
}

/**
 * Simulates liquidating `opportunity` end-to-end on a fresh local Anvil fork: acquires the
 * debt asset, calls Aave's liquidationCall, then swaps the seized collateral back into the
 * debt asset via Uniswap V3. Every number in the result is measured from real (simulated)
 * execution — gas from transaction receipts, amounts from the protocol's own emitted events
 * and on-chain balances — not estimated. The fork is always torn down before returning,
 * including on error.
 */
export async function simulateLiquidation(
  opportunity: LiquidationOpportunity,
): Promise<LiquidationSimulationResult> {
  const fork = await startAnvilFork();
  try {
    return await simulateLiquidationOnFork(fork, opportunity);
  } finally {
    await fork.stop();
  }
}

/**
 * Same as `simulateLiquidation`, but runs against a fork the caller already started and owns
 * (and is responsible for stopping) — for callers that need to act on that fork first, such as
 * `priceManipulation.ts`'s test harness manipulating a price feed before liquidating.
 */
export async function simulateLiquidationOnFork(
  fork: AnvilFork,
  opportunity: LiquidationOpportunity,
): Promise<LiquidationSimulationResult> {
  const { user, collateralAsset, debtAsset } = opportunity;
  const debtToCover = opportunity.debtToCover ?? MaxUint256;

  // Anvil's account #0: a well-known local test key, pre-funded with 10,000 fork-only ETH.
  // Fetched from anvil's own startup output rather than hardcoded (see forkManager.ts).
  const liquidator = new Wallet(fork.accounts[0].privateKey, fork.provider);

  const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, liquidator);
  const dataProvider = new Contract(AAVE_DATA_PROVIDER_ADDRESS, AAVE_DATA_PROVIDER_ABI, fork.provider);
  const router = new Contract(UNISWAP_V3_ROUTER_ADDRESS, UNISWAP_V3_ROUTER_ABI, liquidator);
  const weth = new Contract(WETH_ADDRESS, WETH_ABI, liquidator);
  const debtToken = new Contract(debtAsset, ERC20_ABI, liquidator);
  const collateralToken = new Contract(collateralAsset, ERC20_ABI, liquidator);

  const nonceTracker = await NonceTracker.start(fork.provider, liquidator.address);

  const debtAssetNeeded = await determineDebtAssetNeeded(dataProvider, debtAsset, user);
  const { gasUsed: acquisitionSwapGasUsed } = await acquireDebtAsset(
    fork.provider,
    nonceTracker,
    weth,
    router,
    liquidator.address,
    debtAsset,
    debtAssetNeeded,
  );

  await sendWarmed(debtToken.approve, fork.provider, nonceTracker, [config.aavePoolAddress, debtAssetNeeded]);

  const liquidationReceipt = await sendWarmed(pool.liquidationCall, fork.provider, nonceTracker, [
    collateralAsset,
    debtAsset,
    user,
    debtToCover,
    false,
  ]);

  const { actualDebtRepaid, actualCollateralSeized } = readLiquidationCallEvent(pool, liquidationReceipt.logs);

  const { debtAssetReceivedFromDisposal, disposalSwapGasUsed, disposalSwapFeeTier } = await disposeOfCollateral(
    fork.provider,
    nonceTracker,
    router,
    collateralToken,
    liquidator.address,
    collateralAsset,
    debtAsset,
    actualCollateralSeized,
  );

  return {
    forkBlockNumber: fork.blockNumber,
    liquidationGasUsed: liquidationReceipt.gasUsed,
    acquisitionSwapGasUsed,
    disposalSwapGasUsed,
    totalGasUsed: liquidationReceipt.gasUsed + acquisitionSwapGasUsed + disposalSwapGasUsed,
    effectiveGasPriceWei: liquidationReceipt.gasPrice,
    actualDebtRepaid,
    actualCollateralSeized,
    debtAssetReceivedFromDisposal,
    disposalSwapFeeTier,
  };
}

/**
 * Reads the borrower's full outstanding balance (stable + variable) in `debtAsset`, plus a
 * small buffer. This is a safe upper bound for whatever liquidationCall actually pulls — Aave
 * can never liquidate more than the borrower owes — so acquiring this much guarantees the
 * liquidation won't fail for lack of funds, regardless of Aave's internal close-factor math.
 */
async function determineDebtAssetNeeded(
  dataProvider: Contract,
  debtAsset: string,
  user: string,
): Promise<bigint> {
  const { currentStableDebt, currentVariableDebt } = await dataProvider.getUserReserveData(debtAsset, user);
  const outstandingDebt = (currentStableDebt as bigint) + (currentVariableDebt as bigint);
  if (outstandingDebt === 0n) {
    throw new Error(`${user} has no outstanding debt in asset ${debtAsset}; nothing to liquidate`);
  }
  return outstandingDebt + (outstandingDebt * BigInt(config.debtAcquisitionBufferBps)) / 10_000n;
}

/**
 * Acquires `amountNeeded` of `debtAsset` in the liquidator's wallet: a direct WETH wrap if
 * the debt asset is WETH itself, otherwise a Uniswap V3 exactOutputSingle swap from WETH.
 * The liquidator starts with 10,000 fork-only ETH (see forkManager.ts), plenty to wrap and
 * spend without needing to size the swap precisely.
 */
async function acquireDebtAsset(
  provider: Provider,
  nonceTracker: NonceTracker,
  weth: Contract,
  router: Contract,
  liquidatorAddress: string,
  debtAsset: string,
  amountNeeded: bigint,
): Promise<{ gasUsed: bigint }> {
  if (sameAddress(debtAsset, WETH_ADDRESS)) {
    const receipt = await sendWarmed(weth.deposit, provider, nonceTracker, [], { value: amountNeeded });
    return { gasUsed: receipt.gasUsed };
  }

  const wrapAmount = 5000n * 10n ** 18n;
  await sendWarmed(weth.deposit, provider, nonceTracker, [], { value: wrapAmount });
  await sendWarmed(weth.approve, provider, nonceTracker, [await router.getAddress(), wrapAmount]);

  const { gasUsed } = await tryFeeTiers(UNISWAP_V3_FEE_TIERS, async (fee) => {
    const receipt = await sendWarmed(router.exactOutputSingle, provider, nonceTracker, [
      {
        tokenIn: WETH_ADDRESS,
        tokenOut: debtAsset,
        fee,
        recipient: liquidatorAddress,
        amountOut: amountNeeded,
        amountInMaximum: wrapAmount,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    return { gasUsed: receipt.gasUsed };
  });

  return { gasUsed };
}

/** Pulls the actual repaid/seized amounts out of the LiquidationCall event in a tx's logs. */
function readLiquidationCallEvent(
  pool: Contract,
  logs: readonly { topics: readonly string[]; data: string }[],
): { actualDebtRepaid: bigint; actualCollateralSeized: bigint } {
  for (const log of logs) {
    let parsed;
    try {
      parsed = pool.interface.parseLog(log);
    } catch {
      continue; // Not one of the Pool's own events (e.g. an ERC20 Transfer) — skip it.
    }
    if (parsed?.name === "LiquidationCall") {
      // Despite the ABI's parameter name, this field carries the ACTUAL amount repaid, not
      // an echo of the debtToCover input — confirmed against Aave's LiquidationLogic.sol.
      return {
        actualDebtRepaid: parsed.args.debtToCover as bigint,
        actualCollateralSeized: parsed.args.liquidatedCollateralAmount as bigint,
      };
    }
  }
  throw new Error("liquidationCall succeeded but no LiquidationCall event was found in its receipt");
}

/**
 * Swaps the seized collateral into the debt asset via Uniswap V3. If the collateral asset
 * already IS the debt asset (Aave allows same-asset liquidations), no swap is needed.
 */
async function disposeOfCollateral(
  provider: Provider,
  nonceTracker: NonceTracker,
  router: Contract,
  collateralToken: Contract,
  liquidatorAddress: string,
  collateralAsset: string,
  debtAsset: string,
  amountSeized: bigint,
): Promise<{ debtAssetReceivedFromDisposal: bigint; disposalSwapGasUsed: bigint; disposalSwapFeeTier: number }> {
  if (sameAddress(collateralAsset, debtAsset)) {
    return { debtAssetReceivedFromDisposal: amountSeized, disposalSwapGasUsed: 0n, disposalSwapFeeTier: 0 };
  }

  await sendWarmed(collateralToken.approve, provider, nonceTracker, [await router.getAddress(), amountSeized]);

  const { gasUsed, amountOut, feeTier } = await tryFeeTiers(UNISWAP_V3_FEE_TIERS, async (fee) => {
    const params = {
      tokenIn: collateralAsset,
      tokenOut: debtAsset,
      fee,
      recipient: liquidatorAddress,
      amountIn: amountSeized,
      amountOutMinimum: 0n, // A simulation measures the real outcome; it doesn't need slippage protection.
      sqrtPriceLimitX96: 0n,
    };
    // exactInputSingle's return value isn't otherwise observable from a mined tx; sendWarmed's
    // own staticCall (for cache-warming) doesn't return it, so it's read explicitly here too.
    const amountOut = await router.exactInputSingle.staticCall(params);
    const receipt = await sendWarmed(router.exactInputSingle, provider, nonceTracker, [params]);
    return { gasUsed: receipt.gasUsed, amountOut };
  });

  return { debtAssetReceivedFromDisposal: amountOut, disposalSwapGasUsed: gasUsed, disposalSwapFeeTier: feeTier };
}

/**
 * Convenience helper for finding something to simulate: scans a borrower's reserves and picks
 * the largest-by-USD-value enabled collateral position and the largest-by-USD-value debt
 * position. Not part of the simulation itself — a real caller (e.g. the health factor watcher
 * plus a full profitability strategy) would supply collateralAsset/debtAsset directly, likely
 * with a more sophisticated selection than "biggest position."
 *
 * Picking by USD value rather than just "the first reserve with a nonzero balance" matters:
 * a user can hold dust in one reserve (a few cents) and thousands of dollars in another, and a
 * reserve can have a nonzero aToken balance while having `usageAsCollateralEnabled = false`
 * (contributes nothing to their health factor or to what liquidationCall can seize).
 */
export async function findLiquidatableAssetPair(
  user: string,
  provider: Provider,
): Promise<{ collateralAsset: string; debtAsset: string } | null> {
  const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, provider);
  const dataProvider = new Contract(AAVE_DATA_PROVIDER_ADDRESS, AAVE_DATA_PROVIDER_ABI, provider);
  const oracle = new Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

  const reserves: string[] = await pool.getReservesList();
  const [reserveData, prices, decimalsList] = await Promise.all([
    Promise.all(reserves.map((reserve) => dataProvider.getUserReserveData(reserve, user))),
    Promise.all(reserves.map((reserve) => oracle.getAssetPrice(reserve))),
    Promise.all(reserves.map((reserve) => new Contract(reserve, ERC20_ABI, provider).decimals())),
  ]);

  let bestCollateral: { asset: string; valueUsd: bigint } | null = null;
  let bestDebt: { asset: string; valueUsd: bigint } | null = null;

  reserves.forEach((reserve, i) => {
    const { currentATokenBalance, currentStableDebt, currentVariableDebt, usageAsCollateralEnabled } =
      reserveData[i];
    const price = prices[i] as bigint;
    const scale = 10n ** BigInt(decimalsList[i]);

    if (usageAsCollateralEnabled && (currentATokenBalance as bigint) > 0n) {
      const valueUsd = ((currentATokenBalance as bigint) * price) / scale;
      if (!bestCollateral || valueUsd > bestCollateral.valueUsd) {
        bestCollateral = { asset: reserve, valueUsd };
      }
    }

    const debtBalance = (currentStableDebt as bigint) + (currentVariableDebt as bigint);
    if (debtBalance > 0n) {
      const valueUsd = (debtBalance * price) / scale;
      if (!bestDebt || valueUsd > bestDebt.valueUsd) {
        bestDebt = { asset: reserve, valueUsd };
      }
    }
  });

  return bestCollateral && bestDebt
    ? { collateralAsset: (bestCollateral as { asset: string }).asset, debtAsset: (bestDebt as { asset: string }).asset }
    : null;
}
