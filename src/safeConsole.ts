import { describeError, redactUrls } from './errors.js';

type Logger = (...args: unknown[]) => void;

const isEventLike = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string' &&
  'defaultPrevented' in value;

/**
 * viem logs reconnect failures itself (`setup().catch(console.error)`), outside our error
 * handling. Route those through the same scrubbing: strings lose any URL (API keys live in
 * them), and Errors / socket ErrorEvents collapse to one safe line instead of a raw object dump
 * printed on every reconnect attempt.
 */
export function makeSafeLogger(log: Logger): Logger {
  return (...args) =>
    log(
      ...args.map((arg) => {
        if (typeof arg === 'string') return redactUrls(arg);
        if (arg instanceof Error || isEventLike(arg)) return describeError(arg);
        return arg;
      }),
    );
}

export function installSafeConsole(target: Pick<Console, 'error' | 'warn'> = console): void {
  target.error = makeSafeLogger(target.error.bind(target));
  target.warn = makeSafeLogger(target.warn.bind(target));
}
