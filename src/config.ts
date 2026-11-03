export const MODES = ['ContractCreated', 'Transfer'] as const;
export type Mode = (typeof MODES)[number];

export interface Config {
  mode: Mode;
  wsUrl: string;
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

  return { mode, wsUrl: parseWsUrl(env) };
}

/**
 * The URL usually embeds a provider API key, so error messages must never echo it.
 * Any Ethereum mainnet WebSocket endpoint works (Infura, Alchemy, QuickNode, a local node…).
 */
function parseWsUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.ETH_WS_URL?.trim();
  if (!raw) {
    const legacy = env.INFURA_PROJECT_ID ? ' INFURA_PROJECT_ID is no longer used: put the full URL in ETH_WS_URL.' : '';
    throw new ConfigError(`ETH_WS_URL is not set (see .env.example).${legacy}`);
  }

  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new ConfigError('ETH_WS_URL is not a valid URL.');
  }
  if (protocol !== 'wss:' && protocol !== 'ws:') {
    throw new ConfigError('ETH_WS_URL must be a WebSocket URL (wss://… or ws://…).');
  }
  return raw;
}
