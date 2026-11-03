import { classifyRpcError } from './errors.js';
import {
  erc20Abi,
  formatEther,
  getAddress,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * On-chain, API-free risk signals. These are *heuristics*: a missing flag is not a safety
 * guarantee and a present one is not proof of a rug. Their job is to rank what to look at first.
 */

export const CAPABILITIES = {
  mintable: ['mint(address,uint256)', 'mint(uint256)'],
  blacklist: ['blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)'],
  pausable: ['pause()', 'unpause()'],
  tradingToggle: ['enableTrading()', 'openTrading()', 'setTradingEnabled(bool)', 'setTrading(bool)'],
  adjustableFees: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setTax(uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'setTaxFeePercent(uint256)'],
  txLimits: ['setMaxTxAmount(uint256)', 'setMaxWalletAmount(uint256)', 'setMaxWallet(uint256)'],
} as const;

export type Capability = keyof typeof CAPABILITIES;

const SELECTORS = Object.entries(CAPABILITIES).map(
  ([capability, signatures]) =>
    [capability as Capability, signatures.map((s) => toFunctionSelector(s).slice(2))] as const,
);

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** EIP-1167 minimal proxy: 10-byte prefix, 20-byte implementation, then suffix. */
const CLONE_PREFIX = '363d3d373d3d3d363d73';

const DEAD = '0x000000000000000000000000000000000000dEaD';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const V3_FEES = [500, 3000, 10000] as const;

const probeAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
]);
const v2FactoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);
const v3PoolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const v3FactoryAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)',
]);

export interface PoolInfo {
  label: string;
  pool: Address;
  kind: 'v2' | 'v3';
  /**
   * WETH really backing the pool: the WETH RESERVE of a V2 pair (a donation to the pair is not a
   * reserve), the WETH balance of a V3 pool. `undefined` if the read failed.
   */
  weth: bigint | undefined;
  /** V3 only: the pool has active (in-range) liquidity. A balance alone can be a donation. */
  active?: boolean | undefined;
}

/** Does this pool hold real, tradable liquidity (and not just exist, or hold donated dust)? */
export const isFunded = (d: PoolInfo): boolean =>
  d.weth !== undefined && d.weth >= MIN_FUNDED_WETH && (d.kind === 'v2' || d.active === true);

/**
 * A pool counts as funded from 0.01 WETH. Anyone can create a pool for any token (many tokens do
 * it in their constructor) and anyone can send dust to it, so existence alone proves nothing.
 * A heuristic threshold: the amounts are printed so readers can judge.
 */
export const MIN_FUNDED_WETH = 10n ** 16n;

export type OwnerStatus =
  | { kind: 'none' }
  | { kind: 'renounced' }
  | { kind: 'address'; address: Address }
  /** The probe failed for reasons unrelated to the contract (provider error). */
  | { kind: 'unknown' };

/**
 * `undefined`/`'unknown'` always means "the probe failed", never "clean": a flaky provider must
 * not look like a reassuring report.
 */
export interface RiskReport {
  decimals: number | undefined;
  owner: OwnerStatus;
  proxy: 'eip1967' | 'clone' | 'unknown' | undefined;
  /** `undefined` when the (implementation) bytecode could not be read. */
  capabilities: Capability[] | undefined;
  liquidity: {
    v2: boolean;
    v3Fees: number[];
    /**
     * Pools that EXIST (V2 pair first, then V3). A factory returns an address as soon as the pool
     * is created, before anyone has put a single token in it: see `funded`.
     */
    pools: Address[];
    /** Each existing pool with its WETH balance (`undefined` if that read failed). */
    details: PoolInfo[];
    /** At least one pool holds `MIN_FUNDED_WETH` or more: the token can actually be traded. */
    funded: boolean;
    /** false when at least one pool lookup failed, so the pools above may be incomplete. */
    complete: boolean;
  };
}

