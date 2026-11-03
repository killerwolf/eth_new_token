import { describe, expect, it } from 'vitest';
import { toFunctionSelector, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  classifyOwner,
  cloneImplementation,
  formatRisk,
  readRisk,
  scanBytecode,
  type RiskReport,
} from '../src/risk.js';

const sel = (signature: string) => toFunctionSelector(signature).slice(2);
const IMPL = '0x00000000000000000000000000000000000000cc' as Address;

describe('scanBytecode', () => {
  it('flags capabilities whose selectors appear in the bytecode', () => {
    const code = `0x6080${sel('mint(address,uint256)')}${sel('pause()')}00` as Hex;
    expect(scanBytecode(code)).toEqual(['mintable', 'pausable']);
  });

  it('reports nothing for plain code or missing code', () => {
    expect(scanBytecode('0x6080604052')).toEqual([]);
    expect(scanBytecode(undefined)).toEqual([]);
  });
});

describe('cloneImplementation', () => {
  it('extracts the target of an EIP-1167 minimal proxy', () => {
    const code = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(cloneImplementation(code)).toBe(IMPL);
  });

  it('ignores ordinary contracts', () => {
    expect(cloneImplementation('0x6080604052')).toBeUndefined();
  });
});

describe('classifyOwner', () => {
  it('distinguishes none / renounced / active owners', () => {
    expect(classifyOwner(undefined)).toEqual({ kind: 'none' });
    expect(classifyOwner(zeroAddress)).toEqual({ kind: 'renounced' });
    expect(classifyOwner('0x000000000000000000000000000000000000dEaD')).toEqual({ kind: 'renounced' });
    expect(classifyOwner(IMPL)).toEqual({ kind: 'address', address: IMPL });
  });
});

describe('formatRisk', () => {
  const base: RiskReport = {
    decimals: 18,
    owner: { kind: 'renounced' },
    proxy: undefined,
    capabilities: ['mintable'],
    liquidity: { v2: true, v3Fees: [3000], pools: [], complete: true },
  };

  it('renders every signal', () => {
    expect(formatRisk(base)).toEqual([
      'Decimals: 18',
      'Owner: renounced',
      'Proxy: no',
      'Flags: mintable',
      'Liquidity (vs WETH): Uniswap V2, Uniswap V3 0.3%',
    ]);
  });

  it('says "none yet" only when every pool lookup succeeded', () => {
    const none = { v2: false, v3Fees: [], pools: [], complete: true };
    expect(formatRisk({ ...base, liquidity: none }).at(-1)).toBe('Liquidity (vs WETH): none yet');
  });

  it('never presents failed probes as a clean result', () => {
    const lines = formatRisk({
      decimals: undefined,
      owner: { kind: 'unknown' },
      proxy: 'unknown',
      capabilities: undefined,
      liquidity: { v2: false, v3Fees: [], pools: [], complete: false },
    });
    expect(lines).toEqual([
      'Decimals: unknown',
      'Owner: unknown (RPC error)',
      'Proxy: unknown',
      'Flags: unknown (bytecode unreadable)',
      'Liquidity (vs WETH): unknown (RPC error)',
    ]);
  });

  it('flags partial liquidity results', () => {
    const lines = formatRisk({ ...base, liquidity: { v2: true, v3Fees: [], pools: [], complete: false } });
    expect(lines.at(-1)).toBe('Liquidity (vs WETH): Uniswap V2 (some lookups failed)');
  });
});

