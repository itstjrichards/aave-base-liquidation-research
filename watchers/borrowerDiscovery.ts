import { Contract, EventLog, JsonRpcProvider, type ContractEventName } from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import { getStateNumber, setStateNumber, upsertBorrowersBulk } from "../storage/borrowersDb";
import { extractErrorMessage, isRateLimitError, mapWithConcurrency, parseSuggestedRangeWidth, sleep } from "./rpcHelpers";

// A second RPC connection, separate from the primary (metered) one in the watcher. Everything
// heavy and historical goes through here so the primary key's quota is only spent on the live tail.
export const discoveryProvider = new JsonRpcProvider(config.discoveryRpcUrl, config.chainId);
const discoveryPool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, discoveryProvider);

// Filter matching only Borrow events (an address can only owe money after a Borrow, so this is
// all that's needed to find every borrower).
const BORROW_FILTER: ContractEventName = [[discoveryPool.interface.getEvent("Borrow")!.topicHash]];

// Adopted at runtime if the discovery RPC turns out to allow narrower ranges than configured.
let chunkBlocks = config.discoveryLogChunkBlocks;

let nextSlotAt = 0;

/** Waits for this caller's turn so requests to the discovery RPC stay at least discoveryMinIntervalMs apart. */
async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + config.discoveryMinIntervalMs;
  if (slot > now) await sleep(slot - now);
}

/**
 * Fetches logs matching `filter` over [start, end] from the discovery RPC. Retries rate limits
 * with growing backoff, and if the endpoint says the range is too wide, narrows the chunk size
 * (for all future chunks too) and re-splits this range. Throws only after repeated failure —
 * callers treat that as "try again later", never as "skip this range".
 */
async function fetchLogsWithRetry(filter: ContractEventName, start: number, end: number): Promise<EventLog[]> {
  let backoffMs = 1000;
  for (let attempt = 0; attempt < 10; attempt++) {
    await waitForSlot();
    try {
      const logs = await discoveryPool.queryFilter(filter, start, end);
      return logs.filter((log): log is EventLog => log instanceof EventLog);
    } catch (err) {
      const suggested = parseSuggestedRangeWidth(extractErrorMessage(err));
      if (suggested && suggested < end - start + 1) {
        chunkBlocks = Math.min(chunkBlocks, suggested);
        const results: EventLog[] = [];
        for (let s = start; s <= end; s += suggested) {
          results.push(...(await fetchLogsWithRetry(filter, s, Math.min(s + suggested - 1, end))));
        }
        return results;
      }
      if (attempt === 9) throw err;
      await sleep(isRateLimitError(err) ? backoffMs : 500 * (attempt + 1));
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  }
  throw new Error("unreachable");
}

/**
 * Scans [fromBlock, toBlock] on the discovery RPC in chunk-sized pieces, several at a time, and
 * hands each batch of chunks' logs (in block order) to `onLogs`. `onProgress` is called after
 * each batch with the highest block now fully covered, so callers can persist resumable progress.
 * If any chunk fails after its retries, the whole call throws having reported progress only up
 * to the last fully completed batch.
 */
export async function scanRangeOnDiscoveryRpc(
  filter: ContractEventName,
  fromBlock: number,
  toBlock: number,
  onLogs: (logs: EventLog[]) => void,
  onProgress?: (coveredUpTo: number) => void,
): Promise<void> {
  const batchBlocks = chunkBlocks * config.discoveryConcurrency;
  for (let batchStart = fromBlock; batchStart <= toBlock; batchStart += batchBlocks) {
    const batchEnd = Math.min(batchStart + batchBlocks - 1, toBlock);

    const chunks: Array<[number, number]> = [];
    for (let s = batchStart; s <= batchEnd; s += chunkBlocks) {
      chunks.push([s, Math.min(s + chunkBlocks - 1, batchEnd)]);
    }

    const perChunk = await mapWithConcurrency(chunks, config.discoveryConcurrency, ([s, e]) =>
      fetchLogsWithRetry(filter, s, e),
    );
    onLogs(perChunk.flat());
    onProgress?.(batchEnd);
  }
}

// kv_state keys tracking the one-off deep history scan. Ascending: it covers [start, end] where
// `end` is fixed to the head block at the first run (blocks after that are the live/catch-up
// scan's job) and `next` is the first block not yet covered.
const DEEP_NEXT_KEY = "deep_backfill_next_block";
const DEEP_END_KEY = "deep_backfill_end_block";

/**
 * One-off, resumable scan of Borrow events over the last config.discoveryLookbackBlocks blocks,
 * recording every borrower found in the persistent borrowers table as 'cold' (the first cold
 * sweep decides who's actually close to liquidation). Progress is saved after every batch, so a
 * restart continues where it stopped, and once finished this does nothing on later runs.
 * `onNewBorrowers` lets the caller add newly discovered addresses to its in-memory sets.
 */
export async function runDeepBorrowerBackfill(
  headBlock: number,
  onNewBorrowers: (addresses: string[]) => void,
): Promise<void> {
  let end = getStateNumber(DEEP_END_KEY);
  let next = getStateNumber(DEEP_NEXT_KEY);
  if (end === null || next === null) {
    end = headBlock;
    next = Math.max(0, headBlock - config.discoveryLookbackBlocks);
    setStateNumber(DEEP_END_KEY, end);
    setStateNumber(DEEP_NEXT_KEY, next);
    console.log(
      `Deep borrower backfill starting: Borrow events from block ${next} to ${end} ` +
        `(~${Math.round((end - next) / 43200)} days) via ${config.discoveryRpcUrl}`,
    );
  } else if (next > end) {
    return; // Already finished in an earlier run.
  } else {
    console.log(`Deep borrower backfill resuming from block ${next} (target ${end}).`);
  }

  const startedAt = Date.now();
  const startBlock = next;
  const totalBlocks = end - next + 1;
  let foundNew = 0;
  let lastLoggedPct = -1;

  await scanRangeOnDiscoveryRpc(
    BORROW_FILTER,
    next,
    end,
    (logs) => {
      const events = logs.map((log) => ({ address: log.args.onBehalfOf as string, blockNumber: log.blockNumber }));
      const { newAddresses } = upsertBorrowersBulk(events, "cold");
      foundNew += newAddresses.length;
      if (newAddresses.length > 0) onNewBorrowers(newAddresses);
    },
    (coveredUpTo) => {
      setStateNumber(DEEP_NEXT_KEY, coveredUpTo + 1);
      const pct = Math.floor(((coveredUpTo - startBlock + 1) / totalBlocks) * 100);
      if (pct >= lastLoggedPct + 10) {
        lastLoggedPct = pct - (pct % 10);
        console.log(`Deep borrower backfill ${pct}% (${foundNew} new borrowers so far).`);
      }
    },
  );

  console.log(
    `Deep borrower backfill complete: ${foundNew} borrowers found in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
  );
}

/**
 * Runs the deep backfill to completion, retrying after a pause if it fails (network blip, the
 * public endpoint having a bad minute). Resumes from saved progress each attempt. Intended to be
 * started in the background at startup and never awaited by the watcher's main flow.
 */
export async function runDeepBorrowerBackfillWithRetry(
  headBlock: number,
  onNewBorrowers: (addresses: string[]) => void,
): Promise<void> {
  for (;;) {
    try {
      await runDeepBorrowerBackfill(headBlock, onNewBorrowers);
      return;
    } catch (err) {
      console.error("Deep borrower backfill failed; will resume from saved progress in 60s:", extractErrorMessage(err));
      await sleep(60_000);
    }
  }
}
