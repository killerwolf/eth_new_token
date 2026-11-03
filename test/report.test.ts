import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { formatLiquidityUpdate, formatReport } from '../src/report.js';
import type { RiskReport } from '../src/risk.js';

const address = '0x00000000000000000000000000000000000000aa' as Address;
const token = { address, name: 'Pepe', symbol: 'PEPE' };

describe('formatReport', () => {
  it('lists token details and analysis links', () => {
    const report = formatReport(token);
    expect(report).toContain('New ERC-20 token detected: Pepe (PEPE)');
    expect(report).toContain(`https://etherscan.io/address/${address}`);
    expect(report).not.toContain('Holder');
  });

  it('adds the holder link when known', () => {
    const holder = '0x00000000000000000000000000000000000000bb' as Address;
    expect(formatReport(token, { holder })).toContain(`https://debank.com/profile/${holder}`);
  });
});

describe('GeckoTerminal link', () => {
  const risk = (pools: Address[]): RiskReport => ({
    decimals: 18,
    owner: { kind: 'renounced' },
    proxy: undefined,
    capabilities: [],
    liquidity: { v2: pools.length > 0, v3Fees: [], pools, complete: true },
  });
  const pool = '0x00000000000000000000000000000000000000d2' as Address;

  it('is pool-addressed, and only shown once a pool exists', () => {
    expect(formatReport(token)).not.toContain('GeckoTerminal');
    expect(formatReport(token, { risk: risk([]) })).not.toContain('GeckoTerminal');
    expect(formatReport(token, { risk: risk([pool]) })).toContain(
      `GeckoTerminal: https://www.geckoterminal.com/eth/pools/${pool}`,
    );
  });

  it('never uses the token address as a pool address', () => {
    expect(formatReport(token, { risk: risk([pool]) })).not.toContain(`pools/${address}`);
  });
});

describe('formatReport escaping', () => {
  it('applies the medium-specific escape to name and symbol only', () => {
    const report = formatReport({ ...token, name: 'a*b', symbol: 'c_d' }, {}, (label) => `<${label}>`);
    expect(report).toContain('detected: <a*b> (<c_d>)');
    expect(report).toContain(`https://etherscan.io/address/${address}`);
  });
});

describe('formatLiquidityUpdate', () => {
  const pool = '0x00000000000000000000000000000000000000d2' as Address;
  const risk: RiskReport = {
    decimals: 18,
    owner: { kind: 'renounced' },
    proxy: undefined,
    capabilities: ['mintable'],
    liquidity: { v2: true, v3Fees: [], pools: [pool], complete: true },
  };

  it('announces the liquidity, links the pool and repeats the risk lines', () => {
    const text = formatLiquidityUpdate(token, risk);
    expect(text).toContain('Liquidity added: Pepe (PEPE)');
    expect(text).toContain(`GeckoTerminal: https://www.geckoterminal.com/eth/pools/${pool}`);
    expect(text).toContain('Liquidity (vs WETH): Uniswap V2');
    expect(text).toContain('Owner: renounced');
    expect(text).toContain('Flags: mintable');
  });

  it('applies the medium-specific escape to the name and symbol', () => {
    const text = formatLiquidityUpdate({ ...token, name: 'a*b' }, risk, (label) => `<${label}>`);
    expect(text).toContain('Liquidity added: <a*b> (<PEPE>)');
  });
});
