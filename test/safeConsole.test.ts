import { describe, expect, it, vi } from 'vitest';
import { SocketClosedError } from 'viem';
import { installSafeConsole, makeSafeLogger } from '../src/safeConsole.js';

describe('makeSafeLogger', () => {
  it('redacts URLs in strings', () => {
    const log = vi.fn();
    makeSafeLogger(log)('connect to wss://x.example/ws/v3/SECRETKEY123 failed');
    expect(log).toHaveBeenCalledWith('connect to <url> failed');
  });

  it('collapses viem errors that embed the URL to one safe line', () => {
    const log = vi.fn();
    const error = new SocketClosedError({ url: 'wss://x.example/ws/v3/SECRETKEY123' });
    makeSafeLogger(log)(error);
    const [line] = log.mock.calls[0] as [string];
    expect(line).not.toContain('SECRETKEY123');
    expect(line).toBe('The socket has been closed.');
  });

  it('collapses socket ErrorEvents instead of dumping the object', () => {
    const log = vi.fn();
    makeSafeLogger(log)({ type: 'error', defaultPrevented: false, cancelable: false, timeStamp: 1 });
    expect(log).toHaveBeenCalledWith('error event');
  });

  it('passes other values through untouched', () => {
    const log = vi.fn();
    const data = { a: 1 };
    makeSafeLogger(log)('n=', 3, data);
    expect(log).toHaveBeenCalledWith('n=', 3, data);
  });
});

describe('installSafeConsole', () => {
  it('patches error and warn on the target', () => {
    const error = vi.fn();
    const warn = vi.fn();
    const target = { error, warn } as unknown as Console;
    installSafeConsole(target);
    target.error('x https://k.example/SECRETKEY123');
    target.warn('y wss://k.example/SECRETKEY123');
    expect(error).toHaveBeenCalledWith('x <url>');
    expect(warn).toHaveBeenCalledWith('y <url>');
  });
});
