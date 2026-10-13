# Aave V3 liquidation research on Base

Read-only tooling that watches Aave V3 on Base, replays real liquidations on a local Anvil fork, and measures how much of the value a competing liquidation bot could actually capture.

**This project never sends a transaction.** It uses read-only RPC access and local Anvil forks. There is no signer, no wallet, and no deployed contract. It was built to answer a question ("is competing realistic?"), not to run a bot.

## What I found

From 38 liquidations observed live on Aave V3 Base over roughly 24 hours (ending 2026-09-21). Small sample, one day; treat the numbers as indicative.

- **One auction takes the money.** 14 of 38 liquidations (including all 7 with at least $1k of debt, about 99% of the dollar value) went through FastLane's Atlas auction. The Chainlink SVR oracle update is bundled into the liquidation transaction itself, so there is no gap between "price moved" and "position liquidatable" for an outside bot to act in.
- **Solvers keep almost nothing.** Three solver contracts handled these. Each bid 96% to 99.97% of its profit to Atlas, keeping cents to a few dollars per win. Flash loans came from Morpho (0 fee) or Balancer, not Aave.
- **Polling faster does not help.** Because the oracle update and the liquidation land together, the contest is won on routing and bid accuracy, not on detection latency.
- **My own early-warning watcher had a discovery gap.** 37 of the 38 liquidated borrowers had no Supply or Borrow event in the ~8 days before liquidation, so a short event lookback can never find them. The watcher's early warnings caught 0 of 38. I changed discovery to persist borrowers and backfill Borrow events over a year of history on a free public RPC (included here), but I moved off Base before measuring how much that closed the gap.

## What it does

| Part | Where | Purpose |
|---|---|---|
| Health-factor watcher | `watchers/healthFactorWatcher.ts` | Tiered polling (hot/cold borrowers), alert episodes, logs positions that become liquidatable |
| Borrower discovery | `watchers/borrowerDiscovery.ts`, `storage/borrowersDb.ts` | Deep Borrow-event backfill on a free RPC, persisted in SQLite |
| Fork simulation | `simulation/liquidationSim.ts`, `simulation/forkManager.ts` | Liquidates on a local Anvil fork, sells the collateral on Uniswap V3, measures gas and proceeds |
| Historical replay | `simulation/historicalLiquidationSim.ts`, `watchers/historicalSimWorker.ts` | Forks one block before a real liquidation, moves oracle prices to their end-of-block values, replays it |
| Price manipulation | `simulation/priceManipulation.ts`, `contracts/mocks/MockPriceFeed.sol` | Replaces a price feed's code on the fork with a trivial mock to set any price |
| Profit math | `pricing/profitCalculator.ts` | Gross/net profit with flash-loan premium and gas |
| Benchmark | `scripts/solverBenchmark.ts` | Compares the replay's profit with what the real liquidator realised |

## Known limitations (read before trusting a number)

- The replay funds itself by swapping on the same pools it later sells collateral into, which moves prices against itself. Replay profit is biased low on large positions.
- The Uniswap disposal step in this version uses the first fee tier that does not revert, not the best one. Slippage figures for thinly traded pairs can be badly overstated. I fixed this later; this snapshot predates the fix.
- Some replays revert with `MustNotLeaveDust()` (`0xb629b0e4`). Interest accrual on the fork differs slightly from the real transaction; I did not find the cause.
- Pairs with no Uniswap V3 pool (for example Aerodrome-only pairs) cannot be routed.
- The 38-liquidation sample is one day on one chain.

## Run it

Requires Node 22, [Foundry](https://getfoundry.sh) (for `anvil`), and a Base RPC endpoint.

```bash
cp .env.example .env     # set RPC_URL (a free public endpoint works for light use)
npm ci
npm run watch:hf         # health-factor watcher
```

Or `docker compose up -d --build` to run it unattended. The SQLite databases are in WAL mode; do not open the live `data/*.db` files from the host while the container is running. Use `npm run snapshot:dbs` and open the copies.

## Disclaimer

Research code, not financial advice, and not audited. Nothing here has been used with real funds.

## License

MIT
