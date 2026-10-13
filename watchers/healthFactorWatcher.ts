import { Contract, EventLog, JsonRpcProvider, parseUnits, formatUnits, type ContractEventName } from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "../config/multicallAbi";
import { findLiquidatableAssetPair, simulateLiquidation } from "../simulation/liquidationSim";
import { calculateLiquidationProfit } from "../pricing/profitCalculator";
import { fetchProfitPrices } from "../pricing/priceFetcher";
import { hasPendingOpportunity, insertOpportunity } from "../storage/db";
import {
  hasActiveAlertEpisode,
  recordAlertTick,
  resolveRecoveredEpisodes,
  type AlertSeverity,
} from "../storage/alertsDb";
import { startLiquidationOutcomeTracker } from "./liquidationOutcomeTracker";
import { recordObservedLiquidation } from "./observedLiquidations";
import { startHistoricalSimWorker } from "./historicalSimWorker";
import {
  discoveryProvider,
  runDeepBorrowerBackfillWithRetry,
  scanRangeOnDiscoveryRpc,
} from "./borrowerDiscovery";
import { extractErrorMessage, isRateLimitError, mapWithConcurrency, parseSuggestedRangeWidth, sleep } from "./rpcHelpers";
import {
  countBorrowers,
  getStateNumber,
  loadActiveBorrowers,
  recordHealthFactorsBulk,
  setBorrowerStates,
  setStateNumber,
  upsertBorrower,
} from "../storage/borrowersDb";

const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, provider);
const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
const discoveryMulticall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, discoveryProvider);

const hfWatchThresholdWei = parseUnits(config.hfWatchThreshold, 18);
const hfWarningThresholdWei = parseUnits(config.hfWarningThreshold, 18);
const hfCriticalThresholdWei = parseUnits(config.hfCriticalThreshold, 18);

if (!(hfCriticalThresholdWei < hfWarningThresholdWei && hfWarningThresholdWei < hfWatchThresholdWei)) {
  throw new Error(
    "Alert thresholds must satisfy hfCriticalThreshold < hfWarningThreshold < hfWatchThreshold " +
      `(got critical=${config.hfCriticalThreshold}, warning=${config.hfWarningThreshold}, watch=${config.hfWatchThreshold})`,
  );
}

/** Classifies a health factor into an alert tier, or null if it's not in any alert tier. */
function classifyAlertSeverity(healthFactor: bigint): AlertSeverity | null {
  if (healthFactor < hfCriticalThresholdWei) return "critical";
  if (healthFactor < hfWarningThresholdWei) return "warning";
  if (healthFactor < hfWatchThresholdWei) return "watch";
  return null;
}

const hfHotThresholdWei = parseUnits(config.hfHotThreshold, 18);
if (hfHotThresholdWei <= hfWatchThresholdWei) {
  throw new Error(
    `hfHotThreshold (${config.hfHotThreshold}) must be above hfWatchThreshold (${config.hfWatchThreshold}) so ` +
      "every alert-tier borrower is polled on the fast path",
  );
}

// The hard on-chain threshold below which a position is actually eligible for liquidationCall
// (as opposed to the alert tiers above, an early-warning heuristic for positions still above 1.0).
const HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 10n ** 18n;

// type(uint256).max: Aave's sentinel for "no debt", never a real health factor.
const NO_DEBT_HEALTH_FACTOR = (1n << 256n) - 1n;

/**
 * True if a position has no debt, or so little (under config.minOpportunityDebtUsd) that it could
 * never be worth liquidating. Both are retired to 'dormant' in the borrowers DB: debt only grows
 * through a new Borrow event (which revives the borrower), so there is nothing to watch. Without
 * this, abandoned dust positions stuck below the hot threshold would be polled every tick forever.
 */
function isNotWorthWatching(totalDebtBase: bigint, healthFactor: bigint): boolean {
  return (
    totalDebtBase === 0n ||
    healthFactor === NO_DEBT_HEALTH_FACTOR ||
    Number(totalDebtBase) / 1e8 < config.minOpportunityDebtUsd
  );
}

