import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { redactUrls } from '../src/errors.js';

describe('loadConfig', () => {
  const WS = 'wss://eth-mainnet.example.com/v2/secret-key';

  it('still accepts the previous ETH_WS_URL name', () => {
    expect(loadConfig(['Transfer'], { ETH_WS_URL: WS }).rpcUrl).toBe(WS);
  });

  it('prefers ETH_RPC_URL over the legacy name', () => {
    const config = loadConfig(['Transfer'], { ETH_RPC_URL: 'http://a.example', ETH_WS_URL: WS });
    expect(config.rpcUrl).toBe('http://a.example');
  });

  it('falls back to the legacy name when ETH_RPC_URL is present but blank', () => {
    expect(loadConfig(['Transfer'], { ETH_RPC_URL: '', ETH_WS_URL: WS }).rpcUrl).toBe(WS);
    expect(loadConfig(['Transfer'], { ETH_RPC_URL: '   ', ETH_WS_URL: WS }).rpcUrl).toBe(WS);
  });

  it('accepts HTTP(S) endpoints for polling mode', () => {
    const url = 'https://rpc.example.com/key';
    expect(loadConfig(['Transfer'], { ETH_RPC_URL: url }).rpcUrl).toBe(url);
  });

  it('uses ETH_RPC_URL as-is, so any provider works', () => {
    const config = loadConfig(['Transfer'], { ETH_RPC_URL: ` ${WS} ` });
    expect(config).toEqual({ mode: 'Transfer', rpcUrl: WS });
  });

  it('accepts a local ws:// node', () => {
    expect(loadConfig(['Transfer'], { ETH_RPC_URL: 'ws://127.0.0.1:8546' }).rpcUrl).toBe('ws://127.0.0.1:8546');
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig(['nope'], { ETH_RPC_URL: WS })).toThrow(ConfigError);
    expect(() => loadConfig([], { ETH_RPC_URL: WS })).toThrow(/Invalid mode/);
  });

  it('requires ETH_RPC_URL and points INFURA_PROJECT_ID users at it', () => {
    expect(() => loadConfig(['Transfer'], {})).toThrow(/ETH_RPC_URL is not set/);
    expect(() => loadConfig(['Transfer'], { INFURA_PROJECT_ID: 'abc' })).toThrow(/no longer used/);
  });

  it('rejects unsupported schemes and malformed URLs without echoing them', () => {
    const secret = 'ftp://eth.example.com/v2/secret-key';
    expect(() => loadConfig(['Transfer'], { ETH_RPC_URL: secret })).toThrow(/must start with/);
    expect(() => loadConfig(['Transfer'], { ETH_RPC_URL: secret })).not.toThrow(/secret-key/);
    expect(() => loadConfig(['Transfer'], { ETH_RPC_URL: 'not a url' })).toThrow(/valid URL/);
  });

  it('has error messages that survive the redacting console unchanged', () => {
    for (const env of [{ ETH_RPC_URL: 'ftp://h.example/x' }, {}, { ETH_RPC_URL: 'nope' }]) {
      try {
        loadConfig(['Transfer'], env);
      } catch (error) {
        const { message } = error as Error;
        expect(redactUrls(message)).toBe(message);
      }
    }
  });
});
