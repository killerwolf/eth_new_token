import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('builds the Infura websocket URL', () => {
    const config = loadConfig(['Transfer'], { INFURA_PROJECT_ID: 'abc' });
    expect(config).toEqual({ mode: 'Transfer', wsUrl: 'wss://mainnet.infura.io/ws/v3/abc' });
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig(['nope'], { INFURA_PROJECT_ID: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig([], { INFURA_PROJECT_ID: 'abc' })).toThrow(/Invalid mode/);
  });

  it('requires INFURA_PROJECT_ID', () => {
    expect(() => loadConfig(['Transfer'], {})).toThrow(/INFURA_PROJECT_ID/);
  });
});
