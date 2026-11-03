import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const WS = 'wss://eth-mainnet.example.com/v2/secret-key';

  it('uses ETH_WS_URL as-is, so any provider works', () => {
    const config = loadConfig(['Transfer'], { ETH_WS_URL: ` ${WS} ` });
    expect(config).toEqual({ mode: 'Transfer', wsUrl: WS });
  });

  it('accepts a local ws:// node', () => {
    expect(loadConfig(['Transfer'], { ETH_WS_URL: 'ws://127.0.0.1:8546' }).wsUrl).toBe('ws://127.0.0.1:8546');
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig(['nope'], { ETH_WS_URL: WS })).toThrow(ConfigError);
    expect(() => loadConfig([], { ETH_WS_URL: WS })).toThrow(/Invalid mode/);
  });

  it('requires ETH_WS_URL and points legacy users at it', () => {
    expect(() => loadConfig(['Transfer'], {})).toThrow(/ETH_WS_URL is not set/);
    expect(() => loadConfig(['Transfer'], { INFURA_PROJECT_ID: 'abc' })).toThrow(/no longer used/);
  });

  it('rejects non-WebSocket and malformed URLs without echoing them', () => {
    const secret = 'https://eth.example.com/v2/secret-key';
    expect(() => loadConfig(['Transfer'], { ETH_WS_URL: secret })).toThrow(/WebSocket URL/);
    expect(() => loadConfig(['Transfer'], { ETH_WS_URL: secret })).not.toThrow(/secret-key/);
    expect(() => loadConfig(['Transfer'], { ETH_WS_URL: 'not a url' })).toThrow(/valid URL/);
  });
});
