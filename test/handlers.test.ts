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

  it('ignores zero-value transfers without touching the RPC', async () => {
    const deps = makeDeps();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 0n });
    expect(deps.readTotalSupply).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it('ignores partial mints (one supply read, no metadata read)', async () => {
    const deps = makeDeps();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 999n });
    expect(deps.announce).not.toHaveBeenCalled();
    expect(deps.readTotalSupply).toHaveBeenCalledTimes(1);
    expect(deps.readTokenInfo).not.toHaveBeenCalled();
  });

  it('does not hide a token after a transient RPC failure: the next event retries it', async () => {
    const deps = makeDeps({
      readTotalSupply: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValue(1000n),
    });
    await expect(onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n })).rejects.toThrow('provider down');
    expect(deps.announce).not.toHaveBeenCalled();

    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('keeps a definitive "not a token" verdict (no repeated RPC work)', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockResolvedValue(undefined) });
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.readTotalSupply).toHaveBeenCalledTimes(1);
  });

  it('ignores a concurrent duplicate event while the first is in flight', async () => {
    const deps = makeDeps();
    await Promise.all([
      onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n }),
      onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n }),
    ]);
    expect(deps.announce).toHaveBeenCalledTimes(1);
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

  it('releases the claim after a transient failure so a later event can retry', async () => {
    const deps = makeDeps({
      readTokenInfo: vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(info),
    });
    await expect(onContractCreated(deps, TOKEN)).rejects.toThrow('blip');
    await onContractCreated(deps, TOKEN);
    expect(deps.announce).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for non-token contracts', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockResolvedValue(undefined) });
    await onContractCreated(deps, TOKEN);
    expect(deps.readTokenInfo).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });
});
