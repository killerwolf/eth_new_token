import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { onContractCreated, onMint, type Deps } from '../src/handlers.js';
import { SeenSet } from '../src/seen.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const HOLDER = '0x00000000000000000000000000000000000000bb' as Address;
const info = { address: TOKEN, name: 'Pepe', symbol: 'PEPE' };

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  readTotalSupply: vi.fn().mockResolvedValue(1000n),
  readTokenInfo: vi.fn().mockResolvedValue(info),
  readRisk: vi.fn().mockResolvedValue(undefined),
  announce: vi.fn(),
  seen: new SeenSet(),
  ...overrides,
});

describe('onMint', () => {
  it('announces when the first mint equals total supply', async () => {
    const deps = makeDeps();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.announce).toHaveBeenCalledWith(info, { holder: HOLDER, risk: undefined });
  });

  it('ignores partial mints and zero-value transfers without touching the RPC', async () => {
    const deps = makeDeps();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 999n });
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 0n });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(deps.readTotalSupply).toHaveBeenCalledTimes(1);
  });

  it('announces each token only once', async () => {
    const deps = makeDeps();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('skips contracts that are not readable ERC-20s', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockResolvedValue(undefined) });
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.announce).not.toHaveBeenCalled();
  });
});

describe('onContractCreated', () => {
  it('announces contracts that answer totalSupply()', async () => {
    const deps = makeDeps();
    await onContractCreated(deps, TOKEN);
    expect(deps.announce).toHaveBeenCalledWith(info, { risk: undefined });
  });

  it('stays quiet for non-token contracts', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockResolvedValue(undefined) });
    await onContractCreated(deps, TOKEN);
    expect(deps.readTokenInfo).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });
});
