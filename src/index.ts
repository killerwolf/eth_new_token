import 'dotenv/config';
import { createPublicClient, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
import { ConfigError, loadConfig } from './config.js';
import { readTokenInfo, readTotalSupply } from './erc20.js';
import type { Deps } from './handlers.js';
import { formatReport } from './report.js';
import { SeenSet } from './seen.js';
import { watchContractCreated, watchMints } from './watch.js';

function main(): void {
  const config = loadConfig(process.argv.slice(2), process.env);

  const client = createPublicClient({
    chain: mainnet,
    transport: webSocket(config.wsUrl, {
      keepAlive: { interval: 30_000 },
      reconnect: { attempts: 10, delay: 2_000 },
    }),
  });

  const deps: Deps = {
    readTotalSupply: (address) => readTotalSupply(client, address),
    readTokenInfo: (address) => readTokenInfo(client, address),
    announce: (token, holder) => console.log(`${formatReport(token, holder)}\n`),
    seen: new SeenSet(),
  };

  const unwatch =
    config.mode === 'ContractCreated' ? watchContractCreated(client, deps) : watchMints(client, deps);
  console.error(`Watching Ethereum mainnet (${config.mode})… Ctrl+C to stop.`);

  const shutdown = () => {
    unwatch();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
