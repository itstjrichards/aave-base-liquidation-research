import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { JsonRpcProvider } from "ethers";
import { config } from "../config/config";

/** One of Anvil's pre-funded local test accounts (10,000 ETH each) — never real funds. */
export interface AnvilAccount {
  address: string;
  privateKey: string;
}

/** A running Anvil fork: its RPC connection, pinned block, test accounts, and a stop handle. */
export interface AnvilFork {
  provider: JsonRpcProvider;
  rpcUrl: string;
  blockNumber: number;
  accounts: AnvilAccount[];
  stop: () => Promise<void>;
}

/**
 * Spins up a local Anvil fork of the configured chain (Base), pinned at `blockNumber` (the
 * live chain's current block if omitted), and resolves once it's accepting RPC requests.
 *
 * This never touches a live network: Anvil forks read-only from `config.rpcUrl` and all
 * writes happen only inside the local, throwaway fork process. Always call the returned
 * `stop()` when done — it kills the anvil child process so it doesn't linger holding its port.
 */
export async function startAnvilFork(blockNumber?: number): Promise<AnvilFork> {
  const liveProvider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  const forkBlockNumber = blockNumber ?? (await liveProvider.getBlockNumber());

  const port =
    config.anvilPortRangeStart +
    Math.floor(Math.random() * (config.anvilPortRangeEnd - config.anvilPortRangeStart));
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil = spawn(config.anvilPath, [
    "--fork-url",
    config.rpcUrl,
    "--fork-block-number",
    String(forkBlockNumber),
    "--chain-id",
    String(config.chainId),
    "--port",
    String(port),
    // Throttle and retry anvil's own upstream requests (for state it hasn't fetched yet)
    // to stay under the RPC provider's rate limit — see config.ts for why.
    "--compute-units-per-second",
    String(config.anvilComputeUnitsPerSecond),
    "--retries",
    String(config.anvilForkRetries),
    "--fork-retry-backoff",
    String(config.anvilForkRetryBackoffMs),
  ]);

  let accounts: AnvilAccount[];
  try {
    accounts = await waitForAnvilReady(anvil);
  } catch (err) {
    anvil.kill();
    throw err;
  }

  const provider = new JsonRpcProvider(rpcUrl, config.chainId);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    provider.destroy();
    anvil.kill();
    await new Promise<void>((resolve) => {
      anvil.once("exit", () => resolve());
      // Fallback in case the process is already gone and 'exit' never fires.
      setTimeout(resolve, 2000);
    });
  };

  return { provider, rpcUrl, blockNumber: forkBlockNumber, accounts, stop };
}

/**
 * Resolves with Anvil's pre-funded test accounts once its startup banner reports it's
 * listening for RPC connections; rejects if it exits or times out before that happens.
 */
function waitForAnvilReady(anvil: ChildProcessWithoutNullStreams): Promise<AnvilAccount[]> {
  return new Promise((resolve, reject) => {
    let output = "";

    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes("Listening on")) {
        cleanup();
        resolve(parseAnvilAccounts(output));
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`anvil exited before becoming ready (code ${code}): ${output}`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`anvil did not become ready within timeout. Output so far: ${output}`));
    }, config.anvilStartupTimeoutMs);

    function cleanup() {
      clearTimeout(timer);
      anvil.stdout.off("data", onData);
      anvil.off("error", onError);
      anvil.off("exit", onExit);
    }

    anvil.stdout.on("data", onData);
    anvil.on("error", onError);
    anvil.on("exit", onExit);
  });
}

/**
 * Parses Anvil's startup banner for its "Available Accounts" / "Private Keys" sections and
 * pairs them up by position (both are printed in the same order).
 */
function parseAnvilAccounts(output: string): AnvilAccount[] {
  const accountsSection = output.split("Available Accounts")[1]?.split("Private Keys")[0] ?? "";
  const keysSection = output.split("Private Keys")[1]?.split("Wallet")[0] ?? "";

  const addresses = [...accountsSection.matchAll(/\(\d+\)\s+(0x[0-9a-fA-F]{40})/g)].map((m) => m[1]);
  const privateKeys = [...keysSection.matchAll(/\(\d+\)\s+(0x[0-9a-fA-F]{64})/g)].map((m) => m[1]);

  return addresses.map((address, i) => ({ address, privateKey: privateKeys[i] }));
}
