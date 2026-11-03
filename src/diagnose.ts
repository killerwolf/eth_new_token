import { describeError, oneLine } from './errors.js';

type FetchFn = typeof fetch;

export type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'http-error'; status: number; reason: string }
  | { kind: 'network-error'; reason: string };

/**
 * Node's built-in WebSocket client (v22+) reports a failed handshake as an empty "error" event:
 * no HTTP status, no reason. The HTTPS twin of the same endpoint does explain itself
 * ("401 invalid project id"), so ask it.
 */
export function httpCandidates(wsUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return [];
  }
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : undefined;
  if (!protocol) return [];

  const same = new URL(url);
  same.protocol = protocol;
  const candidates = [same.toString()];

  // Infura: wss://host/ws/v3/<key>  <->  https://host/v3/<key>
  if (/\/ws(\/|$)/.test(url.pathname)) {
    const withoutWs = new URL(same);
    withoutWs.pathname = url.pathname.replace(/\/ws(\/|$)/, '$1');
    candidates.push(withoutWs.toString());
  }
  return [...new Set(candidates)];
}

export async function probeHttp(url: string, fetchFn: FetchFn = fetch): Promise<ProbeResult> {
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text();
    if (response.ok) {
      try {
        if (typeof (JSON.parse(body) as { result?: unknown }).result === 'string') return { kind: 'ok' };
      } catch {
        // fall through: a 200 that is not JSON-RPC
      }
    }
    return { kind: 'http-error', status: response.status, reason: oneLine(body) };
  } catch (error) {
    return { kind: 'network-error', reason: describeError(error) };
  }
}

/** Human-readable explanation of why a WebSocket endpoint cannot be used. Never includes the URL. */
export async function diagnoseWebSocket(wsUrl: string, fetchFn: FetchFn = fetch): Promise<string[]> {
  const candidates = httpCandidates(wsUrl);
  if (candidates.length === 0) return [];

  const results: ProbeResult[] = [];
  for (const candidate of candidates) {
    const result = await probeHttp(candidate, fetchFn);
    if (result.kind === 'ok') {
      return [
        'The HTTPS twin of this endpoint answers, so the key and provider are fine: the WebSocket',
        'itself is being refused. Check the WebSocket path (Infura needs the /ws/v3/<key> path),',
        'a firewall / VPN / proxy blocking WebSockets, or an allowlist on the key. As a workaround,',
        'set ETH_RPC_URL to the https:// URL (the scanner then polls every ~6 s).',
      ];
    }
    results.push(result);
  }

  // Prefer the most informative failure: an HTTP answer that is not a plain 404 (the "wrong path"
  // guess for the second candidate), else whatever came back.
  const decisive =
    results.find((r) => r.kind === 'http-error' && r.status !== 404) ??
    results.find((r) => r.kind === 'http-error') ??
    results[0];
  if (!decisive || decisive.kind === 'ok') return [];

  if (decisive.kind === 'network-error') {
    return [`Could not reach the provider over HTTPS either: ${decisive.reason}. Check your network, DNS and VPN.`];
  }
  const lines = [`The provider answers over HTTPS with ${decisive.status}: ${decisive.reason || '(no body)'}`];
  if (decisive.status === 401 || decisive.status === 403) {
    lines.push('That means the API key in ETH_RPC_URL is invalid, revoked, or restricted: check it in your provider dashboard.');
  } else if (decisive.status === 404) {
    lines.push('That usually means the URL path is wrong for this provider.');
  } else if (decisive.status === 429) {
    lines.push('That means the provider is rate limiting this key.');
  }
  return lines;
}
