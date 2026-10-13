// RUN THIS INSIDE THE CONTAINER, not on the host: `docker compose exec watcher node dist/scripts/liquidationReport.js`.
// Opening the live WAL databases from the host while the container runs can corrupt them (see snapshotDbs.ts).
import Database from "better-sqlite3";
import { config } from "../config/config";

/** Just the columns the report reads from observed_liquidations. */
interface ReportRow {
  block_number: number;
  during_backfill: number;
  collateral_asset: string;
  debt_asset: string;
  prior_max_severity: string | null;
  warning_lead_blocks: number | null;
  matched_opportunity_id: number | null;
  sim_status: string;
  sim_error: string | null;
  sim_gross_profit_usd: number | null;
  sim_net_profit_usd: number | null;
  sim_debt_repaid_usd: number | null;
}

const BASE_BLOCK_SECONDS = 2;

/** The p-th percentile (0-1) of an already-sorted array, or null if it's empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Formats a USD amount for the report, or "n/a" if there's no value. */
function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(2)}`;
}

/** Shortens an address to 0x1234…abcd so asset pairs fit on one line. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Prints a summary of everything in observed_liquidations: how many liquidations happened, how
 * many the watcher had already warned about (and with how much lead time), and what the
 * historical replays say those liquidations would have paid. Only ever runs SELECTs.
 */
function main(): void {
  const db = new Database(config.dbPath, { fileMustExist: true });
  const rows = db.prepare("SELECT * FROM observed_liquidations ORDER BY block_number").all() as ReportRow[];

  console.log(`\n=== Observed liquidations (${config.dbPath}) ===`);
  console.log(`Total: ${rows.length}  (live: ${rows.filter((r) => !r.during_backfill).length}, from startup backfill: ${rows.filter((r) => r.during_backfill).length})`);
  if (rows.length === 0) {
    console.log("Nothing observed yet.");
    return;
  }

  // Warning stats only count LIVE liquidations: the watcher wasn't running for backfilled ones,
  // so "no prior warning" for those would just mean "we weren't there".
  const live = rows.filter((r) => !r.during_backfill);
  const warned = live.filter((r) => r.prior_max_severity !== null);
  console.log(`\n--- Early warning (live liquidations only) ---`);
  console.log(`Warned before liquidation: ${warned.length}/${live.length}`);
  for (const severity of ["critical", "warning", "watch"]) {
    console.log(`  max severity ${severity}: ${warned.filter((r) => r.prior_max_severity === severity).length}`);
  }
  const leads = warned.map((r) => r.warning_lead_blocks!).sort((a, b) => a - b);
  if (leads.length > 0) {
    console.log(
      `Lead time: median ${percentile(leads, 0.5)} blocks (~${(percentile(leads, 0.5)! * BASE_BLOCK_SECONDS / 60).toFixed(1)} min), ` +
        `min ${leads[0]}, max ${leads[leads.length - 1]}`,
    );
  }
  console.log(`Also caught live as an opportunity (HF<1 seen before liquidation): ${live.filter((r) => r.matched_opportunity_id !== null).length}`);

  console.log(`\n--- Historical simulation ---`);
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.sim_status, (byStatus.get(r.sim_status) ?? 0) + 1);
  console.log([...byStatus].map(([status, n]) => `${status}=${n}`).join("  "));

  const done = rows.filter((r) => r.sim_status === "done");
  if (done.length > 0) {
    const nets = done.map((r) => r.sim_net_profit_usd!).sort((a, b) => a - b);
    const profitable = done.filter((r) => r.sim_net_profit_usd! > 0);
    console.log(`Profitable after fees+gas: ${profitable.length}/${done.length}`);
    console.log(`Net profit  median ${usd(percentile(nets, 0.5))}  p90 ${usd(percentile(nets, 0.9))}  max ${usd(nets[nets.length - 1])}  total ${usd(nets.reduce((a, b) => a + b, 0))}`);
    console.log(`Debt repaid total ${usd(done.reduce((a, r) => a + r.sim_debt_repaid_usd!, 0))}`);

    console.log(`\nBest replays:`);
    for (const r of [...done].sort((a, b) => b.sim_net_profit_usd! - a.sim_net_profit_usd!).slice(0, 5)) {
      console.log(
        `  block ${r.block_number}  net ${usd(r.sim_net_profit_usd)}  gross ${usd(r.sim_gross_profit_usd)}  ` +
          `repaid ${usd(r.sim_debt_repaid_usd)}  ${shortAddress(r.collateral_asset)} -> ${shortAddress(r.debt_asset)}`,
      );
    }
  }

  const failed = rows.filter((r) => r.sim_status === "failed");
  if (failed.length > 0) {
    const reasons = new Map<string, number>();
    for (const r of failed) {
      const reason = r.sim_error?.includes("0x930bb771")
        ? "not liquidatable one block earlier (oracle update in same block)"
        : (r.sim_error ?? "unknown").slice(0, 80);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    console.log(`\nFailed replays by reason:`);
    for (const [reason, n] of reasons) console.log(`  ${n}x ${reason}`);
  }
  console.log();
}

main();
