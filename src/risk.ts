import { classifyRpcError } from './errors.js';
import {
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
const v3FactoryAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)',
]);

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
  const exists = (result: Probe<Address>): boolean => result.ok && result.value !== zeroAddress;
  return {
    v2: exists(pair),
    v3Fees: V3_FEES.filter((_, i) => exists(pools[i] as Probe<Address>)),
    complete: [pair, ...pools].every((result) => result.ok),
  };
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

const FEE_LABEL: Record<number, string> = { 500: '0.05%', 3000: '0.3%', 10000: '1%' };

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

  const pools = [
    ...(risk.liquidity.v2 ? ['Uniswap V2'] : []),
    ...risk.liquidity.v3Fees.map((fee) => `Uniswap V3 ${FEE_LABEL[fee] ?? fee}`),
  ];
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
