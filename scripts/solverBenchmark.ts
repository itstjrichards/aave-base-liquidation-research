// RUN THIS INSIDE THE CONTAINER, not on the host: `docker compose exec watcher node dist/scripts/solverBenchmark.js`.
// Opening the live WAL databases from the host while the container runs can corrupt them (see snapshotDbs.ts).
import Database from "better-sqlite3";
import { Contract, JsonRpcProvider, id } from "ethers";
import { config } from "../config/config";
import { AAVE_ORACLE_ABI, AAVE_ORACLE_ADDRESS } from "../config/aaveOracleAbi";
import { ERC20_ABI, WETH_ADDRESS } from "../config/uniswapAbi";

// Benchmarks our replay (the simulated liquidation flow in simulation/liquidationSim.ts) against
// what the REAL liquidators actually extracted on the same liquidations. For each observed live
// liquidation it computes three numbers, all in USD at the Aave oracle prices of the liquidation
// block:
//   bonus    the theoretical ceiling: collateral seized minus debt repaid (the liquidation bonus).
//            Nothing can extract more than this before gas.
//   real     what the real bot actually realised: the net change in the liquidator's token
//            balances over the transaction (before it paid any auction bid or gas). Swap slippage
//            and routing quality are what separate this from `bonus`.
//   ours     our replay's gross profit (swap proceeds minus debt repaid, before flash-loan fee and gas).
// The comparison of `real/bonus` against `ours/bonus` is the routing/execution gap a purpose-built
// solver would have to close. Real gas is reported including the OP-stack L1 data fee, which the
// replay's own gas figure does not model.

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

interface Row {
  id: number;
  tx_hash: string;
  block_number: number;
  liquidator_address: string;
  collateral_asset: string;
  debt_asset: string;
  debt_to_cover_raw: string;
  collateral_seized_raw: string;
  sim_status: string;
  sim_gross_profit_usd: number | null;
  sim_net_profit_usd: number | null;
  sim_gas_cost_usd: number | null;
}

/** One liquidation's benchmark line. */
interface Result {
  id: number;
  block: number;
  kind: string;
  debtUsd: number;
  bonusUsd: number;
  realProfitUsd: number | null;
  realGasUsd: number;
  realL1FeeUsd: number;
  oursGrossUsd: number | null;
  oursGasUsd: number | null;
  unpricedTokens: number;
}

const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
const oracle = new Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

// Lookups repeat heavily across liquidations (same handful of tokens), so cache them.
const decimalsCache = new Map<string, number>();
const priceCache = new Map<string, number | null>();

