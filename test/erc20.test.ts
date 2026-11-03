import { describe, expect, it } from 'vitest';
import { stringToHex, type Address, type PublicClient } from 'viem';
import { readTokenInfo } from '../src/erc20.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;

/** Fake client: `legacy` tokens revert on the string ABI and answer the bytes32 one. */
const fakeClient = (legacy: boolean, values = { name: 'Maker', symbol: 'MKR' }) =>
  ({
    readContract: async ({ abi, functionName }: { abi: readonly unknown[]; functionName: 'name' | 'symbol' }) => {
      const isBytes32Abi = abi.length === 2;
      if (legacy && !isBytes32Abi) throw new Error('decode error');
      return isBytes32Abi ? stringToHex(values[functionName], { size: 32 }) : values[functionName];
    },
  }) as unknown as PublicClient;

describe('readTokenInfo', () => {
  it('reads standard string metadata', async () => {
    expect(await readTokenInfo(fakeClient(false), TOKEN)).toEqual({
      address: TOKEN,
      name: 'Maker',
      symbol: 'MKR',
    });
  });

  it('falls back to bytes32 metadata for legacy tokens', async () => {
    const info = await readTokenInfo(fakeClient(true), TOKEN);
    expect(info).toEqual({ address: TOKEN, name: 'Maker', symbol: 'MKR' });
  });

  it('returns undefined for empty or unreadable metadata', async () => {
    expect(await readTokenInfo(fakeClient(false, { name: '', symbol: 'X' }), TOKEN)).toBeUndefined();
    const broken = { readContract: async () => { throw new Error('revert'); } } as unknown as PublicClient;
    expect(await readTokenInfo(broken, TOKEN)).toBeUndefined();
  });
});
