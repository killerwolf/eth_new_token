import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { onContractCreated, onMint, RETRY_DELAYS_MS, type Deps } from '../src/handlers.js';
import { SeenSet } from '../src/seen.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const HOLDER = '0x00000000000000000000000000000000000000bb' as Address;
const info = { address: TOKEN, name: 'Pepe', symbol: 'PEPE' };

/** Deps whose scheduler records tasks instead of sleeping, so tests drive time by hand. */
const makeDeps = (overrides: Partial<Deps> = {}): Deps & { due: Array<() => void> } => {
  const due: Array<() => void> = [];
  return {
    due,
    schedule: (task) => {
      due.push(task);
    },
    reportError: vi.fn(),
    ...baseDeps(),
    ...overrides,
  };
};

const baseDeps = (): Pick<Deps, 'readTotalSupply' | 'readTokenInfo' | 'readRisk' | 'announce' | 'seen'> => ({
  readTotalSupply: vi.fn().mockResolvedValue(1000n),
  readTokenInfo: vi.fn().mockResolvedValue(info),
  readRisk: vi.fn().mockResolvedValue(undefined),
  announce: vi.fn(),
  seen: new SeenSet(),
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

  it('does not hide a token after a transient RPC failure: a scheduled re-attempt announces it', async () => {
    const deps = makeDeps({
      readTotalSupply: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValue(1000n),
    });
    await expect(onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n })).rejects.toThrow('provider down');
    expect(deps.announce).not.toHaveBeenCalled();
    expect(deps.due).toHaveLength(1);

    deps.due.shift()?.();
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledTimes(1));
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('holds the claim while a retry is pending, so events cannot announce it twice', async () => {
    const deps = makeDeps({
      readTotalSupply: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(1000n),
    });
    await expect(onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n })).rejects.toThrow();
    await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n }); // another event, mid-retry
    expect(deps.readTotalSupply).toHaveBeenCalledTimes(1);

    deps.due.shift()?.();
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledTimes(1));
  });

  it('gives up after a bounded number of attempts (no retry storm from a hostile token)', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockRejectedValue(new Error('always failing')) });
    await expect(onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n })).rejects.toThrow();
    for (const _ of RETRY_DELAYS_MS) {
      deps.due.shift()?.();
      await vi.waitFor(() => expect(deps.reportError).toHaveBeenCalled());
    }
    await vi.waitFor(() =>
      expect(deps.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Giving up') })),
    );
    expect(deps.due).toHaveLength(0);

    // Flood of events for the same token: nothing more is attempted.
    const reads = vi.mocked(deps.readTotalSupply).mock.calls.length;
    for (let i = 0; i < 20; i++) await onMint(deps, { token: TOKEN, to: HOLDER, value: 1000n });
    expect(deps.readTotalSupply).toHaveBeenCalledTimes(reads);
    expect(reads).toBe(1 + RETRY_DELAYS_MS.length);
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

  it('re-attempts after a transient failure even though no later event will come', async () => {
    const deps = makeDeps({
      readTokenInfo: vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(info),
    });
    await expect(onContractCreated(deps, TOKEN)).rejects.toThrow('blip');
    deps.due.shift()?.();
    await vi.waitFor(() => expect(deps.announce).toHaveBeenCalledTimes(1));
  });

  it('stays quiet for non-token contracts', async () => {
    const deps = makeDeps({ readTotalSupply: vi.fn().mockResolvedValue(undefined) });
    await onContractCreated(deps, TOKEN);
    expect(deps.readTokenInfo).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
  });
});
