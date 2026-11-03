import { getAddress, type Address } from 'viem';
import type { ReportExtras, TokenInfo } from './report.js';
import type { RiskReport } from './risk.js';
import { SeenSet } from './seen.js';

export interface Deps {
  /** `undefined` = definitively not an ERC-20. Throws on provider failure (retryable). */
  readTotalSupply(address: Address): Promise<bigint | undefined>;
  readTokenInfo(address: Address): Promise<TokenInfo | undefined>;
  /** Best-effort risk probe; must not throw. */
  readRisk(address: Address): Promise<RiskReport | undefined>;
  announce(token: TokenInfo, extras: ReportExtras): void;
  /** A previously announced token has since got liquidity (see `followLiquidity`). */
  announceUpdate(token: TokenInfo, risk: RiskReport): void;
  /** Bounds how many tokens are being followed at once. */
  followUps: FollowUpBudget;
  /** Run `task` later (production: unref'd `setTimeout`). Injected so tests control time. */
  schedule(task: () => void, delayMs: number): void;
  /** Report a failure that has no caller to throw to (scheduled retries, giving up). */
  reportError(error: unknown): void;
  seen: SeenSet<Address>;
}

/**
 * Delays before the re-attempts that follow a transient provider failure: 1 try + 2 re-tries,
 * on top of the short in-read retries done by the ERC-20 readers. Bounded on purpose, so a
 * hostile token that spams events (or a long outage) can never cause a retry storm.
 */
export const RETRY_DELAYS_MS = [15_000, 60_000] as const;

/**
 * A brand-new token almost never has a pool at the moment it is detected, so its liquidity line
 * says "none yet". Re-check a few times and send an update once a pool appears: that is when the
 * token becomes tradable. Bounded in time (3 checks, ~30 min) and in number (`FollowUpBudget`).
 */
export const LIQUIDITY_RECHECK_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/** A counting semaphore: how many tokens are currently followed. */
export class FollowUpBudget {
  private active = 0;

  constructor(private readonly limit = 200) {}

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active++;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

export const scheduleLater = (task: () => void, delayMs: number): void => {
  setTimeout(task, delayMs).unref();
};

function followLiquidity(deps: Deps, token: TokenInfo, release: () => void, step = 0): void {
  const delay = LIQUIDITY_RECHECK_DELAYS_MS[step];
  if (delay === undefined) {
    release();
    return;
  }
  deps.schedule(() => {
    void (async () => {
      try {
        const risk = await deps.readRisk(token.address);
        if (risk?.liquidity.funded) {
          release(); // done either way: a failed announce is not retried (no duplicates)
          try {
            deps.announceUpdate(token, risk);
          } catch (error) {
            deps.reportError(error);
          }
          return;
        }
      } catch (error) {
        deps.reportError(error); // keep following: the next check may succeed
      }
      followLiquidity(deps, token, release, step + 1);
    })().catch((error: unknown) => {
      release(); // the chain is dead (e.g. the scheduler threw): do not keep the slot
      deps.reportError(error);
    }); // a scheduled task must never become an unhandled rejection
  }, delay);
}

/** Announce a token, then follow its liquidity if it had none yet. Never throws. */
function announceAndFollow(deps: Deps, token: TokenInfo, extras: ReportExtras): void {
  deps.announce(token, extras);
  if (extras.risk?.liquidity.funded) return; // already tradable (an empty pool is not)
  if (!deps.followUps.tryAcquire()) return;
  let released = false;
  // Idempotent, so one token can never free another token's slot by releasing twice.
  const release = (): void => {
    if (released) return;
    released = true;
    deps.followUps.release();
  };
  try {
    followLiquidity(deps, token, release);
  } catch (error) {
    release();
    deps.reportError(error);
  }
}

async function attempt(
  deps: Deps,
  address: Address,
  work: () => Promise<void>,
  failures: number,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const delay = RETRY_DELAYS_MS[failures];
    if (delay === undefined) {
      deps.reportError(new Error(`Giving up on ${address} after ${failures + 1} attempts`, { cause: error }));
    } else {
      deps.schedule(() => {
        attempt(deps, address, work, failures + 1).catch(deps.reportError);
      }, delay);
    }
    throw error;
  }
}

/**
 * Claim `address` so duplicate events are ignored — the claim is held through the whole retry
 * cycle (no parallel duplicates, no retry storm). A definitive outcome (announced, or judged
 * not-a-token) ends it; a transient provider failure schedules a bounded re-attempt, because
 * for a one-off event (ContractCreated, a token's first mint) no later event will come.
 */
async function once(deps: Deps, address: Address, work: () => Promise<void>): Promise<void> {
  if (!deps.seen.add(address)) return;
  await attempt(deps, address, work, 0);
}

/** `ContractCreated(address indexed)` — announce the new contract if it behaves like an ERC-20. */
export async function onContractCreated(deps: Deps, created: Address): Promise<void> {
  const address = getAddress(created);
  await once(deps, address, async () => {
    if ((await deps.readTotalSupply(address)) === undefined) return;

    const token = await deps.readTokenInfo(address);
    if (token) announceAndFollow(deps, token, { risk: await deps.readRisk(address) });
  });
}

/**
 * `Transfer(0x0 -> to, value)` — a token is "new" when its very first mint equals the
 * whole supply. Cheapest checks first: every extra RPC call counts against provider quota.
 */
export async function onMint(
  deps: Deps,
  mint: { token: Address; to: Address; value: bigint },
): Promise<void> {
  if (mint.value === 0n) return;
  const address = getAddress(mint.token);
  await once(deps, address, async () => {
    const totalSupply = await deps.readTotalSupply(address);
    if (totalSupply !== mint.value) return;

    const token = await deps.readTokenInfo(address);
    if (token) announceAndFollow(deps, token, { holder: mint.to, risk: await deps.readRisk(address) });
  });
}
