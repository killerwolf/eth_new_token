import { parseAbiItem, zeroAddress, type PublicClient } from 'viem';
import { onContractCreated, onMint, type Deps } from './handlers.js';

const contractCreatedEvent = parseAbiItem('event ContractCreated(address indexed contractAddress)');
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

type Unwatch = () => void;

/** Subscription errors aren't always `Error`s (browser-style `ErrorEvent`s from the socket). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const { message, type } = error as { message?: unknown; type?: unknown };
    if (typeof message === 'string' && message) return message;
    if (typeof type === 'string') return `${type} event`;
  }
  return String(error);
}

const logError = (context: string) => (error: unknown) =>
  console.error(`${context}: ${describeError(error)}`);

export function watchContractCreated(client: PublicClient, deps: Deps): Unwatch {
  return client.watchEvent({
    event: contractCreatedEvent,
    strict: true,
    onLogs: (logs) => {
      for (const { args } of logs) {
        void onContractCreated(deps, args.contractAddress).catch(logError('ContractCreated'));
      }
    },
    onError: logError('Subscription error'),
  });
}

export function watchMints(client: PublicClient, deps: Deps): Unwatch {
  return client.watchEvent({
    event: transferEvent,
    args: { from: zeroAddress },
    // strict drops logs that don't decode as ERC-20 (e.g. ERC-721 Transfers have a 4th topic).
    strict: true,
    onLogs: (logs) => {
      for (const { address, args } of logs) {
        void onMint(deps, { token: address, to: args.to, value: args.value }).catch(
          logError('Transfer'),
        );
      }
    },
    onError: logError('Subscription error'),
  });
}