// Borrowers discovered so far, split by how often they're polled (see config.hfHotThreshold).
// Hot: below the hot threshold (or not yet checked) — polled every tick on the primary RPC.
// Cold: safely healthy — swept every coldSweepIntervalMs on the free discovery RPC.
// Borrowers known to have no debt are in neither set (they're 'dormant' in the borrowers DB).
const hotAddresses = new Set<string>();
const coldAddresses = new Set<string>();
// Last health factor seen for each cold borrower, used to decide how often to re-check them.
// Absent = never checked, which always gets checked on the next sweep.
const coldHealthFactors = new Map<string, bigint>();

// How often a cold borrower is re-checked, by how safe they last looked. A position far from
// liquidation can't become liquidatable within one sweep interval, so re-checking it every sweep
// just spends free-endpoint requests. Every band is measured in sweeps (config.coldSweepIntervalMs).
const COLD_BAND_FAST_BELOW = 15n * 10n ** 17n; // HF < 1.5: every sweep
const COLD_BAND_MID_BELOW = 3n * 10n ** 18n; // HF < 3.0: every 6th sweep
const COLD_MID_EVERY_N_SWEEPS = 6;
const COLD_SLOW_EVERY_N_SWEEPS = 30; // HF >= 3.0
let coldSweepCounter = 0;

/** True if a cold borrower with this last-seen health factor should be checked on sweep number `n`. */
function isColdBorrowerDue(healthFactor: bigint | undefined, sweepNumber: number): boolean {
  if (healthFactor === undefined || healthFactor < COLD_BAND_FAST_BELOW) return true;
  if (healthFactor < COLD_BAND_MID_BELOW) return sweepNumber % COLD_MID_EVERY_N_SWEEPS === 0;
  return sweepNumber % COLD_SLOW_EVERY_N_SWEEPS === 0;
}

// A shared gate rather than per-call independent backoff: with several concurrent workers,
// each retrying its own exponential backoff on a 429 causes them to collide and re-trigger
// the provider's rate limit repeatedly. This gate does two things for every RPC call funneled
// through it: (1) proactively spaces calls at least rpcMinIntervalMs apart so we stay under a
// requests-per-second cap instead of bursting and reacting after the fact, and (2) on an
// actual rate-limit response, pauses *all* callers together behind a growing cooldown so they
// resume in step rather than colliding again immediately.
class RateLimitGate {
  private cooldownUntil = 0;
  private backoffMs = 500;
  private readonly maxBackoffMs = 15_000;
  private nextSlotAt = 0;

  /** Blocks until it's this caller's turn: past any active cooldown and its paced time slot. */
  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.cooldownUntil, this.nextSlotAt);
    this.nextSlotAt = slot + config.rpcMinIntervalMs;
    const delay = slot - now;
    if (delay > 0) {
      await sleep(delay);
    }
  }

  /** Called after a rate-limit response: starts/extends a shared cooldown for all callers. */
  onRateLimited(): void {
    this.cooldownUntil = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  /** Called after any successful call: resets the backoff so future limits start small again. */
  onSuccess(): void {
    this.backoffMs = 500;
  }
}

const rateLimitGate = new RateLimitGate();

/** Runs `fn` through the shared rate-limit gate, recording success/failure for future pacing. */
async function withRateLimitGate<T>(fn: () => Promise<T>): Promise<T> {
  await rateLimitGate.wait();
  try {
    const result = await fn();
    rateLimitGate.onSuccess();
    return result;
  } catch (err) {
    if (isRateLimitError(err)) {
      rateLimitGate.onRateLimited();
    }
    throw err;
  }
}

/**
 * Handles one Borrow event: records the borrower in the persistent store and puts them on the
 * hot list so their position is checked promptly (a fresh borrow changes their health factor).
 * Only logs when the address is genuinely new or was previously known to be debt-free.
 */
