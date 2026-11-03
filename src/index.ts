import 'dotenv/config';
import { createPublicClient, http, webSocket, type Transport } from 'viem';
import { mainnet } from 'viem/chains';
import { ConfigError, isWebSocketUrl, loadConfig } from './config.js';
import { readTokenInfo, readTotalSupply } from './erc20.js';
import { createNotifiers, NotifierConfigError } from './notify.js';
import { readRisk } from './risk.js';
import type { Deps } from './handlers.js';
import { formatReport } from './report.js';
import { installSafeConsole } from './safeConsole.js';
import { SeenSet } from './seen.js';
import { describeError } from './errors.js';
import { watchContractCreated, watchMints } from './watch.js';

/** Mainnet blocks take ~12s; polling every 6s keeps latency low without burning provider quota. */
const POLLING_INTERVAL_MS = 6_000;
/** ~33 minutes of 2s retries; past that we exit non-zero so a supervisor restarts us. */
const RECONNECT_ATTEMPTS = 1_000;

function createTransport(url: string): Transport {
  return isWebSocketUrl(url)
    ? webSocket(url, { keepAlive: { interval: 30_000 }, reconnect: { attempts: RECONNECT_ATTEMPTS, delay: 2_000 } })
    : http(url, { retryCount: 3, timeout: 15_000 });
}

function main(): void {
  const config = loadConfig(process.argv.slice(2), process.env);

  const client = createPublicClient({
    chain: mainnet,
    transport: createTransport(config.rpcUrl),
    pollingInterval: POLLING_INTERVAL_MS,
  });

  const notifiers = createNotifiers(process.env);

  const deps: Deps = {
    readTotalSupply: (address) => readTotalSupply(client, address),
    readTokenInfo: (address) => readTokenInfo(client, address),
    readRisk: (address) => readRisk(client, address),
    announce: (token, extras) => {
      console.log(`${formatReport(token, extras)}\n`);
      for (const notifier of notifiers) {
        notifier.send(formatReport(token, extras, notifier.escape)).catch((error: unknown) => {
          console.error(`Notify (${notifier.name}) failed: ${describeError(error)}`);
        });
      }
    },
    seen: new SeenSet(),
  };

  const unwatch =
    config.mode === 'ContractCreated' ? watchContractCreated(client, deps) : watchMints(client, deps);
  const sinks = ['console', ...notifiers.map((n) => n.name)].join(', ');
  const via = isWebSocketUrl(config.rpcUrl) ? 'websocket' : 'http polling';
  console.error(`Watching Ethereum mainnet (${config.mode}, ${via}) → ${sinks}. Ctrl+C to stop.`);

  const shutdown = () => {
    unwatch();
    process.exit(0);
  };
  // If the event loop drains, the provider connection is gone for good (viem gave up
  // reconnecting). Exit non-zero so `Restart=on-failure` / Docker restart policies kick in.
  process.once('beforeExit', () => {
    console.error('RPC connection closed and could not be re-established; exiting.');
    process.exitCode = 1;
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

installSafeConsole();

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${describeError(reason)}`);
  process.exit(1);
});

try {
  main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof NotifierConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
