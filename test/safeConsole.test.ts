import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { SocketClosedError } from 'viem';
import { createServer } from 'node:http';
import WebSocket from 'ws';
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
    makeSafeLogger(log)(new Event('error'));
    expect(log).toHaveBeenCalledWith('error event');
  });

  it('does not leak the URL held by a real `ws` ErrorEvent (the Node 20 transport)', async () => {
    const socket = new WebSocket('ws://127.0.0.1:9/ws/v3/SECRETKEY123');
    const event = await new Promise<unknown>((resolve) => {
      socket.onerror = resolve;
    });
    // Guard the premise: the raw event really does carry the secret URL.
    expect(inspect(event, { depth: 4 })).toContain('SECRETKEY123');

    const log = vi.fn();
    makeSafeLogger(log)(event);
    expect(inspect(log.mock.calls, { depth: 6 })).not.toContain('SECRETKEY123');
  });

  it('keeps the reason a `ws` ErrorEvent carries (e.g. the handshake HTTP status)', async () => {
    const server = createServer((_, res) => res.writeHead(200).end());
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/v3/SECRETKEY123`);
    const event = await new Promise<unknown>((resolve) => {
      socket.onerror = resolve;
    });
    server.close();

    const log = vi.fn();
    makeSafeLogger(log)(event);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(inspect(log.mock.calls)).not.toContain('SECRETKEY123');
  });

  it('scrubs a URL hidden in an arbitrary object, but leaves clean objects as they are', () => {
    const log = vi.fn();
    const clean = { a: 1 };
    makeSafeLogger(log)({ _url: 'wss://x.example/ws/SECRETKEY123' }, clean);
    const [first, second] = log.mock.calls[0] as [unknown, unknown];
    expect(typeof first).toBe('string'); // collapsed to scrubbed text, not passed through as an object
    expect(first).not.toContain('SECRETKEY123');
    expect(second).toBe(clean);
  });

  it('keeps the stack of genuine bugs while scrubbing URLs', () => {
    const log = vi.fn();
    makeSafeLogger(log)(new TypeError('boom https://x.example/SECRETKEY123'));
    const [text] = log.mock.calls[0] as [string];
    expect(text).toContain('TypeError: boom <url>');
    expect(text).toContain('safeConsole.test.ts');
  });

  it('never throws, even for hostile objects', () => {
    const log = vi.fn();
    const hostileProxy = new Proxy({}, { get: () => { throw new Error('trap'); }, getPrototypeOf: () => { throw new Error('trap'); } });
    const hostileInspect = { [inspect.custom]: () => { throw new Error('inspect'); } };
    expect(() => makeSafeLogger(log)(hostileProxy, hostileInspect, 'ok')).not.toThrow();
    expect(log).toHaveBeenCalledWith('[unprintable]', '[unprintable]', 'ok');
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