function trackBorrower(onBehalfOf: string, blockNumber: number, quiet = false): void {
  const result = upsertBorrower(onBehalfOf, blockNumber, "hot", true);
  coldAddresses.delete(onBehalfOf);
  hotAddresses.add(onBehalfOf);
  if (result !== "existing" && !quiet) {
    console.log(`${result === "new" ? "New tracked borrower" : "Revived borrower"}: ${onBehalfOf}`);
  }
}

// One eth_getLogs request that matches Borrow AND LiquidationCall together (an OR across the two
// event signatures in topic 0, all on the Pool address). Borrow finds borrowers — an address can
// only owe money after a Borrow, so Supply events aren't needed. Scanning both event types in a
// single request keeps RPC usage flat no matter how many we track: on a provider that caps the
// block range (Alchemy free tier: 10 blocks), request count, and so compute-unit cost, scales
// with blocks scanned rather than with event types.
const POOL_EVENT_FILTER: ContractEventName = [
  [
    pool.interface.getEvent("Borrow")!.topicHash,
    pool.interface.getEvent("LiquidationCall")!.topicHash,
  ],
];

// Preferred chunk width, discovered per-run from the RPC provider's own eth_getLogs range
// cap (see discoverLogChunkBlocks). Different providers enforce very different limits, e.g.
// Alchemy's free tier allows only 10 blocks per call vs. ~2000+ on the public Base RPC.
let effectiveLogChunkBlocks = config.logChunkBlocks;

/**
 * Fetches Supply/Borrow logs for one [start, end] block range, retrying and self-correcting
 * along the way: rate-limit errors retry through the shared gate; a "range too large" error
 * narrows the chunk size (adopted for all future chunks) and re-splits just this range; any
 * other error falls back to binary-splitting the range until it's small enough to succeed.
 */
async function queryFilterWithRetry(
  filter: ContractEventName,
  start: number,
  end: number,
  attempt = 0,
): Promise<EventLog[]> {
  try {
    const logs = await withRateLimitGate(() => pool.queryFilter(filter, start, end));
    return logs.filter((log): log is EventLog => log instanceof EventLog);
  } catch (err) {
    if (isRateLimitError(err) && attempt < 8) {
      return queryFilterWithRetry(filter, start, end, attempt + 1);
    }

    const suggestedWidth = parseSuggestedRangeWidth(extractErrorMessage(err));
    if (suggestedWidth && suggestedWidth < end - start + 1) {
      if (suggestedWidth < effectiveLogChunkBlocks) {
        effectiveLogChunkBlocks = suggestedWidth;
      }
      const results: EventLog[] = [];
      for (let s = start; s <= end; s += suggestedWidth) {
        const e = Math.min(s + suggestedWidth - 1, end);
        results.push(...(await queryFilterWithRetry(filter, s, e, 0)));
      }
      return results;
    }

    if (end - start < 2) {
      console.error(`Failed to fetch logs for blocks ${start}-${end}, skipping:`, err);
      return [];
    }

    const mid = start + Math.floor((end - start) / 2);
    const first = await queryFilterWithRetry(filter, start, mid);
    const second = await queryFilterWithRetry(filter, mid + 1, end);
    return [...first, ...second];
  }
}

/**
 * Probes the provider's real eth_getLogs range limit once, up front, instead of
 * discovering it via repeated failed chunk requests during the main backfill loop.
 */
async function discoverLogChunkBlocks(latestBlock: number): Promise<void> {
  const probeStart = Math.max(0, latestBlock - config.logChunkBlocks + 1);
  try {
    await withRateLimitGate(() => pool.queryFilter(pool.filters.Borrow(), probeStart, latestBlock));
  } catch (err) {
    const suggestedWidth = parseSuggestedRangeWidth(extractErrorMessage(err));
    effectiveLogChunkBlocks = suggestedWidth ?? Math.max(10, Math.floor(config.logChunkBlocks / 10));
    console.log(
      `Provider limits eth_getLogs range; using ${effectiveLogChunkBlocks}-block chunks ` +
        `(configured preference was ${config.logChunkBlocks}).`,
    );
  }
}

