import {
  erc20Abi,
  hexToString,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import type { TokenInfo } from './report.js';

/** Legacy tokens (MKR, SAI, …) return `bytes32` from name()/symbol() instead of `string`. */
const bytes32MetadataAbi = parseAbi([
  'function name() view returns (bytes32)',
  'function symbol() view returns (bytes32)',
]);

/** Returns `undefined` when the address does not answer `totalSupply()` (not an ERC-20, or reverted). */
export async function readTotalSupply(
  client: PublicClient,
  address: Address,
): Promise<bigint | undefined> {
  try {
    return await client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' });
  } catch {
    return undefined;
  }
}

async function readMetadata(
  client: PublicClient,
  address: Address,
  functionName: 'name' | 'symbol',
): Promise<string> {
  try {
    return await client.readContract({ address, abi: erc20Abi, functionName });
  } catch {
    const raw = await client.readContract({ address, abi: bytes32MetadataAbi, functionName });
    return hexToString(raw, { size: 32 });
  }
}

/**
 * Reads `name()` and `symbol()` (string or legacy bytes32). Returns `undefined` when the
 * contract exposes neither, or the value is empty, rather than throwing.
 */
export async function readTokenInfo(
  client: PublicClient,
  address: Address,
): Promise<TokenInfo | undefined> {
  try {
    const [name, symbol] = await Promise.all([
      readMetadata(client, address, 'name'),
      readMetadata(client, address, 'symbol'),
    ]);
    if (!name || !symbol) return undefined;
    return { address, name, symbol };
  } catch {
    return undefined;
  }
}
