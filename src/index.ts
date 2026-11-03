import 'dotenv/config';
import { createPublicClient, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
import { ConfigError, loadConfig } from './config.js';
import { readTokenInfo, readTotalSupply } from './erc20.js';
import { createNotifiers, NotifierConfigError } from './notify.js';
import { readRisk } from './risk.js';
import type { Deps } from './handlers.js';
import { formatReport } from './report.js';
import { SeenSet } from './seen.js';
import { describeError, watchContractCreated, watchMints } from './watch.js';

function main(): void {
  const config = loadConfig(process.argv.slice(2), process.env);

  const client = createPublicClient({
    chain: mainnet,
    transport: webSocket(config.wsUrl, {
      keepAlive: { interval: 30_000 },
      reconnect: { attempts: 10, delay: 2_000 },
    }),
  });

  const notifiers = createNotifiers(process.env);

  const deps: Deps = {
    readTotalSupply: (address) => readTotalSupply(client, address),
    readTokenInfo: (address) => readTokenInfo(client, address),
    readRisk: (address) => readRisk(client, address),
    announce: (token, extras) => {
      const report = formatReport(token, extras);
      console.log(`${report}\n`);
      for (const notifier of notifiers) {
        notifier.send(report).catch((error: unknown) => {
          console.error(`Notify (${notifier.name}) failed: ${describeError(error)}`);
        });
      }
    },
    seen: new SeenSet(),
  };

  const unwatch =
    config.mode === 'ContractCreated' ? watchContractCreated(client, deps) : watchMints(client, deps);
  const sinks = ['console', ...notifiers.map((n) => n.name)].join(', ');
  console.error(`Watching Ethereum mainnet (${config.mode}) → ${sinks}. Ctrl+C to stop.`);

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
  if (error instanceof ConfigError || error instanceof NotifierConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