// Highest block whose Borrow/LiquidationCall events have been processed; advances after each
// scan and is persisted, so the next scan (live tick or restart catch-up) only looks at new blocks.
let lastScannedBlock = 0;
const LIVE_SCANNED_KEY = "live_scanned_block";

/**
 * Applies a batch of Borrow/LiquidationCall logs: each Borrow puts its borrower on the hot list
 * (see trackBorrower), each LiquidationCall is recorded as an observed liquidation (see
 * observedLiquidations.ts). `duringBackfill` marks liquidations found while catching up on blocks
 * that passed before the watcher was looking, rather than live.
 */
function processPoolLogs(logs: EventLog[], duringBackfill: boolean): void {
  const liquidationLogs: EventLog[] = [];
  for (const log of logs) {
    if (log.eventName === "LiquidationCall") {
      liquidationLogs.push(log);
    } else {
      trackBorrower(log.args.onBehalfOf as string, log.blockNumber, duringBackfill);
    }
  }

  // Chunks can arrive out of order, so sort before recording to keep observation order (and the
  // cross-referencing against alert episodes) chronological.
  liquidationLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of liquidationLogs) {
    try {
      recordObservedLiquidation(log, duringBackfill);
    } catch (err) {
      console.error(`Failed to record observed liquidation in tx ${log.transactionHash}:`, err);
    }
  }
}

/**
 * Scans [fromBlock, toBlock] on the PRIMARY RPC for Borrow and LiquidationCall events. Splits the
 * range into effectiveLogChunkBlocks-sized chunks and fetches them concurrently (bounded by
 * config.logFetchConcurrency). Only used for the live tail — a few blocks at a time.
 */
async function scanBlockRangeOnPrimary(fromBlock: number, toBlock: number): Promise<void> {
  const chunks: Array<[number, number]> = [];
  for (let start = fromBlock; start <= toBlock; start += effectiveLogChunkBlocks) {
    chunks.push([start, Math.min(start + effectiveLogChunkBlocks - 1, toBlock)]);
  }

  const collected: EventLog[] = [];
  await mapWithConcurrency(chunks, config.logFetchConcurrency, async ([start, end]) => {
    collected.push(...(await queryFilterWithRetry(POOL_EVENT_FILTER, start, end)));
  });
  processPoolLogs(collected, false);
}

/**
 * Startup: restores the persisted borrower sets, then catches up on every block since the last
 * run (or, on a first run, the last config.eventLookbackBlocks) through the free discovery RPC —
 * a downtime gap of any size costs nothing on the primary key. Also starts the one-off deep
 * borrower history scan in the background (see borrowerDiscovery.ts).
 */
async function initializeBorrowerTracking(): Promise<void> {
  for (const { address, tier, lastHealthFactor } of loadActiveBorrowers()) {
    if (tier === "hot") {
      hotAddresses.add(address);
    } else {
      coldAddresses.add(address);
      if (lastHealthFactor !== null) coldHealthFactors.set(address, BigInt(lastHealthFactor));
    }
  }
  console.log(`Restored ${hotAddresses.size} hot and ${coldAddresses.size} cold borrower(s) from disk.`);

  const latestBlock = await provider.getBlockNumber();
  await discoverLogChunkBlocks(latestBlock);

  const persisted = getStateNumber(LIVE_SCANNED_KEY);
  const fromBlock = persisted !== null ? persisted + 1 : Math.max(0, latestBlock - config.eventLookbackBlocks);
  console.log(
    `Catching up on Borrow/LiquidationCall events from block ${fromBlock} to ${latestBlock} ` +
      `via ${config.discoveryRpcUrl} (${persisted !== null ? "resuming from saved progress" : "first run"})...`,
  );

  try {
    await scanRangeOnDiscoveryRpc(
      POOL_EVENT_FILTER,
      fromBlock,
      latestBlock,
      (logs) => processPoolLogs(logs, true),
      (coveredUpTo) => setStateNumber(LIVE_SCANNED_KEY, coveredUpTo),
    );
    lastScannedBlock = latestBlock;
  } catch (err) {
    // Don't let a discovery-RPC outage strand the watcher, and don't let the live scan try to
    // cover a huge gap on the metered key: resume live scanning from just behind the head and
    // say plainly that a gap may exist. (Saved progress is only advanced for completed batches,
    // so the next restart will retry the missing range.)
    lastScannedBlock = Math.max(fromBlock - 1, latestBlock - 500);
    console.error(
      `Catch-up scan failed (${extractErrorMessage(err)}); continuing live from block ${lastScannedBlock + 1}. ` +
        "Events in the skipped range will be picked up on the next restart.",
    );
  }
  setStateNumber(LIVE_SCANNED_KEY, lastScannedBlock);

  const summary = countBorrowers().map((r) => `${r.status}/${r.tier}=${r.n}`).join(" ");
  console.log(`Catch-up complete. Borrowers on disk: ${summary || "none"}.`);

  // Background, deliberately not awaited: the watcher polls what it already knows meanwhile.
  void runDeepBorrowerBackfillWithRetry(latestBlock, (addresses) => {
    for (const address of addresses) {
      if (!hotAddresses.has(address)) coldAddresses.add(address);
    }
  }).then(() => sweepColdAddresses().catch((err) => console.error("Cold sweep failed:", extractErrorMessage(err))));
}