/** A token's decimals, cached. */
async function getDecimals(token: string): Promise<number> {
  const key = token.toLowerCase();
  if (!decimalsCache.has(key)) {
    for (let attempt = 0; ; attempt++) {
      try {
        decimalsCache.set(key, Number(await new Contract(token, ERC20_ABI, provider).decimals()));
        break;
      } catch (err) {
        if (attempt >= 6) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  return decimalsCache.get(key)!;
}

/**
 * USD price of one whole token per the Aave oracle at `blockNumber`, or null if the oracle has no
 * price for it (e.g. an aToken or a token Aave doesn't list — such tokens can't be valued, so
 * they're counted and reported instead of silently treated as worthless).
 */
async function getPriceUsd(token: string, blockNumber: number): Promise<number | null> {
  const key = `${token.toLowerCase()}@${blockNumber}`;
  if (!priceCache.has(key)) {
    // Only a genuine revert means "the oracle has no price for this token". Anything else (a rate
    // limit, a dropped connection) is transient and must be retried — caching it as "unpriced"
    // would silently value a real position at zero.
    for (let attempt = 0; ; attempt++) {
      try {
        const raw: bigint = await oracle.getAssetPrice(token, { blockTag: blockNumber });
        priceCache.set(key, raw === 0n ? null : Number(raw) / 1e8);
        break;
      } catch (err) {
        if ((err as { code?: string }).code === "CALL_EXCEPTION") {
          priceCache.set(key, null);
          break;
        }
        if (attempt >= 6) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  return priceCache.get(key)!;
}

/** Minimal shape of the raw JSON-RPC receipt fields this script reads (OP-stack adds l1Fee). */
interface RawReceipt {
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  l1Fee?: string;
  logs: { address: string; topics: string[]; data: string }[];
}

/** Human-readable label for who sent the transaction, from what it was sent to. */
function classifyBot(receipt: RawReceipt, liquidator: string): string {
  const to = (receipt.to ?? "").toLowerCase();
  if (to === config.aavePoolAddress.toLowerCase()) return "wallet->Pool";
  if (to === "0x583dcfef0d240dc80753f0f0b26513fee27d9b77") return "Atlas solver";
  return to === liquidator.toLowerCase() ? "own contract" : "other";
}

/**
 * Net USD change in the liquidator's ERC20 holdings across one transaction, from its Transfer
 * logs, valued at the liquidation block's oracle prices. Native ETH moves (such as an auction bid
 * or WETH unwrapping) don't appear in logs, which is what we want: the result is the value the bot
 * had in hand BEFORE paying any bid. Returns the value plus how many tokens couldn't be priced.
 */
async function realizedProfitUsd(
  receipt: RawReceipt,
  liquidator: string,
  blockNumber: number,
): Promise<{ usd: number; unpriced: number }> {
  const me = liquidator.toLowerCase();
  const deltas = new Map<string, bigint>();

  for (const log of receipt.logs) {
    // ERC20 Transfers have 3 topics (signature, from, to); ERC721 Transfers have 4 — skip those.
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const from = "0x" + log.topics[1].slice(26).toLowerCase();
    const to = "0x" + log.topics[2].slice(26).toLowerCase();
    const amount = BigInt(log.data);
    const token = log.address.toLowerCase();
    if (to === me) deltas.set(token, (deltas.get(token) ?? 0n) + amount);
    if (from === me) deltas.set(token, (deltas.get(token) ?? 0n) - amount);
  }

  let usd = 0;
  let unpriced = 0;
  for (const [token, delta] of deltas) {
    if (delta === 0n) continue;
    const price = await getPriceUsd(token, blockNumber);
    if (price === null) {
      unpriced++;
      continue;
    }
    usd += (Number(delta) / 10 ** (await getDecimals(token))) * price;
  }
  return { usd, unpriced };
}

/** Benchmarks one liquidation row against its real on-chain transaction. */
async function benchmarkRow(row: Row): Promise<Result> {
  const raw: RawReceipt = await provider.send("eth_getTransactionReceipt", [row.tx_hash]);
  const [collDecimals, debtDecimals, collPrice, debtPrice, ethPrice] = await Promise.all([
    getDecimals(row.collateral_asset),
    getDecimals(row.debt_asset),
    getPriceUsd(row.collateral_asset, row.block_number),
    getPriceUsd(row.debt_asset, row.block_number),
    getPriceUsd(WETH_ADDRESS, row.block_number),
  ]);

  const seizedUsd = (Number(BigInt(row.collateral_seized_raw)) / 10 ** collDecimals) * (collPrice ?? 0);
  const debtUsd = (Number(BigInt(row.debt_to_cover_raw)) / 10 ** debtDecimals) * (debtPrice ?? 0);

  const real = await realizedProfitUsd(raw, row.liquidator_address, row.block_number);
  const l2GasUsd = ((Number(BigInt(raw.gasUsed)) * Number(BigInt(raw.effectiveGasPrice))) / 1e18) * (ethPrice ?? 0);
  const l1FeeUsd = (Number(BigInt(raw.l1Fee ?? "0x0")) / 1e18) * (ethPrice ?? 0);

  return {
    id: row.id,
    block: row.block_number,
    kind: classifyBot(raw, row.liquidator_address),
    debtUsd,
    bonusUsd: seizedUsd - debtUsd,
    realProfitUsd: real.usd,
    realGasUsd: l2GasUsd,
    realL1FeeUsd: l1FeeUsd,
    oursGrossUsd: row.sim_status === "done" ? row.sim_gross_profit_usd : null,
    oursGasUsd: row.sim_status === "done" ? row.sim_gas_cost_usd : null,
    unpricedTokens: real.unpriced,
  };
}

/** Median of a non-empty array. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Formats a USD value with adaptive precision so cents-sized profits stay readable. */
function usd(value: number | null): string {
  if (value === null) return "n/a";
  const abs = Math.abs(value);
  return `$${abs >= 100 ? value.toFixed(0) : abs >= 0.01 ? value.toFixed(2) : value.toFixed(5)}`;
}

/** Formats a ratio as a percentage, or n/a when there's no meaningful denominator. */
function pct(numerator: number | null, denominator: number): string {
  if (numerator === null || denominator <= 0.01) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(0)}%`;
}

/** Prints the per-liquidation table and the aggregate scoreboard. */
async function main(): Promise<void> {
  const minDebtUsd = Number(process.env.MIN_DEBT_USD ?? "100");
  const db = new Database(config.dbPath, { fileMustExist: true });
  const rows = db
    .prepare(`SELECT * FROM observed_liquidations WHERE during_backfill = 0 ORDER BY block_number, id`)
    .all() as Row[];

  const results: Result[] = [];
  for (const row of rows) {
    try {
      results.push(await benchmarkRow(row));
    } catch (err) {
      console.error(`#${row.id}: benchmark failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  const sized = results.filter((r) => r.debtUsd >= minDebtUsd);
  console.log(`\nLiquidations with debt repaid >= $${minDebtUsd}: ${sized.length} of ${results.length}`);
  console.log(`${"id".padEnd(4)} ${"block".padEnd(9)} ${"who".padEnd(13)} ${"debt".padStart(7)} ${"bonus".padStart(7)} ${"real".padStart(7)} ${"real/b".padStart(6)} ${"ours".padStart(7)} ${"ours/b".padStart(6)} ${"ours-real".padStart(9)} ${"real gas L2+L1".padStart(17)} ${"ours gas".padStart(8)}`);
  for (const r of sized) {
    console.log(
      `${String(r.id).padEnd(4)} ${String(r.block).padEnd(9)} ${r.kind.padEnd(13)} ${usd(r.debtUsd).padStart(7)} ${usd(r.bonusUsd).padStart(7)} ` +
        `${usd(r.realProfitUsd).padStart(7)} ${pct(r.realProfitUsd, r.bonusUsd).padStart(6)} ${usd(r.oursGrossUsd).padStart(7)} ${pct(r.oursGrossUsd, r.bonusUsd).padStart(6)} ` +
        `${(r.oursGrossUsd !== null && r.realProfitUsd ? ((r.oursGrossUsd - r.realProfitUsd) / r.realProfitUsd * 100).toFixed(1) + "%" : "n/a").padStart(9)} ` +
        `${(usd(r.realGasUsd) + "+" + usd(r.realL1FeeUsd)).padStart(17)} ${usd(r.oursGasUsd).padStart(8)}` +
        `${r.unpricedTokens > 0 ? `  (${r.unpricedTokens} unpriced tokens)` : ""}`,
    );
  }

  const both = sized.filter((r) => r.realProfitUsd !== null && r.oursGrossUsd !== null);
  if (both.length === 0) return;
  const sum = (f: (r: Result) => number) => both.reduce((a, r) => a + f(r), 0);
  const totalBonus = sum((r) => r.bonusUsd);
  console.log(`\n--- Scoreboard over ${both.length} liquidations with both a real result and a completed replay ---`);
  console.log(`Theoretical bonus total:            ${usd(totalBonus)}`);
  console.log(`Real bots realised (before bids):   ${usd(sum((r) => r.realProfitUsd!))}  (${pct(sum((r) => r.realProfitUsd!), totalBonus)} of bonus)`);
  console.log(`Our replay gross:                   ${usd(sum((r) => r.oursGrossUsd!))}  (${pct(sum((r) => r.oursGrossUsd!), totalBonus)} of bonus)`);
  console.log(`Median capture of bonus:            real ${(median(both.map((r) => r.realProfitUsd! / r.bonusUsd)) * 100).toFixed(0)}%  ours ${(median(both.map((r) => r.oursGrossUsd! / r.bonusUsd)) * 100).toFixed(0)}%`);
  const errors = both.filter((r) => r.realProfitUsd! > 0).map((r) => (r.oursGrossUsd! - r.realProfitUsd!) / r.realProfitUsd!);
  console.log(
    `Our gross vs real realised profit:   median abs error ${(median(errors.map(Math.abs)) * 100).toFixed(1)}%, ` +
      `worst ${(Math.max(...errors.map(Math.abs)) * 100).toFixed(1)}%, ` +
      `ours higher in ${errors.filter((e) => e > 0).length}/${errors.length}`,
  );
  console.log(`Real gas (L2 + L1 data fee) total:  ${usd(sum((r) => r.realGasUsd))} + ${usd(sum((r) => r.realL1FeeUsd))}`);
  console.log(`Our replay's gas total:             ${usd(sum((r) => r.oursGasUsd ?? 0))}  (no L1 data fee modelled)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
