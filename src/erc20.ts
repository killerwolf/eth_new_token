import {
  erc20Abi,
  hexToString,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { classifyRpcError, TransientRpcError } from './errors.js';
import type { TokenInfo } from './report.js';
import { sanitizeLabel } from './text.js';

/** Legacy tokens (MKR, SAI, …) return `bytes32` from name()/symbol() instead of `string`. */
const bytes32MetadataAbi = parseAbi([
  'function name() view returns (bytes32)',
  'function symbol() view returns (bytes32)',
]);

export interface RetryPolicy {
  /** Pause before each retry; its length is the retry budget. */
  delaysMs: readonly number[];
  sleep(ms: number): Promise<void>;
}

/**
 * A fresh contract is often invisible for a moment to the node answering our `eth_call` (it lags
 * the node that streamed the log), and providers rate-limit or blip. Retry briefly before judging.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  delaysMs: [500, 1_500, 3_000],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `read`, retrying while the failure says nothing about the contract itself.
 * Resolves to the value, `undefined` if the contract definitively isn't an ERC-20 (revert, bad
 * ABI data, or still no code after the retries), and throws `TransientRpcError` if the
 * provider kept failing — the caller must NOT treat that as "not a token".
 */
async function probe<T>(read: () => Promise<T>, retry: RetryPolicy): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const kind = classifyRpcError(error);
      if (kind === 'definitive') return undefined;
      const delay = retry.delaysMs[attempt];
      if (delay !== undefined) {
        await retry.sleep(delay);
        continue;
      }
      if (kind === 'zero-data') return undefined;
      throw new TransientRpcError(error);
    }
  }
}

export function readTotalSupply(
  client: PublicClient,
  address: Address,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<bigint | undefined> {
  return probe(
    () => client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
    retry,
  );
}

async function readMetadata(
  client: PublicClient,
  address: Address,
  functionName: 'name' | 'symbol',
  retry: RetryPolicy,
): Promise<string | undefined> {
  const text = await probe(
    () => client.readContract({ address, abi: erc20Abi, functionName }),
    retry,
  );
  if (text !== undefined) return text;
  const raw = await probe(
    () => client.readContract({ address, abi: bytes32MetadataAbi, functionName }),
    retry,
  );
  return raw === undefined ? undefined : hexToString(raw, { size: 32 });
}

/**
 * Reads `name()` and `symbol()` (string or legacy bytes32), sanitised because they are
 * attacker-controlled. `undefined` means the contract has no usable metadata; a provider
 * failure throws `TransientRpcError` instead.
 */
export async function readTokenInfo(
  client: PublicClient,
  address: Address,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<TokenInfo | undefined> {
  const [rawName, rawSymbol] = await Promise.all([
    readMetadata(client, address, 'name', retry),
    readMetadata(client, address, 'symbol', retry),
  ]);
  if (rawName === undefined || rawSymbol === undefined) return undefined;
  const name = sanitizeLabel(rawName);
  const symbol = sanitizeLabel(rawSymbol);
  return name && symbol ? { address, name, symbol } : undefined;
}
