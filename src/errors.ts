import { BaseError } from 'viem';

/** URLs routinely carry provider API keys in their path or query: never let one reach a log. */
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi;

const secrets = new Set<string>();

/** Escape a string for use inside a RegExp. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Register a value that must never be printed, whatever shape it appears in (provider error
 * messages may echo a bare API key without any URL around it). Values under 8 characters are
 * ignored: they would redact ordinary words.
 */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Test helper: forget every registered secret. */
export function clearSecrets(): void {
  secrets.clear();
}

/**
 * API keys are long, or mix letters and digits. Plain words that happen to sit in a URL
 * ("ethereum", "webhooks", "mainnet") must not be registered or provider messages like
 * "method not supported on ethereum" would be mangled.
 */
const looksLikeKey = (value: string): boolean =>
  value.length >= 16 || (value.length >= 8 && /\d/.test(value) && /[a-z]/i.test(value));

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // malformed percent sequence: keep the raw form
  }
};

/** Register the secret parts of a URL: userinfo, key-like path segments and query values. */
export function addSecretsFromUrl(rawUrl: string | undefined): void {
  if (!rawUrl) return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return; // Not a URL: nothing to register.
  }
  // Each value on its own, raw and decoded, so one odd segment never skips the rest.
  const register = (value: string, filter: (v: string) => boolean) => {
    for (const form of new Set([value, safeDecode(value)])) if (filter(form)) addSecret(form);
  };
  const any = () => true;
  if (url.password) register(url.password, any);
  if (url.username) register(url.username, any);
  for (const segment of url.pathname.split('/')) if (segment) register(segment, looksLikeKey);
  for (const value of url.searchParams.values()) register(value, looksLikeKey);
}

export function redactUrls(text: string): string {
  let result = text.replace(URL_PATTERN, '<url>');
  // Longest first, so a secret that contains another one is never left half-visible.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of ordered) result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '<redacted>');
  return result;
}

const MAX_DETAILS_LENGTH = 200;

/** Control characters and line breaks become single spaces: one message, one log line. */
const flatten = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Provider-supplied text is untrusted and unbounded (an HTML error page can be megabytes):
 * redact first, so a secret is never cut in half and left partly visible, then flatten
 * control characters / newlines and cap the length.
 */
function oneLine(text: string, max = MAX_DETAILS_LENGTH): string {
  const flat = flatten(redactUrls(text));
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
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
    const details = error.details && error.details !== error.shortMessage ? `: ${oneLine(error.details)}` : '';
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
  // viem's own short messages contain line breaks too, so flatten the whole thing.
  return flatten(redactUrls(message));
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
