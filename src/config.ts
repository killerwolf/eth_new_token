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

  const projectId = env.INFURA_PROJECT_ID?.trim();
  if (!projectId) {
    throw new ConfigError('INFURA_PROJECT_ID is not set (see .env.example).');
  }

  return { mode, wsUrl: `wss://mainnet.infura.io/ws/v3/${projectId}` };
}