describe('readRisk with a flaky provider', () => {
  const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
  const named = (name: string) => Object.assign(new Error(name), { name });
  const network = () => named('HttpRequestError');

  interface Behaviour {
    getCode?: () => Promise<Hex>;
    getStorageAt?: () => Promise<Hex>;
    readContract?: (functionName: string) => Promise<unknown>;
  }
  const clientWith = (b: Behaviour = {}) =>
    ({
      getCode: b.getCode ?? (async () => '0x6080' as Hex),
      getStorageAt: b.getStorageAt ?? (async () => `0x${'00'.repeat(32)}` as Hex),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (b.readContract) return b.readContract(functionName);
        if (functionName === 'decimals') return 18;
        if (functionName === 'owner') throw named('ContractFunctionRevertedError');
        return zeroAddress; // getPair / getPool: no pool
      },
    }) as unknown as PublicClient;

  it('reports a clean token as clean', async () => {
    const risk = await readRisk(clientWith(), TOKEN);
    expect(risk).toMatchObject({
      decimals: 18,
      owner: { kind: 'none' },
      proxy: undefined,
      capabilities: [],
      liquidity: { v2: false, v3Fees: [], pools: [], complete: true },
    });
  });

  it('marks liquidity incomplete when a pool lookup fails, instead of "none"', async () => {
    const risk = await readRisk(
      clientWith({
        readContract: async (fn) => {
          if (fn === 'getPair') throw network();
          if (fn === 'decimals') return 18;
          if (fn === 'owner') throw named('ContractFunctionRevertedError');
          return zeroAddress;
        },
      }),
      TOKEN,
    );
    expect(risk?.liquidity).toEqual({ v2: false, v3Fees: [], pools: [], complete: false });
  });

  it('keeps pools it did find when other lookups fail', async () => {
    const pool = '0x00000000000000000000000000000000000000dd' as Address;
    const risk = await readRisk(
      clientWith({
        readContract: async (fn) => {
          if (fn === 'getPair') return pool;
          if (fn === 'getPool') throw network();
          if (fn === 'decimals') return 18;
          throw named('ContractFunctionRevertedError');
        },
      }),
      TOKEN,
    );
    expect(risk?.liquidity).toEqual({ v2: true, v3Fees: [], pools: [pool], complete: false });
  });

  it('collects the addresses of the pools it finds (V2 pair first, then V3)', async () => {
    const v2 = '0x00000000000000000000000000000000000000d2' as Address;
    const v3 = '0x00000000000000000000000000000000000000d3' as Address;
    const risk = await readRisk(
      clientWith({
        readContract: async (fn) => {
          if (fn === 'getPair') return v2;
          if (fn === 'getPool') return v3; // answered for each fee tier
          if (fn === 'decimals') return 18;
          throw named('ContractFunctionRevertedError');
        },
      }),
      TOKEN,
    );
    expect(risk?.liquidity.pools).toEqual([v2, v3, v3, v3]);
    expect(risk?.liquidity.v3Fees).toEqual([500, 3000, 10000]);
  });

  it('distinguishes "no owner()" (revert) from "could not ask" (provider error)', async () => {
    const reads = (ownerError: Error) =>
      readRisk(
        clientWith({
          readContract: async (fn) => {
            if (fn === 'owner') throw ownerError;
            return fn === 'decimals' ? 18 : zeroAddress;
          },
        }),
        TOKEN,
      );
    expect((await reads(named('ContractFunctionRevertedError')))?.owner).toEqual({ kind: 'none' });
    expect((await reads(network()))?.owner).toEqual({ kind: 'unknown' });
  });

  it('reports unknown flags / proxy instead of "none" when bytecode or storage reads fail', async () => {
    const IMPL = '00000000000000000000000000000000000000cc';
    let calls = 0;
    const risk = await readRisk(
      clientWith({
        getStorageAt: async () => `0x${'00'.repeat(12)}${IMPL}` as Hex, // EIP-1967 proxy
        getCode: async () => {
          if (calls++ === 0) return '0x6080'; // the proxy itself
          throw network(); // its implementation
        },
      }),
      TOKEN,
    );
    expect(risk?.proxy).toBe('eip1967');
    expect(risk?.capabilities).toBeUndefined();

    const noSlot = await readRisk(
      clientWith({
        getStorageAt: async () => {
          throw network();
        },
      }),
      TOKEN,
    );
    expect(noSlot?.proxy).toBe('unknown');
  });
});
