import { BaseError } from 'viem';

/** URLs routinely carry provider API keys in their path or query: never let one reach a log. */
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi;

export const redactUrls = (text: string): string => text.replace(URL_PATTERN, '<url>');

/**
 * Safe, single-line description of anything thrown. viem's `message` appends the request URL
 * and body, so use its `shortMessage`; everything is then scrubbed of URLs as a second layer.
 */
export function describeError(error: unknown): string {
  let message: string;
  if (error instanceof BaseError) {
    message = error.shortMessage;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'object' && error !== null) {
    const { message: m, type } = error as { message?: unknown; type?: unknown };
    // Browser-style ErrorEvents from the socket carry a `type`, not an Error.
    message = typeof m === 'string' && m ? m : typeof type === 'string' ? `${type} event` : String(error);
  } else {
    message = String(error);
  }
  return redactUrls(message);
}

export type RpcErrorKind =
  /** The call ran and the contract/ABI said no: a real answer ("not a token"). */
  | 'definitive'
  /** `eth_call` returned `0x`: no code at that block on that node (not deployed, or the node lags). */
  | 'zero-data'
  /** Transport, timeout, rate limit, provider hiccup: says nothing about the contract. */
  | 'transient';

const ZERO_DATA = new Set(['ContractFunctionZeroDataError', 'AbiDecodingZeroDataError']);
/**
 * Deterministic answers from the contract: a revert, or return data that does not decode as the
 * requested type (e.g. a legacy bytes32 `name()` read as `string` raises IntegerOutOfRangeError).
 * Retrying cannot change them.
 */
const DEFINITIVE = /Decoding|OutOfRange|OutOfBounds|SizeOverflow|InvalidBytesBoolean|RecursiveReadLimit/;

export function classifyRpcError(error: unknown): RpcErrorKind {
  const names: string[] = [];
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 10; depth++) {
    names.push(cause.name);
    cause = (cause as { cause?: unknown }).cause;
  }
  if (names.some((name) => ZERO_DATA.has(name))) return 'zero-data';
  if (names.some((name) => DEFINITIVE.test(name))) return 'definitive';
  // viem wraps ANY JSON-RPC -32603 "Internal error" in ContractFunctionRevertedError too, so that
  // name alone proves nothing: a real revert carries ExecutionRevertedError (code 3 / "execution
  // reverted"), while a flaky provider carries InternalRpcError.
  if (names.includes('ExecutionRevertedError')) return 'definitive';
  if (names.includes('ContractFunctionRevertedError') && !names.includes('InternalRpcError')) {
    return 'definitive';
  }
  return 'transient';
}

/**
 * Like `describeError`, but for *unexpected* failures (bugs, not provider errors): keeps the
 * stack so they stay debuggable, still scrubbed of URLs.
 */
export function formatErrorForLog(error: unknown): string {
  if (error instanceof Error && !(error instanceof BaseError) && !(error instanceof TransientRpcError)) {
    return redactUrls(error.stack ?? error.message);
  }
  return describeError(error);
}

/** Thrown when an RPC read kept failing for reasons unrelated to the contract being probed. */
export class TransientRpcError extends Error {
  constructor(cause: unknown) {
    super(describeError(cause), { cause });
    this.name = 'TransientRpcError';
  }
}
