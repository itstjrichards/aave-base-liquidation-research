import { JsonRpcProvider } from "ethers";
import { config } from "./config/config";

/** Connects to the configured RPC endpoint and logs the current block number, as a smoke test. */
async function main() {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);

  const network = await provider.getNetwork();
  const blockNumber = await provider.getBlockNumber();

  console.log(`Connected to chain ${network.chainId} (expected ${config.chainId})`);
  console.log(`Current block number: ${blockNumber}`);
}

main().catch((err) => {
  console.error("Connection check failed:", err);
  process.exit(1);
});