// Plain eth_getLogs polling rather than contract.on()/eth_newFilter: stateful filters
// get silently dropped by load-balanced public RPCs (each poll can land on a different
// backend node), which surfaces as "filter not found" errors. Polling is stateless and
// works uniformly across any RPC provider.
/** Scans any blocks produced since the last scan for new borrowers and new liquidations. */
async function scanForNewAddresses(toBlock: number): Promise<void> {
  if (toBlock <= lastScannedBlock) return;
  await scanBlockRangeOnPrimary(lastScannedBlock + 1, toBlock);
  lastScannedBlock = toBlock;
  setStateNumber(LIVE_SCANNED_KEY, toBlock);
}

/** One entry of Multicall3's aggregate3 result: whether the call succeeded, and its raw output. */
interface Call3Result {
  success: boolean;
  returnData: string;
}

/**
 * Reads getUserAccountData for a batch of addresses in a single RPC call via Multicall3's
 * aggregate3 (allowFailure = true, so one reverting address doesn't fail the whole batch).
 * This is what lets the watcher poll hundreds of addresses without one eth_call per address.
 */
async function fetchAccountDataBatch(
  addresses: string[],
  attempt = 0,
  target: Contract = multicall,
): Promise<Call3Result[]> {
  const calls = addresses.map((address) => ({
    target: config.aavePoolAddress,
    allowFailure: true,
    callData: pool.interface.encodeFunctionData("getUserAccountData", [address]),
  }));

  try {
    return await withRateLimitGate(() => target.aggregate3.staticCall(calls));
  } catch (err) {
    if (isRateLimitError(err) && attempt < 8) {
      return fetchAccountDataBatch(addresses, attempt + 1, target);
    }
    throw err;
  }
}

/**
 * Handles a position that has actually crossed into liquidation eligibility (health factor
 * below 1.0, not just the early-warning alert threshold): finds an asset pair to liquidate,
 * simulates the liquidation on a throwaway fork, prices the result, and logs it as an
 * opportunity. Skips addresses that already have an unresolved opportunity logged, so a
 * position that stays eligible for several ticks isn't re-simulated (an actual Anvil fork
 * spin-up) every poll interval.
 */
