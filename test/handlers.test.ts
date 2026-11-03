import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import {
  FollowUpBudget,
  LIQUIDITY_RECHECK_DELAYS_MS,
  onContractCreated,
  onMint,
  RETRY_DELAYS_MS,
  type Deps,
} from '../src/handlers.js';
import type { RiskReport } from '../src/risk.js';
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
    announceUpdate: vi.fn(),
    followUps: new FollowUpBudget(),
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

describe('liquidity follow-up', () => {
  const POOL = '0x00000000000000000000000000000000000000d2' as Address;
  type State = 'none' | 'empty' | 'funded';
  const liquidity = (state: State): RiskReport => ({
    decimals: 18,
    owner: { kind: 'renounced' },
    proxy: undefined,
    capabilities: [],
    liquidity: {
      v2: state !== 'none',
      v3Fees: [],
      pools: state === 'none' ? [] : [POOL],
      details: state === 'none' ? [] : [{ label: 'Uniswap V2', pool: POOL, weth: state === 'funded' ? 10n ** 18n : 0n }],
      funded: state === 'funded',
      complete: true,
    },
  });
  const mint = { token: TOKEN, to: HOLDER, value: 1000n };

  /** Run the next scheduled task and let its async work finish. */
  const tick = async (deps: ReturnType<typeof makeDeps>) => {
    deps.due.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const states = (...seq: State[]) => {
    const fn = vi.fn();
    seq.forEach((state) => fn.mockResolvedValueOnce(liquidity(state)));
    return fn.mockResolvedValue(liquidity(seq.at(-1) ?? 'none'));
  };

  it('sends an update, once, when a pool gets funded later, then stops following', async () => {
    const deps = makeDeps({ readRisk: states('none', 'none', 'funded') });
    await onMint(deps, mint);
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.due).toHaveLength(1);

    await tick(deps); // still nothing -> schedules the next check
    expect(deps.announceUpdate).not.toHaveBeenCalled();
    expect(deps.due).toHaveLength(1);

    await tick(deps); // funded
    expect(deps.announceUpdate).toHaveBeenCalledTimes(1);
    expect(deps.announceUpdate).toHaveBeenCalledWith(info, liquidity('funded'));
    expect(deps.due).toHaveLength(0);
  });

  it('a pool created empty (e.g. by the constructor) does NOT end the follow-up nor count as liquidity', async () => {
    const deps = makeDeps({ readRisk: states('empty', 'empty', 'funded') });
    await onMint(deps, mint);
    expect(deps.due).toHaveLength(1); // not skipped as "already tradable"

    await tick(deps); // pool exists but is empty: no update, keep following
    expect(deps.announceUpdate).not.toHaveBeenCalled();
    expect(deps.due).toHaveLength(1);

    await tick(deps); // liquidity actually added
    expect(deps.announceUpdate).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly after the last re-check, with an empty pool too', async () => {
    const deps = makeDeps({ readRisk: states('empty') });
    await onMint(deps, mint);
    for (let i = 0; i < LIQUIDITY_RECHECK_DELAYS_MS.length; i++) await tick(deps);
    expect(deps.announceUpdate).not.toHaveBeenCalled();
    expect(deps.due).toHaveLength(0);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('does not follow a token that is already funded at announce time', async () => {
    const deps = makeDeps({ readRisk: states('funded') });
    await onMint(deps, mint);
    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.due).toHaveLength(0);
  });

  it('keeps following after a failed re-check, and reports the failure', async () => {
    const readRisk = vi
      .fn()
      .mockResolvedValueOnce(liquidity('none'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(liquidity('funded'));
    const deps = makeDeps({ readRisk });
    await onMint(deps, mint);
    await tick(deps);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.due).toHaveLength(1);
    await tick(deps);
    expect(deps.announceUpdate).toHaveBeenCalledTimes(1);
  });

  it('a failing announceUpdate is reported and never produces a duplicate update', async () => {
    const announceUpdate = vi.fn(() => {
      throw new Error('sink down');
    });
    const deps = makeDeps({ readRisk: states('none', 'funded'), announceUpdate });
    await onMint(deps, mint);
    await tick(deps);
    expect(announceUpdate).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.due).toHaveLength(0); // no retry that would announce twice
  });

  it('is bounded: no follow-up is scheduled once the budget is spent', async () => {
    const deps = makeDeps({ readRisk: states('none'), followUps: new FollowUpBudget(1) });
    await onMint(deps, mint);
    await onMint(deps, { ...mint, token: '0x00000000000000000000000000000000000000ab' as Address });
    expect(deps.announce).toHaveBeenCalledTimes(2);
    expect(deps.due).toHaveLength(1); // only the first token is followed
  });

  it('frees its slot when it finishes, so later tokens can be followed', async () => {
    const budget = new FollowUpBudget(1);
    const deps = makeDeps({ readRisk: states('none'), followUps: budget });
    await onMint(deps, mint);
    for (let i = 0; i < LIQUIDITY_RECHECK_DELAYS_MS.length; i++) await tick(deps);
    expect(budget.tryAcquire()).toBe(true);
  });

  it('frees its slot when the update is sent', async () => {
    const budget = new FollowUpBudget(1);
    const deps = makeDeps({ readRisk: states('none', 'funded'), followUps: budget });
    await onMint(deps, mint);
    await tick(deps);
    expect(budget.tryAcquire()).toBe(true);
  });

  it('follows tokens found through ContractCreated too', async () => {
    const deps = makeDeps({ readRisk: states('none') });
    await onContractCreated(deps, TOKEN);
    expect(deps.due).toHaveLength(1);
  });
});
