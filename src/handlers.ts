import { getAddress, type Address } from 'viem';
import type { TokenInfo } from './report.js';
import { SeenSet } from './seen.js';

export interface Deps {
  readTotalSupply(address: Address): Promise<bigint | undefined>;
  readTokenInfo(address: Address): Promise<TokenInfo | undefined>;
  announce(token: TokenInfo, holder?: Address): void;
  seen: SeenSet<Address>;
}

/** `ContractCreated(address indexed)` — announce the new contract if it behaves like an ERC-20. */
export async function onContractCreated(deps: Deps, created: Address): Promise<void> {
  const address = getAddress(created);
  if (!deps.seen.add(address)) return;
  if ((await deps.readTotalSupply(address)) === undefined) return;

  const token = await deps.readTokenInfo(address);
  if (token) deps.announce(token);
}

/**
 * `Transfer(0x0 -> to, value)` — a token is "new" when its very first mint equals the
 * whole supply. Cheapest checks first: every extra RPC call counts against Infura quota.
 */
export async function onMint(
  deps: Deps,
  mint: { token: Address; to: Address; value: bigint },
): Promise<void> {
  if (mint.value === 0n) return;
  const address = getAddress(mint.token);
  if (!deps.seen.add(address)) return;

  const totalSupply = await deps.readTotalSupply(address);
  if (totalSupply !== mint.value) return;

  const token = await deps.readTokenInfo(address);
  if (token) deps.announce(token, mint.to);
}
