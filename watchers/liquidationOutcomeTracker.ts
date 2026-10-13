import { Contract, EventLog, JsonRpcProvider } from "ethers";
import { config } from "../config/config";
import { AAVE_POOL_ABI } from "../config/aavePoolAbi";
import {
  getPendingOpportunities,
  markOpportunityExpired,
  markOpportunityLiquidated,
  type OpportunityRow,
} from "../storage/db";

const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
const pool = new Contract(config.aavePoolAddress, AAVE_POOL_ABI, provider);

/**
 * Fetches LiquidationCall events for any of `addresses` over [fromBlock, toBlock], chunked to
 * respect a provider's eth_getLogs range cap. Filters directly on the event's indexed `user`
 * topic (an OR match across all of `addresses` in one query) rather than fetching every
 * liquidation and filtering client-side.
 */
async function fetchLiquidationLogs(fromBlock: number, toBlock: number, addresses: string[]): Promise<EventLog[]> {
  const logs: EventLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += config.liquidationCheckChunkBlocks) {
    const end = Math.min(start + config.liquidationCheckChunkBlocks - 1, toBlock);
    const chunkLogs = await pool.queryFilter(pool.filters.LiquidationCall(null, null, addresses), start, end);
    logs.push(...chunkLogs.filter((log): log is EventLog => log instanceof EventLog));
  }
  return logs;
}

/**
 * For every pending opportunity old enough to check (detected at least
 * config.liquidationCheckDelayBlocks blocks ago), looks for a real LiquidationCall event
 * against that borrower. Records the block it happened at if found; gives up (marks expired)
 * once config.liquidationCheckMaxBlocks has passed with no such event.
 */
async function checkPendingOpportunities(): Promise<void> {
  const pending = getPendingOpportunities();
  if (pending.length === 0) return;

  const currentBlock = await provider.getBlockNumber();
  const dueForCheck = pending.filter(
    (opportunity) => currentBlock >= opportunity.block_number + config.liquidationCheckDelayBlocks,
  );
  if (dueForCheck.length === 0) return;

  const fromBlock = Math.min(...dueForCheck.map((opportunity) => opportunity.block_number));
  const addresses = dueForCheck.map((opportunity) => opportunity.borrower_address);

  let logs: EventLog[];
  try {
    logs = await fetchLiquidationLogs(fromBlock, currentBlock, addresses);
  } catch (err) {
    console.error("Failed to fetch LiquidationCall logs for outcome check:", err);
    return; // Safe to just retry on the next tick — nothing here is destructive.
  }

  const earliestLiquidationBlockByAddress = new Map<string, number>();
  for (const log of logs) {
    const address = (log.args.user as string).toLowerCase();
    const existing = earliestLiquidationBlockByAddress.get(address);
    if (existing === undefined || log.blockNumber < existing) {
      earliestLiquidationBlockByAddress.set(address, log.blockNumber);
    }
  }

  for (const opportunity of dueForCheck) {
    resolveOpportunity(opportunity, currentBlock, earliestLiquidationBlockByAddress);
  }
}

/** Marks one opportunity liquidated (if found) or expired (if its check window has passed). */
function resolveOpportunity(
  opportunity: OpportunityRow,
  currentBlock: number,
  earliestLiquidationBlockByAddress: Map<string, number>,
): void {
  const liquidatedBlock = earliestLiquidationBlockByAddress.get(opportunity.borrower_address.toLowerCase());
  if (liquidatedBlock !== undefined) {
    markOpportunityLiquidated(opportunity.id, liquidatedBlock);
    console.log(
      `Opportunity #${opportunity.id} (${opportunity.borrower_address}) was liquidated at block ${liquidatedBlock}.`,
    );
    return;
  }

  if (currentBlock >= opportunity.block_number + config.liquidationCheckMaxBlocks) {
    markOpportunityExpired(opportunity.id);
    console.log(
      `Opportunity #${opportunity.id} (${opportunity.borrower_address}) expired: no liquidation seen within ` +
        `${config.liquidationCheckMaxBlocks} blocks of detection.`,
    );
  }
}

/**
 * Starts the outcome tracker: checks pending opportunities every
 * config.liquidationOutcomeCheckIntervalMs. Returns a function that stops it.
 */
export function startLiquidationOutcomeTracker(): () => void {
  const interval = setInterval(() => {
    checkPendingOpportunities().catch((err) => console.error("Liquidation outcome check failed:", err));
  }, config.liquidationOutcomeCheckIntervalMs);

  return () => clearInterval(interval);
}

// Entry point when run directly, independent of the health factor watcher.
if (require.main === module) {
  const stop = startLiquidationOutcomeTracker();
  const shutdown = () => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