async function handleLiquidationOpportunity(
  address: string,
  blockNumber: number,
  healthFactor: bigint,
): Promise<void> {
  if (hasPendingOpportunity(address)) return;

  console.warn(
    `[OPPORTUNITY] address=${address} healthFactor=${formatUnits(healthFactor, 18)} block=${blockNumber} — simulating...`,
  );

  const pair = await lookupAssetPairWithRetry(address);
  if (!pair) {
    console.warn(`  No seizable collateral + outstanding debt pair found for ${address}; skipping.`);
    return;
  }

  const simulation = await simulateLiquidation({
    user: address,
    collateralAsset: pair.collateralAsset,
    debtAsset: pair.debtAsset,
  });

  const prices = await fetchProfitPrices(
    provider,
    pair.collateralAsset,
    pair.debtAsset,
    simulation.effectiveGasPriceWei,
  );
  const profit = calculateLiquidationProfit(simulation, prices);

  insertOpportunity({
    blockNumber,
    borrowerAddress: address,
    collateralAsset: pair.collateralAsset,
    debtAsset: pair.debtAsset,
    healthFactor,
    profit,
  });

  console.warn(
    `  Logged opportunity for ${address}: grossProfit=$${profit.grossProfitUsd.toFixed(2)} ` +
      `netProfit=$${profit.netProfitUsd.toFixed(2)}`,
  );
}

/**
 * Looks up a borrower's collateral/debt pair, retrying a couple of times with a pause. The lookup
 * fires a burst of parallel calls, which the RPC can rate-limit when many borrowers open alert
 * episodes at once (e.g. right after startup); a later attempt usually succeeds. Returns null
 * (the episode is still recorded, just without a pair) if it keeps failing.
 */
async function lookupAssetPairWithRetry(address: string): Promise<{ collateralAsset: string; debtAsset: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Alternate between the free and primary RPC so one being rate-limited doesn't sink the lookup.
      return await findLiquidatableAssetPair(address, attempt % 2 === 0 ? discoveryProvider : provider);
    } catch (err) {
      if (attempt === 2) {
        console.error(`Failed to look up asset pair for ${address}: ${extractErrorMessage(err)}`);
        return null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Checks every HOT borrower's health factor as of `blockNumber` (cold borrowers are handled by
 * sweepColdAddresses on the free RPC). Logs an ALERT and records an alert episode
 * (storage/alertsDb.ts) for any address with outstanding debt in one of the watch/warning/
 * critical tiers (an early-warning heuristic), and additionally simulates + logs a full
 * opportunity for any address actually below the protocol's 1.0 liquidation threshold. Also
 * re-tiers borrowers as a side effect: one with no debt goes dormant, one that has recovered
 * above config.hfHotThreshold drops to cold. Addresses are split into config.multicallBatchSize-
 * sized batches to keep each Multicall3 call's calldata/gas within reasonable bounds.
 */
async function pollHealthFactors(blockNumber: number): Promise<void> {
  if (hotAddresses.size === 0) return;

  const addresses = Array.from(hotAddresses);
  const atRiskAddresses = new Set<string>();

  for (let start = 0; start < addresses.length; start += config.multicallBatchSize) {
    const batch = addresses.slice(start, start + config.multicallBatchSize);
    const tierChanges: Parameters<typeof setBorrowerStates>[0] = [];

    let results: Call3Result[];
    try {
      results = await fetchHotBatch(batch);
    } catch (err) {
      console.error(`Failed to fetch account data for batch starting at index ${start}:`, err);
      continue;
    }

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const address = batch[i];
      if (!result.success) {
        console.error(`getUserAccountData reverted for ${address}`);
        continue;
      }

      const [, totalDebtBase, , , , healthFactor] = pool.interface.decodeFunctionResult(
        "getUserAccountData",
        result.returnData,
      );

      if (isNotWorthWatching(totalDebtBase, healthFactor)) {
        hotAddresses.delete(address);
        tierChanges.push({ address, tier: "cold", status: "dormant", healthFactor: null, block: blockNumber });
        continue;
      }

      if (healthFactor >= hfHotThresholdWei) {
        hotAddresses.delete(address);
        coldAddresses.add(address);
        coldHealthFactors.set(address, healthFactor);
        tierChanges.push({ address, tier: "cold", status: "active", healthFactor, block: blockNumber });
      }

      const severity = classifyAlertSeverity(healthFactor);
      if (severity) {
        console.warn(
          `[ALERT:${severity.toUpperCase()}] address=${address} healthFactor=${formatUnits(healthFactor, 18)} block=${blockNumber}`,
        );
        atRiskAddresses.add(address);

        // Only look up the collateral/debt pair (an RPC-heavy call) when a new episode is
        // opening — an already-open episode keeps the pair it started with.
        const isNewEpisode = !hasActiveAlertEpisode(address);
        const assetPair = isNewEpisode ? await lookupAssetPairWithRetry(address) : null;

        recordAlertTick(address, blockNumber, healthFactor, severity, assetPair);
      }

      // totalDebtBase is 8-decimal USD (Aave's base currency unit on Base).
      const debtUsd = Number(totalDebtBase) / 1e8;
      if (healthFactor < HEALTH_FACTOR_LIQUIDATION_THRESHOLD && debtUsd >= config.minOpportunityDebtUsd) {
        try {
          await handleLiquidationOpportunity(address, blockNumber, healthFactor);
        } catch (err) {
          console.error(`Failed to process liquidation opportunity for ${address}:`, err);
        }
      }
    }

    if (tierChanges.length > 0) setBorrowerStates(tierChanges);
  }

  resolveRecoveredEpisodes(atRiskAddresses, blockNumber);
}

