import { describe, expect, it } from 'vitest';
import {
  createPublicClient,
  custom,
  decodeFunctionResult,
  erc20Abi,
  http,
  stringToHex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { classifyRpcError, describeError, formatErrorForLog, redactUrls } from '../src/errors.js';

const SECRET = 'SECRETKEY123';

describe('describeError', () => {
  it('handles Errors, event-like objects and primitives', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError({ type: 'error' })).toBe('error event');
    expect(describeError('x')).toBe('x');
  });

  it('never leaks the RPC URL from a real viem transport error', async () => {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(`http://127.0.0.1:9/v3/${SECRET}`, { retryCount: 0 }),
    });
    const error = await client.getBlockNumber().catch((e: unknown) => e);

    // Guard the premise: viem's own message DOES contain the secret.
    expect((error as Error).message).toContain(SECRET);
    expect(describeError(error)).not.toContain(SECRET);
  });

  it('scrubs URLs from plain errors too', () => {
    const text = describeError(new Error(`failed https://eth.example/v2/${SECRET}?k=1 twice`));
    expect(text).toBe('failed <url> twice');
    expect(redactUrls(`wss://x.example/ws/${SECRET}`)).toBe('<url>');
  });
});

describe('classifyRpcError', () => {
  it('treats provider failures as transient', async () => {
    const client = createPublicClient({
      chain: mainnet,
      transport: http('http://127.0.0.1:9', { retryCount: 0 }),
    });
    const error = await client.getBlockNumber().catch((e: unknown) => e);
    expect(classifyRpcError(error)).toBe('transient');
    expect(classifyRpcError('weird')).toBe('transient');
  });

  it('treats empty return data as zero-data and undecodable data as definitive', () => {
    const decode = (data: `0x${string}`) => () =>
      decodeFunctionResult({ abi: erc20Abi, functionName: 'name', data });
    const kindOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return classifyRpcError(error);
      }
      throw new Error('expected a decode error');
    };
    expect(kindOf(decode('0x'))).toBe('zero-data');
    expect(kindOf(decode('0x1234'))).toBe('definitive');
    // Legacy bytes32 name() read as `string` — the case the bytes32 fallback depends on.
    expect(kindOf(decode(stringToHex('MKR', { size: 32 })))).toBe('definitive');
  });
});

describe('classifyRpcError against real viem error chains', () => {
  const TOKEN = '0x00000000000000000000000000000000000000aa';
  /** What a JSON-RPC node answers to `totalSupply()`, run through viem's real error mapping. */
  async function classifyNodeError(code: number, message: string, data?: string) {
    const client = createPublicClient({
      chain: mainnet,
      transport: custom({
        request: async () => {
          throw Object.assign(new Error(message), { code, data, name: 'RpcRequestError' });
        },
      }),
    });
    const error = await client
      .readContract({ address: TOKEN, abi: erc20Abi, functionName: 'totalSupply' })
      .catch((e: unknown) => e);
    return classifyRpcError(error);
  }

  it('treats a real revert (code 3) as definitive', async () => {
    expect(await classifyNodeError(3, 'execution reverted', '0x')).toBe('definitive');
  });

  it('treats -32603 "Internal error" as transient, even though viem wraps it as a revert', async () => {
    expect(await classifyNodeError(-32603, 'Internal error')).toBe('transient');
  });

  it('treats rate limits and generic server errors as transient', async () => {
    expect(await classifyNodeError(-32005, 'limit exceeded')).toBe('transient');
    expect(await classifyNodeError(-32000, 'out of gas')).toBe('transient');
  });
});

describe('formatErrorForLog', () => {
  it('keeps the stack of unexpected errors (bugs) but still scrubs URLs', () => {
    const bug = new TypeError('Cannot read properties of undefined at https://k.example/SECRETKEY123');
    const text = formatErrorForLog(bug);
    expect(text).toContain('TypeError');
    expect(text).toContain('errors.test.ts'); // stack frame present
    expect(text).not.toContain('SECRETKEY123');
  });

  it('keeps provider errors to one safe line', () => {
    expect(formatErrorForLog('plain')).toBe('plain');
  });
});