/** Scan runtime bytecode for known function selectors (PUSH4 operands). */
export function scanBytecode(code: Hex | undefined): Capability[] {
  if (!code) return [];
  const haystack = code.slice(2).toLowerCase();
  return SELECTORS.filter(([, selectors]) => selectors.some((s) => haystack.includes(s))).map(
    ([capability]) => capability,
  );
}

/** The implementation address embedded in an EIP-1167 clone, if `code` is one. */
export function cloneImplementation(code: Hex | undefined): Address | undefined {
  if (!code) return undefined;
  const body = code.slice(2).toLowerCase();
  if (!body.startsWith(CLONE_PREFIX)) return undefined;
  const start = CLONE_PREFIX.length;
  return getAddress(`0x${body.slice(start, start + 40)}`);
}

export function classifyOwner(owner: Address | undefined): OwnerStatus {
  if (owner === undefined) return { kind: 'none' };
  if (owner === zeroAddress || owner.toLowerCase() === DEAD.toLowerCase()) {
    return { kind: 'renounced' };
  }
  return { kind: 'address', address: owner };
}

const attempt = <T>(promise: Promise<T>): Promise<T | undefined> =>
  promise.then(
    (value) => value,
    () => undefined,
  );

type Probe<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(promise: Promise<T>): Promise<Probe<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

async function resolveImplementation(
  client: PublicClient,
  address: Address,
  code: Hex,
): Promise<{ proxy: RiskReport['proxy']; implementation: Address | undefined }> {
  const clone = cloneImplementation(code);
  if (clone) return { proxy: 'clone', implementation: clone };

  const slot = await settle(
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }),
  );
  if (!slot.ok) return { proxy: 'unknown', implementation: undefined };
  const word = slot.value?.slice(-40);
  if (word && /[1-9a-f]/i.test(word)) {
    return { proxy: 'eip1967', implementation: getAddress(`0x${word}`) };
  }
  return { proxy: undefined, implementation: undefined };
}

const FEE_LABEL: Record<number, string> = { 500: '0.05%', 3000: '0.3%', 10000: '1%' };

async function readLiquidity(client: PublicClient, token: Address): Promise<RiskReport['liquidity']> {
  const [pair, ...pools] = await Promise.all([
    settle(
      client.readContract({
        address: UNISWAP_V2_FACTORY,
        abi: v2FactoryAbi,
        functionName: 'getPair',
        args: [token, WETH],
      }),
    ),
    ...V3_FEES.map((fee) =>
      settle(
        client.readContract({
          address: UNISWAP_V3_FACTORY,
          abi: v3FactoryAbi,
          functionName: 'getPool',
          args: [token, WETH, fee],
        }),
      ),
    ),
  ]);
  const found = (result: Probe<Address>): Address | undefined =>
    result.ok && result.value !== zeroAddress ? result.value : undefined;

  const candidates = [
    { label: 'Uniswap V2', pool: found(pair) },
    ...V3_FEES.map((fee, i) => ({
      label: `Uniswap V3 ${FEE_LABEL[fee] ?? fee}`,
      pool: found(pools[i] as Probe<Address>),
      fee,
    })),
  ].filter((c): c is typeof c & { pool: Address } => c.pool !== undefined);

  // Existence is not liquidity: look at what the pool really holds.
  const wethIsToken0 = WETH.toLowerCase() < token.toLowerCase(); // Uniswap sorts pair tokens by address
  const details: PoolInfo[] = await Promise.all(
    candidates.map(async (c): Promise<PoolInfo> => {
      if ('fee' in c) {
        const [balance, liquidity] = await Promise.all([
          settle(client.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [c.pool] })),
          settle(client.readContract({ address: c.pool, abi: v3PoolAbi, functionName: 'liquidity' })),
        ]);
        return {
          label: c.label,
          pool: c.pool,
          kind: 'v3',
          weth: balance.ok ? balance.value : undefined,
          active: liquidity.ok ? liquidity.value > 0n : undefined,
        };
      }
      const reserves = await settle(
        client.readContract({ address: c.pool, abi: v2PairAbi, functionName: 'getReserves' }),
      );
      return {
        label: c.label,
        pool: c.pool,
        kind: 'v2',
        weth: reserves.ok ? reserves.value[wethIsToken0 ? 0 : 1] : undefined,
      };
    }),
  );

  return {
    v2: found(pair) !== undefined,
    v3Fees: candidates.flatMap((c) => ('fee' in c ? [c.fee] : [])),
    pools: candidates.map((c) => c.pool),
    details,
    funded: details.some(isFunded),
    complete:
      [pair, ...pools].every((result) => result.ok) &&
      details.every((d) => d.weth !== undefined && (d.kind === 'v2' || d.active !== undefined)),
  };
}

