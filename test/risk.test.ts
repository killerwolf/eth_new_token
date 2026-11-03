import { describe, expect, it } from 'vitest';
import { toFunctionSelector, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  classifyOwner,
  cloneImplementation,
  formatRisk,
  isFunded,
  MIN_FUNDED_WETH,
  readRisk,
  scanBytecode,
  type PoolInfo,
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

const P1 = '0x00000000000000000000000000000000000000d1' as Address;
const P2 = '0x00000000000000000000000000000000000000d2' as Address;
const weth = (amount: number): bigint => BigInt(Math.round(amount * 1e6)) * 10n ** 12n;
const liq = (details: PoolInfo[] = [], complete = true): RiskReport['liquidity'] => ({
  v2: details.some((d) => d.label === 'Uniswap V2'),
  v3Fees: [],
  pools: details.map((d) => d.pool),
  details,
  funded: details.some(isFunded),
  complete,
});

describe('formatRisk', () => {
  const base: RiskReport = {
    decimals: 18,
    owner: { kind: 'renounced' },
    proxy: undefined,
    capabilities: ['mintable'],
    liquidity: liq([
      { label: 'Uniswap V2', pool: P1, kind: 'v2', weth: weth(3.5) },
      { label: 'Uniswap V3 0.3%', pool: P2, kind: 'v3', weth: weth(1.25), active: true },
    ]),
  };
  const lastLine = (liquidity: RiskReport['liquidity']) => formatRisk({ ...base, liquidity }).at(-1);

  it('renders every signal, with the WETH held by each pool', () => {
    expect(formatRisk(base)).toEqual([
      'Decimals: 18',
      'Owner: renounced',
      'Proxy: no',
      'Flags: mintable',
      'Liquidity (vs WETH): Uniswap V2 (3.50 WETH), Uniswap V3 0.3% (1.25 WETH)',
    ]);
  });

  it('says "none yet" only when every lookup succeeded and no pool exists', () => {
    expect(lastLine(liq())).toBe('Liquidity (vs WETH): none yet');
  });

  it('does not present a pool that exists but holds nothing as liquidity', () => {
    expect(lastLine(liq([{ label: 'Uniswap V2', pool: P1, kind: 'v2', weth: 0n }]))).toBe(
      'Liquidity (vs WETH): Uniswap V2 (created, empty)',
    );
  });

  it('labels dust and unreadable balances for what they are', () => {
    expect(lastLine(liq([{ label: 'Uniswap V2', pool: P1, kind: 'v2', weth: 1n }]))).toBe(
      'Liquidity (vs WETH): Uniswap V2 (0.000000000000000001 WETH, dust)',
    );
    expect(lastLine(liq([{ label: 'Uniswap V2', pool: P1, kind: 'v2', weth: undefined }]))).toBe(
      'Liquidity (vs WETH): Uniswap V2 (balance unknown)',
    );
  });

  it('does not call a V3 pool without WETH "empty": positions can be token-side only', () => {
    expect(lastLine(liq([{ label: 'Uniswap V3 0.3%', pool: P1, kind: 'v3', weth: 0n, active: false }]))).toBe(
      'Liquidity (vs WETH): Uniswap V3 0.3% (no WETH, token-side positions possible)',
    );
  });

  it('flags WETH sitting in a V3 pool with no active liquidity (a donation, not a market)', () => {
    expect(lastLine(liq([{ label: 'Uniswap V3 1%', pool: P1, kind: 'v3', weth: weth(2), active: false }]))).toBe(
      'Liquidity (vs WETH): Uniswap V3 1% (2.00 WETH, no active liquidity)',
    );
  });

  it('never presents failed probes as a clean result', () => {
    const lines = formatRisk({
      decimals: undefined,
      owner: { kind: 'unknown' },
      proxy: 'unknown',
      capabilities: undefined,
      liquidity: liq([], false),
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
    expect(lastLine(liq([{ label: 'Uniswap V2', pool: P1, kind: 'v2', weth: weth(3.5) }], false))).toBe(
      'Liquidity (vs WETH): Uniswap V2 (3.50 WETH) (some lookups failed)',
    );
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
      liquidity: { v2: false, v3Fees: [], pools: [], details: [], funded: false, complete: true },
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
    expect(risk?.liquidity).toEqual({ v2: false, v3Fees: [], pools: [], details: [], funded: false, complete: false });
  });

  it('keeps pools it did find when other lookups fail', async () => {
    const pool = '0x00000000000000000000000000000000000000dd' as Address;
    const risk = await readRisk(
      clientWith({
        readContract: async (fn) => {
          if (fn === 'getPair') return pool;
          if (fn === 'getPool') throw network();
          if (fn === 'getReserves') return [0n, weth(2), 0];
          if (fn === 'decimals') return 18;
          throw named('ContractFunctionRevertedError');
        },
      }),
      TOKEN,
    );
    expect(risk?.liquidity).toMatchObject({ v2: true, v3Fees: [], pools: [pool], funded: true, complete: false });
  });

  it('collects the addresses of the pools it finds (V2 pair first, then V3)', async () => {
    const v2 = '0x00000000000000000000000000000000000000d2' as Address;
    const v3 = '0x00000000000000000000000000000000000000d3' as Address;
    const risk = await readRisk(
      clientWith({
        readContract: async (fn) => {
          if (fn === 'getPair') return v2;
          if (fn === 'getPool') return v3; // answered for each fee tier
          if (fn === 'balanceOf') return weth(1);
          if (fn === 'liquidity') return 5n;
          if (fn === 'getReserves') return [0n, weth(1), 0];
          if (fn === 'decimals') return 18;
          throw named('ContractFunctionRevertedError');
        },
      }),
      TOKEN,
    );
    expect(risk?.liquidity.pools).toEqual([v2, v3, v3, v3]);
    expect(risk?.liquidity.v3Fees).toEqual([500, 3000, 10000]);
  });

  describe('a pool that exists is not liquidity', () => {
    const POOL = '0x00000000000000000000000000000000000000dd' as Address;
    // TOKEN (0x..aa) sorts below WETH (0xC02a..), so WETH is token1 / reserve1 in a V2 pair.
    const v2 = (reserves: () => Promise<readonly [bigint, bigint, number]>, balance = async () => weth(100)) =>
      readRisk(
        clientWith({
          readContract: async (fn) => {
            if (fn === 'getPair') return POOL; // e.g. created in the token's constructor
            if (fn === 'getReserves') return reserves();
            if (fn === 'balanceOf') return balance(); // must be ignored for V2: donations
            if (fn === 'decimals') return 18;
            if (fn === 'owner') throw named('ContractFunctionRevertedError');
            return zeroAddress;
          },
        }),
        TOKEN,
      );
    const v3 = (balance: () => Promise<bigint>, liquidity: () => Promise<bigint>) =>
      readRisk(
        clientWith({
          readContract: async (fn) => {
            if (fn === 'getPool') return POOL;
            if (fn === 'balanceOf') return balance();
            if (fn === 'liquidity') return liquidity();
            if (fn === 'decimals') return 18;
            if (fn === 'owner') throw named('ContractFunctionRevertedError');
            return zeroAddress;
          },
        }),
        TOKEN,
      );

    it('an empty V2 pair exists but is not funded', async () => {
      const risk = await v2(async () => [0n, 0n, 0]);
      expect(risk?.liquidity).toMatchObject({ v2: true, pools: [POOL], funded: false, complete: true });
      expect(risk?.liquidity.details).toEqual([{ label: 'Uniswap V2', pool: POOL, kind: 'v2', weth: 0n }]);
    });

    it('a WETH donation to a V2 pair is not liquidity: reserves are what count', async () => {
      const risk = await v2(async () => [0n, 0n, 0], async () => weth(5)); // 5 WETH sent, nothing minted
      expect(risk?.liquidity.funded).toBe(false);
    });

    it('reads the WETH side of the reserves, whichever side the address sort puts it on', async () => {
      expect((await v2(async () => [weth(900), weth(2), 0]))?.liquidity.details[0]?.weth).toBe(weth(2));

      const HIGH = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF' as Address; // sorts above WETH
      const risk = await readRisk(
        clientWith({
          readContract: async (fn) => {
            if (fn === 'getPair') return POOL;
            if (fn === 'getReserves') return [weth(2), weth(900), 0];
            if (fn === 'decimals') return 18;
            if (fn === 'owner') throw named('ContractFunctionRevertedError');
            return zeroAddress;
          },
        }),
        HIGH,
      );
      expect(risk?.liquidity.details[0]?.weth).toBe(weth(2)); // WETH is token0 here
    });

    it('dust below the threshold does not count as funded; the threshold and above does', async () => {
      expect((await v2(async () => [0n, MIN_FUNDED_WETH - 1n, 0]))?.liquidity.funded).toBe(false);
      expect((await v2(async () => [0n, MIN_FUNDED_WETH, 0]))?.liquidity.funded).toBe(true);
      expect((await v2(async () => [0n, weth(40), 0]))?.liquidity.funded).toBe(true);
    });

    it('an unreadable V2 reserve is unknown, never "funded" or "empty"', async () => {
      const risk = await v2(async () => {
        throw network();
      });
      expect(risk?.liquidity.details).toEqual([{ label: 'Uniswap V2', pool: POOL, kind: 'v2', weth: undefined }]);
      expect(risk?.liquidity).toMatchObject({ funded: false, complete: false });
    });

    it('V3: WETH plus active liquidity is funded', async () => {
      const risk = await v3(async () => weth(3), async () => 10n);
      expect(risk?.liquidity).toMatchObject({ funded: true, v3Fees: [500, 3000, 10000].slice(0, 3), complete: true });
    });

    it('V3: WETH sent to a pool with no active liquidity is a donation, not funding', async () => {
      const risk = await v3(async () => weth(3), async () => 0n);
      expect(risk?.liquidity.funded).toBe(false);
      expect(risk?.liquidity.details[0]).toMatchObject({ kind: 'v3', weth: weth(3), active: false });
    });

    it('V3: an unreadable liquidity() leaves the pool unfunded and the report incomplete', async () => {
      const risk = await v3(async () => weth(3), async () => {
        throw network();
      });
      expect(risk?.liquidity).toMatchObject({ funded: false, complete: false });
    });
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
