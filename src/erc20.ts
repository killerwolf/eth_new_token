import { erc20Abi, type Address, type PublicClient } from 'viem';
import type { TokenInfo } from './report.js';

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

/**
 * Reads `name()` and `symbol()`. Returns `undefined` for contracts that don't expose
 * them as strings (e.g. legacy `bytes32` tokens such as MKR) rather than throwing.
 */
export async function readTokenInfo(
  client: PublicClient,
  address: Address,
): Promise<TokenInfo | undefined> {
  try {
    const [name, symbol] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    ]);
    return { address, name, symbol };
  } catch {
    return undefined;
  }
}