/**
 * Reads getUserAccountData for a batch of cold borrowers through the FREE discovery RPC. Has its
 * own light retry and spacing rather than sharing the primary RPC's rate-limit gate, so a slow
 * sweep can never delay the fast hot-path polling.
 */
async function fetchColdBatch(addresses: string[]): Promise<Call3Result[]> {
  const calls = addresses.map((address) => ({
    target: config.aavePoolAddress,
    allowFailure: true,
    callData: pool.interface.encodeFunctionData("getUserAccountData", [address]),
  }));

  for (let attempt = 0; ; attempt++) {
    await sleep(config.discoveryMinIntervalMs);
    try {
      return await discoveryMulticall.aggregate3.staticCall(calls);
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(isRateLimitError(err) ? 2000 * (attempt + 1) : 1000);
    }
  }
}

/**
 * Reads getUserAccountData for a batch of HOT borrowers. Goes through the free discovery RPC
 * first — a few requests every 30 seconds is nothing for it, and it keeps the metered key's quota
 * for what only it can do — and falls back to the primary RPC if the free endpoint keeps
 * failing, so a public-endpoint outage never blinds the watcher.
 */
async function fetchHotBatch(addresses: string[]): Promise<Call3Result[]> {
  if (!config.hotPollOnPrimary) {
    try {
      return await fetchColdBatch(addresses);
    } catch (err) {
      console.warn(`Free RPC failed for hot poll (${extractErrorMessage(err)}); falling back to primary RPC.`);
    }
  }
  return fetchAccountDataBatch(addresses);
}

let coldSweepInFlight = false;

/**
 * Re-checks every cold borrower on the free discovery RPC: promotes anyone whose health factor
 * has fallen below config.hfHotThreshold to the hot list (so the fast path picks them up next
 * tick) and retires anyone who no longer has debt. Silent unless something changed. A batch that
 * fails is skipped and simply retried on the next sweep.
 */
