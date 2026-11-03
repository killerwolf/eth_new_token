import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { redactUrls } from '../src/errors.js';
import { diagnoseWebSocket, httpCandidates, probeHttp } from '../src/diagnose.js';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A tiny fake provider: `routes` maps a path to [status, body]. */
async function provider(routes: Record<string, [number, string]>): Promise<string> {
  server = createServer((req, res) => {
    const [status, body] = routes[req.url ?? ''] ?? [404, '404 page not found'];
    res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server.address() as { port: number }).port}`;
}
const OK = [200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })] as [number, string];

describe('httpCandidates', () => {
  it('maps wss to https and also tries Infura-style paths without /ws', () => {
    expect(httpCandidates('wss://mainnet.infura.io/ws/v3/KEY')).toEqual([
      'https://mainnet.infura.io/ws/v3/KEY',
      'https://mainnet.infura.io/v3/KEY',
    ]);
    expect(httpCandidates('wss://eth-mainnet.g.alchemy.com/v2/KEY')).toEqual([
      'https://eth-mainnet.g.alchemy.com/v2/KEY',
    ]);
    expect(httpCandidates('ws://127.0.0.1:8546')).toEqual(['http://127.0.0.1:8546/']);
  });

  it('returns nothing for non-WebSocket or malformed URLs', () => {
    expect(httpCandidates('https://x.example')).toEqual([]);
    expect(httpCandidates('not a url')).toEqual([]);
  });
});

describe('probeHttp', () => {
  it('recognises a working endpoint', async () => {
    const host = await provider({ '/ok': OK });
    expect(await probeHttp(`http://${host}/ok`)).toEqual({ kind: 'ok' });
  });

  it('does not mistake a 200 that is not JSON-RPC (captive portal, HTML page) for a working endpoint', async () => {
    const host = await provider({ '/portal': [200, '<html>please sign in</html>'], '/empty': [200, '{"jsonrpc":"2.0","id":1}'] });
    expect((await probeHttp(`http://${host}/portal`)).kind).toBe('http-error');
    expect((await probeHttp(`http://${host}/empty`)).kind).toBe('http-error');
  });

  it('reports the HTTP status and the provider reason', async () => {
    const host = await provider({ '/v3/K': [401, 'invalid project id'] });
    expect(await probeHttp(`http://${host}/v3/K`)).toEqual({
      kind: 'http-error',
      status: 401,
      reason: 'invalid project id',
    });
  });

  it('caps and flattens a hostile body', async () => {
    const host = await provider({ '/x': [502, `<html>\n${'z'.repeat(5000)}`] });
    const result = await probeHttp(`http://${host}/x`);
    expect(result.kind === 'http-error' && result.reason.length).toBeLessThan(250);
    expect(result.kind === 'http-error' && result.reason).not.toContain('\n');
  });

  it('reports a network failure', async () => {
    const fetchFn = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
    }) as unknown as typeof fetch;
    const result = await probeHttp('http://nowhere.invalid', fetchFn);
    expect(result.kind).toBe('network-error');
  });
});

describe('diagnoseWebSocket', () => {
  it('points at the API key when the provider answers 401', async () => {
    const host = await provider({ '/v3/KEY': [401, 'invalid project id'] });
    const lines = await diagnoseWebSocket(`ws://${host}/ws/v3/KEY`);
    expect(lines.join('\n')).toContain('401: invalid project id');
    expect(lines.join('\n')).toMatch(/invalid, revoked, or restricted/);
  });

  it('says the key is fine when the HTTPS twin works, so the WebSocket itself is refused', async () => {
    const host = await provider({ '/v3/KEY': OK });
    const lines = (await diagnoseWebSocket(`ws://${host}/ws/v3/KEY`)).join('\n');
    expect(lines).toContain('key and provider are fine');
    expect(lines).toContain('ETH_RPC_URL to the https:// URL');
    // These hints go through the redacting console: they must survive it intact.
    expect(redactUrls(lines)).toBe(lines);
  });

  it('never prints the URL or the key', async () => {
    const host = await provider({ '/v3/AsDf1234SECRETKEY5678': [401, 'invalid project id'] });
    const lines = (await diagnoseWebSocket(`ws://${host}/ws/v3/AsDf1234SECRETKEY5678`)).join('\n');
    expect(lines).not.toContain('SECRETKEY5678');
    expect(lines).not.toContain(host);
  });

  it('prefers a real provider answer over the 404 of a wrong guessed path', async () => {
    const host = await provider({ '/ws/v3/KEY': [404, '404 page not found'], '/v3/KEY': [401, 'invalid project id'] });
    expect((await diagnoseWebSocket(`ws://${host}/ws/v3/KEY`)).join('\n')).toContain('401');
  });

  it('suggests a path fix on 404, and reports unreachable hosts', async () => {
    const host = await provider({});
    expect((await diagnoseWebSocket(`ws://${host}/oops`)).join('\n')).toContain('path is wrong');
    expect(await diagnoseWebSocket('https://x.example')).toEqual([]);
  });
});