/** The funded pool holding the most WETH, if any. */
export function bestFundedPool(liquidity: RiskReport['liquidity']): Address | undefined {
  return liquidity.details
    .filter(isFunded)
    .sort((a, b) => Number((b.weth ?? 0n) - (a.weth ?? 0n)))[0]?.pool;
}

async function readOwner(client: PublicClient, address: Address): Promise<OwnerStatus> {
  const result = await settle(
    client.readContract({ address, abi: probeAbi, functionName: 'owner' }),
  );
  if (result.ok) return classifyOwner(result.value);
  // A revert / empty answer = no owner() function; anything else = we simply don't know.
  return classifyRpcError(result.error) === 'transient' ? { kind: 'unknown' } : { kind: 'none' };
}

/** Best-effort risk probe. Returns `undefined` when the address has no code. */
export async function readRisk(
  client: PublicClient,
  address: Address,
): Promise<RiskReport | undefined> {
  const code = await attempt(client.getCode({ address }));
  if (!code || code === '0x') return undefined;

  const { proxy, implementation } = await resolveImplementation(client, address, code);
  const [logicCode, decimals, owner, liquidity] = await Promise.all([
    implementation ? settle(client.getCode({ address: implementation })) : { ok: true as const, value: code },
    attempt(client.readContract({ address, abi: probeAbi, functionName: 'decimals' })),
    readOwner(client, address),
    readLiquidity(client, address),
  ]);

  return {
    decimals,
    owner,
    proxy,
    capabilities: logicCode.ok ? scanBytecode(logicCode.value) : undefined,
    liquidity,
  };
}


export function formatRisk(risk: RiskReport): string[] {
  const owner = (() => {
    switch (risk.owner.kind) {
      case 'address':
        return `${risk.owner.address} (can still act)`;
      case 'renounced':
        return 'renounced';
      case 'unknown':
        return 'unknown (RPC error)';
      case 'none':
        return 'no owner() function';
    }
  })();

  const amount = (d: PoolInfo): string => {
    const { weth } = d;
    if (weth === undefined) return 'balance unknown';
    // A V3 position can sit entirely on the token side: no WETH yet it can be traded.
    if (weth === 0n) return d.kind === 'v3' ? 'no WETH, token-side positions possible' : 'created, empty';
    if (weth < MIN_FUNDED_WETH) return `${formatEther(weth)} WETH, dust`;
    const shown = `${Number(formatEther(weth)).toFixed(2)} WETH`;
    return isFunded(d) ? shown : `${shown}, no active liquidity`;
  };
  const pools = risk.liquidity.details.map((d) => `${d.label} (${amount(d)})`);
  const liquidity = (() => {
    if (!risk.liquidity.complete) {
      return pools.length ? `${pools.join(', ')} (some lookups failed)` : 'unknown (RPC error)';
    }
    return pools.length ? pools.join(', ') : 'none yet';
  })();

  const flags = risk.capabilities
    ? risk.capabilities.length
      ? risk.capabilities.join(', ')
      : 'none detected'
    : 'unknown (bytecode unreadable)';

  return [
    `Decimals: ${risk.decimals ?? 'unknown'}`,
    `Owner: ${owner}`,
    `Proxy: ${risk.proxy ?? 'no'}`,
    `Flags: ${flags}`,
    `Liquidity (vs WETH): ${liquidity}`,
  ];
}
