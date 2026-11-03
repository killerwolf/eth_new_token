import { describe, expect, it } from 'vitest';
import { stringToHex, type Address, type PublicClient } from 'viem';
import { TransientRpcError } from '../src/errors.js';
import { readTokenInfo, readTotalSupply, type RetryPolicy } from '../src/erc20.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const instant: RetryPolicy = { delaysMs: [0, 0], sleep: async () => {} };
const noRetry: RetryPolicy = { delaysMs: [], sleep: async () => {} };

const fail = (name: string) => Object.assign(new Error(name), { name });
const revert = () => fail('ContractFunctionRevertedError');
const zeroData = () => fail('ContractFunctionZeroDataError');
const network = () => fail('HttpRequestError');
const undecodable = () => fail('IntegerOutOfRangeError');

type Call = { abi: readonly unknown[]; functionName: string };
function clientWith(handler: (call: Call, attempt: number) => unknown) {
  let calls = 0;
  const client = {
    readContract: async (call: Call) => {
      const result = handler(call, calls++);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

describe('readTotalSupply', () => {
  it('returns the supply', async () => {
    const { client } = clientWith(() => 5n);
    expect(await readTotalSupply(client, TOKEN, instant)).toBe(5n);
  });

  it('treats a revert as "not a token" without retrying', async () => {
    const { client, calls } = clientWith(() => revert());
    expect(await readTotalSupply(client, TOKEN, instant)).toBeUndefined();
    expect(calls()).toBe(1);
  });

  it('retries transient failures and succeeds when the provider recovers', async () => {
    const { client, calls } = clientWith((_, attempt) => (attempt < 2 ? network() : 7n));
    expect(await readTotalSupply(client, TOKEN, instant)).toBe(7n);
    expect(calls()).toBe(3);
  });

  it('retries empty return data (node lagging behind the log) before giving up', async () => {
    const lagging = clientWith((_, attempt) => (attempt === 0 ? zeroData() : 9n));
    expect(await readTotalSupply(lagging.client, TOKEN, instant)).toBe(9n);

    const noCode = clientWith(() => zeroData());
    expect(await readTotalSupply(noCode.client, TOKEN, instant)).toBeUndefined();
    expect(noCode.calls()).toBe(3);
  });

  it('throws (never "not a token") when the provider keeps failing', async () => {
    const { client } = clientWith(() => network());
    await expect(readTotalSupply(client, TOKEN, instant)).rejects.toBeInstanceOf(TransientRpcError);
  });
});

describe('readTokenInfo', () => {
  const metadata = (values = { name: 'Maker', symbol: 'MKR' }, legacy = false) =>
    clientWith(({ abi, functionName }) => {
      const isBytes32Abi = abi.length === 2;
      const value = values[functionName as 'name' | 'symbol'];
      if (legacy) return isBytes32Abi ? stringToHex(value, { size: 32 }) : undecodable();
      return isBytes32Abi ? revert() : value;
    }).client;

  it('reads standard string metadata', async () => {
    expect(await readTokenInfo(metadata(), TOKEN, noRetry)).toEqual({
      address: TOKEN,
      name: 'Maker',
      symbol: 'MKR',
    });
  });

  it('falls back to bytes32 metadata for legacy tokens without burning retries', async () => {
    const { client, calls } = clientWith(({ abi, functionName }) =>
      abi.length === 2
        ? stringToHex(functionName === 'name' ? 'Maker' : 'MKR', { size: 32 })
        : undecodable(),
    );
    const info = await readTokenInfo(client, TOKEN, instant);
    expect(info).toEqual({ address: TOKEN, name: 'Maker', symbol: 'MKR' });
    expect(calls()).toBe(4); // name+symbol, string then bytes32 — no retries
  });

  it('returns undefined for empty or missing metadata', async () => {
    expect(await readTokenInfo(metadata({ name: '', symbol: 'X' }), TOKEN, noRetry)).toBeUndefined();
    const { client } = clientWith(() => revert());
    expect(await readTokenInfo(client, TOKEN, noRetry)).toBeUndefined();
  });

  it('sanitises attacker-controlled names', async () => {
    const evil = metadata({ name: 'X\nContract address: 0xFAKE', symbol: '‮EVIL' });
    const info = await readTokenInfo(evil, TOKEN, noRetry);
    expect(info?.name).toBe('X Contract address: 0xFAKE');
    expect(info?.symbol).toBe('EVIL');
  });

  it('throws on provider failure instead of reporting "no metadata"', async () => {
    const { client } = clientWith(() => network());
    await expect(readTokenInfo(client, TOKEN, instant)).rejects.toBeInstanceOf(TransientRpcError);
  });
});