async function sweepColdAddresses(): Promise<void> {
  if (coldSweepInFlight || coldAddresses.size === 0) return;
  coldSweepInFlight = true;
  try {
    const blockNumber = await discoveryProvider.getBlockNumber();
    const coldBefore = coldAddresses.size;
    const sweepNumber = coldSweepCounter++;
    const addresses = Array.from(coldAddresses).filter((a) => isColdBorrowerDue(coldHealthFactors.get(a), sweepNumber));
    let promoted = 0;
    let retired = 0;

    for (let start = 0; start < addresses.length; start += config.multicallBatchSize) {
      const batch = addresses.slice(start, start + config.multicallBatchSize);
      let results: Call3Result[];
      try {
        results = await fetchColdBatch(batch);
      } catch (err) {
        console.error(`Cold sweep batch at index ${start} failed (will retry next sweep): ${extractErrorMessage(err)}`);
        continue;
      }

      const changes: Parameters<typeof setBorrowerStates>[0] = [];
      const observed: { address: string; healthFactor: bigint; block: number }[] = [];
      for (let i = 0; i < results.length; i++) {
        if (!results[i].success) continue;
        const address = batch[i];
        const [, totalDebtBase, , , , healthFactor] = pool.interface.decodeFunctionResult(
          "getUserAccountData",
          results[i].returnData,
        );

        if (isNotWorthWatching(totalDebtBase, healthFactor)) {
          coldAddresses.delete(address);
          coldHealthFactors.delete(address);
          retired++;
          changes.push({ address, tier: "cold", status: "dormant", healthFactor: null, block: blockNumber });
        } else if (healthFactor < hfHotThresholdWei) {
          coldAddresses.delete(address);
          coldHealthFactors.delete(address);
          hotAddresses.add(address);
          promoted++;
          changes.push({ address, tier: "hot", status: "active", healthFactor, block: blockNumber });
        } else {
          coldHealthFactors.set(address, healthFactor);
          observed.push({ address, healthFactor, block: blockNumber });
        }
      }
      if (changes.length > 0) setBorrowerStates(changes);
      if (observed.length > 0) recordHealthFactorsBulk(observed);
    }

    console.log(
      `Cold sweep #${sweepNumber}: checked ${addresses.length} of ${coldBefore} cold borrower(s) at block ${blockNumber}: ` +
        `${promoted} promoted to hot, ${retired} retired (no debt or dust). Now ${hotAddresses.size} hot / ${coldAddresses.size} cold.`,
    );
  } finally {
    coldSweepInFlight = false;
  }
}

/** One watcher cycle: pick up any new borrowers/liquidations, then poll the hot borrowers' health factors. */
async function tick(): Promise<void> {
  const blockNumber = await provider.getBlockNumber();
  await scanForNewAddresses(blockNumber);
  await pollHealthFactors(blockNumber);
}

/**
 * Starts the health factor watcher: restores and catches up its borrower list, runs one immediate tick, then
 * ticks every config.hfPollIntervalMs — plus the liquidation outcome tracker (follows up on
 * opportunities this watcher logs) and the historical simulation worker (replays liquidations
 * seen on-chain after the fact). Returns a function that stops all of them.
 *
 * A tick can now take much longer than before it simulated opportunities (a full Anvil fork
 * spin-up), so an in-flight guard skips starting a new tick if the previous one is still
 * running, rather than letting them pile up via setInterval's fixed cadence.
 */
export async function startHealthFactorWatcher(): Promise<() => void> {
  await initializeBorrowerTracking();
  await tick();

  // The cold sweep is best-effort background work on a free endpoint; a failure just means the
  // next sweep (or the hot path) catches up.
  const runColdSweep = () => sweepColdAddresses().catch((err) => console.error("Cold sweep failed:", extractErrorMessage(err)));
  void runColdSweep();
  const coldSweepInterval = setInterval(runColdSweep, config.coldSweepIntervalMs);

  let tickInFlight = false;
  const interval = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    tick()
      .catch((err) => console.error("Watcher tick failed:", err))
      .finally(() => {
        tickInFlight = false;
      });
  }, config.hfPollIntervalMs);

  const stopOutcomeTracker = startLiquidationOutcomeTracker();
  const stopHistoricalSimWorker = startHistoricalSimWorker();

  return () => {
    clearInterval(interval);
    clearInterval(coldSweepInterval);
    stopOutcomeTracker();
    stopHistoricalSimWorker();
  };
}

// Entry point when run directly (e.g. `npm run watch:hf`), as opposed to imported elsewhere.
if (require.main === module) {
  startHealthFactorWatcher()
    .then((stop) => {
      // SIGINT (Ctrl-C in a terminal) and SIGTERM (docker stop's default signal) both need to
      // trigger the same clean shutdown, or a container just gets hard-killed after its grace
      // period instead of stopping the poll interval and outcome tracker properly.
      const shutdown = () => {
        stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("Failed to start health factor watcher:", err);
      process.exit(1);
    });
}
