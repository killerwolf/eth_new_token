import { inspect } from 'node:util';
import { formatErrorForLog, redactUrls } from './errors.js';

type Logger = (...args: unknown[]) => void;

/**
 * Socket ErrorEvents: undici's (Node >= 22) and the `ws` package's (Node 20) differ in shape,
 * so match on the class name rather than on any particular property.
 */
const isEvent = (value: object): boolean => /Event$/.test(value.constructor?.name ?? '');

function scrub(arg: unknown): unknown {
  if (typeof arg === 'string') return redactUrls(arg);
  if (typeof arg !== 'object' || arg === null) return arg;

  if (arg instanceof Error) return formatErrorForLog(arg);
  if (isEvent(arg)) {
    const { type } = arg as { type?: unknown };
    return typeof type === 'string' ? `${type} event` : 'event';
  }
  // Any other object: leave it alone unless printing it would reveal a URL (e.g. a `_url` field).
  const printed = inspect(arg, { depth: 4 });
  const scrubbed = redactUrls(printed);
  return scrubbed === printed ? arg : scrubbed;
}

/**
 * viem logs reconnect failures itself (`setup().catch(console.error)`), outside our error
 * handling. Route those through the same scrubbing so API keys in URLs never reach the output,
 * and socket ErrorEvents collapse to one line instead of a raw object dump on every attempt.
 */
/** Logging must never throw (a hostile Proxy or throwing inspect hook would skip our exit paths). */
function safeScrub(arg: unknown): unknown {
  try {
    return scrub(arg);
  } catch {
    return '[unprintable]';
  }
}

export function makeSafeLogger(log: Logger): Logger {
  return (...args) => log(...args.map(safeScrub));
}

export function installSafeConsole(target: Pick<Console, 'error' | 'warn'> = console): void {
  target.error = makeSafeLogger(target.error.bind(target));
  target.warn = makeSafeLogger(target.warn.bind(target));
}
