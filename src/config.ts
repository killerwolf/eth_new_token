export const MODES = ['ContractCreated', 'Transfer'] as const;
export type Mode = (typeof MODES)[number];

export interface Config {
  mode: Mode;
  /** ws(s):// → push subscriptions; http(s):// → polling. */
  rpcUrl: string;
}

export class ConfigError extends Error {}

const isMode = (value: string | undefined): value is Mode =>
  MODES.some((mode) => mode === value);

/** Validate CLI args + environment up front so we fail fast with a clear message. */
export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): Config {
  const mode = argv[0];
  if (!isMode(mode)) {
    throw new ConfigError(`Invalid mode "${mode ?? ''}". Use one of: ${MODES.join(', ')}.`);
  }

  return { mode, rpcUrl: parseRpcUrl(env) };
}

/**
 * The URL usually embeds a provider API key, so error messages must never echo it.
 * Any Ethereum mainnet endpoint works (Infura, Alchemy, QuickNode, a local node…), over
 * WebSocket (push, lowest latency) or HTTP (polling, works behind proxies / on restricted hosts).
 * `ETH_WS_URL` is the previous name and still accepted.
 */
function parseRpcUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.ETH_RPC_URL?.trim() || env.ETH_WS_URL?.trim();
  if (!raw) {
    const legacy = env.INFURA_PROJECT_ID
      ? ' INFURA_PROJECT_ID is no longer used: put the full URL in ETH_RPC_URL.'
      : '';
    throw new ConfigError(`ETH_RPC_URL is not set (see .env.example).${legacy}`);
  }

  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new ConfigError('ETH_RPC_URL is not a valid URL.');
  }
  if (!['wss:', 'ws:', 'https:', 'http:'].includes(protocol)) {
    throw new ConfigError('ETH_RPC_URL must start with wss://, ws://, https:// or http://.');
  }
  return raw;
}

export const isWebSocketUrl = (url: string): boolean => /^wss?:/i.test(url);
