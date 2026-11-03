import { BaseError } from 'viem';

/** URLs routinely carry provider API keys in their path or query: never let one reach a log. */
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi;

const secrets = new Set<string>();

/** Escape a string for use inside a RegExp. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Register a value that must never be printed, whatever shape it appears in (provider error
 * messages may echo a bare API key without any URL around it). Short values are ignored: they
 * would redact ordinary words.
 */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Register the secret parts of a URL: userinfo, long path segments and query values. */
export function addSecretsFromUrl(rawUrl: string | undefined): void {
  if (!rawUrl) return;
  try {
    const url = new URL(rawUrl);
    addSecret(decodeURIComponent(url.password));
    addSecret(decodeURIComponent(url.username));
    for (const segment of url.pathname.split('/')) addSecret(decodeURIComponent(segment));
    for (const value of url.searchParams.values()) addSecret(value);
  } catch {
    // Not a URL: nothing to register.
  }
}

export function redactUrls(text: string): string {
  let result = text.replace(URL_PATTERN, '<url>');
  for (const secret of secrets) result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '<redacted>');
  return result;
}

/** Network error code (ENOTFOUND, ECONNREFUSED, …) buried in a cause chain, if any. */
function networkCode(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Safe, single-line description of anything thrown. viem's `message` appends the request URL
 * and body, so use its `shortMessage`; everything is then scrubbed of URLs as a second layer.
 */
export function describeError(error: unknown): string {
  let message: string;
  if (error instanceof BaseError) {
    // `details` carries the provider's own reason (e.g. "Please specify an address…"), which is
    // what makes a misbehaving endpoint diagnosable. It is scrubbed below like everything else.
    const details = error.details && error.details !== error.shortMessage ? `: ${error.details}` : '';
    const code = networkCode(error);
    message = `${error.shortMessage}${details}${code ? ` [${code}]` : ''}`;
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
