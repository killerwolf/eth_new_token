import 'dotenv/config';
import { createPublicClient, http, webSocket, type Transport } from 'viem';
import { mainnet } from 'viem/chains';
import { ConfigError, isWebSocketUrl, loadConfig } from './config.js';
import { readTokenInfo, readTotalSupply } from './erc20.js';
import { createNotifiers, NotifierConfigError } from './notify.js';
import { readRisk } from './risk.js';
import { FollowUpBudget, scheduleLater, type Deps } from './handlers.js';
import { formatLiquidityUpdate, formatReport } from './report.js';
import { installSafeConsole } from './safeConsole.js';
import { SeenSet } from './seen.js';
import { diagnoseWebSocket } from './diagnose.js';
import { addSecret, addSecretsFromUrl, describeError, formatErrorForLog } from './errors.js';
import { watchContractCreated, watchMints } from './watch.js';

/** Mainnet blocks take ~12s; polling every 6s keeps latency low without burning provider quota. */
const POLLING_INTERVAL_MS = 6_000;
/** ~33 minutes of 2s retries; past that we exit non-zero so a supervisor restarts us. */
const RECONNECT_ATTEMPTS = 1_000;

function createTransport(url: string): Transport {
  return isWebSocketUrl(url)
    ? webSocket(url, { keepAlive: { interval: 30_000 }, reconnect: { attempts: RECONNECT_ATTEMPTS, delay: 2_000 } })
    : http(url, { retryCount: 1, timeout: 10_000 });
}

function main(): void {
  const config = loadConfig(process.argv.slice(2), process.env);
  addSecretsFromUrl(config.rpcUrl);
  addSecretsFromUrl(process.env.DISCORD_WEBHOOK_URL);
  addSecret(process.env.TELEGRAM_BOT_TOKEN?.trim());

  const client = createPublicClient({
    chain: mainnet,
    transport: createTransport(config.rpcUrl),
    pollingInterval: POLLING_INTERVAL_MS,
  });

  const notifiers = createNotifiers(process.env);

  /** Print to the console and push to every configured sink, each with its own escaping. */
  const publish = (render: (escape: (label: string) => string) => string): void => {
    console.log(`${render((label) => label)}\n`);
    for (const notifier of notifiers) {
      notifier.send(render(notifier.escape)).catch((error: unknown) => {
        console.error(`Notify (${notifier.name}) failed: ${describeError(error)}`);
      });
    }
  };

  const deps: Deps = {
    readTotalSupply: (address) => readTotalSupply(client, address),
    readTokenInfo: (address) => readTokenInfo(client, address),
    readRisk: (address) => readRisk(client, address),
    announce: (token, extras) => publish((escape) => formatReport(token, extras, escape)),
    announceUpdate: (token, risk) => publish((escape) => formatLiquidityUpdate(token, risk, escape)),
    followUps: new FollowUpBudget(),
    schedule: scheduleLater,
    reportError: (error) => console.error(`Retry: ${formatErrorForLog(error)}`),
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
    process.exitCode = 1;
    console.error('The RPC connection could not be opened, or was lost for good; exiting.');
    if (!isWebSocketUrl(config.rpcUrl)) return;
    // The pending probe keeps the loop alive until it finishes; `once` stops this re-running.
    diagnoseWebSocket(config.rpcUrl)
      .then((lines) => {
        for (const line of lines) console.error(line);
      })
      .catch(() => undefined); // diagnostics are best effort
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

installSafeConsole();

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${formatErrorForLog(reason)}`);
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
