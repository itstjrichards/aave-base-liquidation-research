import "dotenv/config";

/** Reads a required env var, throwing immediately at startup if it's missing or empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Reads an optional env var, returning `fallback` if it isn't set. */
function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  rpcUrl: requireEnv("RPC_URL"),
  chainId: Number(requireEnv("CHAIN_ID")),

  // Aave V3 Pool (proxy) on Base. Verified on-chain against
  // PoolAddressesProvider.getPool() at 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D.
  aavePoolAddress: optionalEnv("AAVE_POOL_ADDRESS", "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),

  // Health factor watcher tuning.
  hfPollIntervalMs: Number(optionalEnv("HF_POLL_INTERVAL_MS", "30000")),
  // Three alert severity tiers instead of one flat threshold, so an episode's console/DB
  // record reflects how close a position actually is, not just "below/above one line". Must
  // be ordered hfCriticalThreshold < hfWarningThreshold < hfWatchThreshold — validated at
  // startup in healthFactorWatcher.ts since a misconfigured ordering would silently misclassify
  // severity. hfWatchThreshold is the overall gate: anything at or above it isn't alerted on.
  hfWatchThreshold: optionalEnv("HF_WATCH_THRESHOLD", "1.10"),
  hfWarningThreshold: optionalEnv("HF_WARNING_THRESHOLD", "1.05"),
  hfCriticalThreshold: optionalEnv("HF_CRITICAL_THRESHOLD", "1.02"),
  // ~2.8 hours at Base's ~2s block time. Some RPC providers (e.g. Alchemy's free tier)
  // cap eth_getLogs to a 10-block range, which the watcher auto-detects — a large lookback
  // on a tightly-capped provider means many chunked requests, so this default stays modest.
  eventLookbackBlocks: Number(optionalEnv("EVENT_LOOKBACK_BLOCKS", "5000")),
  // Preferred eth_getLogs chunk width; auto-reduced at runtime if the provider rejects it.
  logChunkBlocks: Number(optionalEnv("LOG_CHUNK_BLOCKS", "2000")),
  logFetchConcurrency: Number(optionalEnv("LOG_FETCH_CONCURRENCY", "6")),
  // Minimum spacing enforced between RPC calls, regardless of concurrency, to stay under
  // a provider's requests-per-second cap (e.g. Alchemy's free-tier compute-units-per-second
  // limit) instead of bursting and reacting to 429s after the fact.
  rpcMinIntervalMs: Number(optionalEnv("RPC_MIN_INTERVAL_MS", "300")),
  multicallBatchSize: Number(optionalEnv("MULTICALL_BATCH_SIZE", "150")),

  // Borrower discovery. Positions that get liquidated are usually long-lived ones that drift
  // with price, not ones that were just opened, so the watcher needs to know about borrowers
  // from weeks back — far more history than a metered RPC key can reasonably scan. Historical
  // and catch-up log scans therefore go through a separate, free public RPC (discoveryRpcUrl),
  // which allows wide eth_getLogs ranges; only the live tail of the chain uses the primary key.
  discoveryRpcUrl: optionalEnv("DISCOVERY_RPC_URL", "https://mainnet.base.org"),
  // ~1 year at Base's ~2s block time. Free to scan (~40 minutes, once), and liquidated positions
  // are often older than 90 days.
  discoveryLookbackBlocks: Number(optionalEnv("DISCOVERY_LOOKBACK_BLOCKS", "15768000")),
  discoveryLogChunkBlocks: Number(optionalEnv("DISCOVERY_LOG_CHUNK_BLOCKS", "2000")),
  discoveryConcurrency: Number(optionalEnv("DISCOVERY_CONCURRENCY", "3")),
  // Minimum spacing between requests to the discovery RPC, to stay polite to a free endpoint.
  discoveryMinIntervalMs: Number(optionalEnv("DISCOVERY_MIN_INTERVAL_MS", "250")),
  // Persistent record of every borrower found so far (survives restarts, so the deep history
  // scan only ever runs once).
  borrowersDbPath: optionalEnv("BORROWERS_DB_PATH", "data/borrowers.db"),

  // Two-tier polling. With thousands of borrowers known, polling all of them every
  // hfPollIntervalMs through the primary RPC would burn its quota. Only "hot" borrowers (health
  // factor below hfHotThreshold) are polled every tick on the primary RPC; everyone else is
  // "cold" and re-checked every coldSweepIntervalMs through the free discovery RPC, moving to
  // hot as soon as they drift below the threshold.
  hfHotThreshold: optionalEnv("HF_HOT_THRESHOLD", "1.15"),
  // Set HOT_POLL_ON_PRIMARY=true to poll hot borrowers on the primary RPC instead of the free one
  // (lower latency, but costs primary-key quota every tick).
  hotPollOnPrimary: optionalEnv("HOT_POLL_ON_PRIMARY", "false") === "true",
  coldSweepIntervalMs: Number(optionalEnv("COLD_SWEEP_INTERVAL_MS", "180000")),

  // Positions below health factor 1.0 whose total debt is under this many USD are ignored by the
  // opportunity path. A liquidation only nets a few percent of the debt, so a tiny position can
  // never cover gas, yet dust positions like this stay below 1.0 indefinitely (nobody bothers to
  // liquidate them) — without this filter each one would be re-simulated on a fresh Anvil fork
  // every time its previous opportunity expired.
  minOpportunityDebtUsd: Number(optionalEnv("MIN_OPPORTUNITY_DEBT_USD", "10")),

  // Liquidation simulation tuning.
  // Path to the anvil binary; override if it's not on PATH.
  anvilPath: optionalEnv("ANVIL_PATH", "anvil"),
  // Anvil picks a random port in this range per fork to avoid clashing with a port already
  // in use (e.g. a previous fork that hasn't fully exited yet).
  anvilPortRangeStart: Number(optionalEnv("ANVIL_PORT_RANGE_START", "30000")),
  anvilPortRangeEnd: Number(optionalEnv("ANVIL_PORT_RANGE_END", "40000")),
  anvilStartupTimeoutMs: Number(optionalEnv("ANVIL_STARTUP_TIMEOUT_MS", "30000")),
  // Anvil's own outbound requests to config.rpcUrl for lazily-fetched fork state are subject
  // to the same provider rate limits as our own requests (e.g. Alchemy's free tier). Anvil's
  // default assumption (330 compute units/sec) is optimistic for a free-tier key; a lower
  // value plus more generous retries avoids "Max retries exceeded HTTP 429" mid-simulation.
  anvilComputeUnitsPerSecond: Number(optionalEnv("ANVIL_COMPUTE_UNITS_PER_SECOND", "20")),
  anvilForkRetries: Number(optionalEnv("ANVIL_FORK_RETRIES", "15")),
  anvilForkRetryBackoffMs: Number(optionalEnv("ANVIL_FORK_RETRY_BACKOFF_MS", "2000")),
  // Extra headroom applied when acquiring the debt asset up front, so the simulation always
  // holds slightly more than the borrower's on-chain debt balance (interest can accrue by a
  // dust amount between reading that balance and the liquidationCall executing).
  debtAcquisitionBufferBps: Number(optionalEnv("DEBT_ACQUISITION_BUFFER_BPS", "50")),

  // SQLite opportunity log.
  dbPath: optionalEnv("DB_PATH", "data/opportunities.db"),

  // Separate SQLite log for early-warning alerts (health factor below hfWatchThreshold but not
  // yet actually liquidatable) — kept in its own file so the much higher volume of near-miss
  // alerts doesn't clutter the opportunities log.
  alertsDbPath: optionalEnv("ALERTS_DB_PATH", "data/alerts.db"),

  // Liquidation outcome tracker: after logging an opportunity at block N, waits until block
  // N + liquidationCheckDelayBlocks before checking for a real LiquidationCall event (giving
  // the liquidation a chance to actually land first), then keeps checking each tick until
  // either found or liquidationCheckMaxBlocks has passed, at which point it gives up.
  liquidationCheckDelayBlocks: Number(optionalEnv("LIQUIDATION_CHECK_DELAY_BLOCKS", "5")),
  liquidationCheckMaxBlocks: Number(optionalEnv("LIQUIDATION_CHECK_MAX_BLOCKS", "30")),
  liquidationCheckChunkBlocks: Number(optionalEnv("LIQUIDATION_CHECK_CHUNK_BLOCKS", "10")),
  liquidationOutcomeCheckIntervalMs: Number(optionalEnv("LIQUIDATION_OUTCOME_CHECK_INTERVAL_MS", "15000")),

  // Historical simulation of liquidations the watcher only saw after the fact (via the
  // on-chain LiquidationCall event). Each one forks Anvil one block before the real liquidation
  // and replays it, which costs RPC compute units — so simulations run one at a time, at least
  // historicalSimMinIntervalMs apart, and can be switched off entirely.
  historicalSimEnabled: optionalEnv("HISTORICAL_SIM_ENABLED", "true") === "true",
  historicalSimMinIntervalMs: Number(optionalEnv("HISTORICAL_SIM_MIN_INTERVAL_MS", "90000")),
  // A simulation that fails for a transient reason (RPC 429, timeout) is retried this many
  // times in total before being recorded as failed.
  historicalSimMaxAttempts: Number(optionalEnv("HISTORICAL_SIM_MAX_ATTEMPTS", "3")),
};
