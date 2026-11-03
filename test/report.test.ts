import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { formatReport } from '../src/report.js';

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

describe('formatReport escaping', () => {
  it('applies the medium-specific escape to name and symbol only', () => {
    const report = formatReport({ ...token, name: 'a*b', symbol: 'c_d' }, {}, (label) => `<${label}>`);
    expect(report).toContain('detected: <a*b> (<c_d>)');
    expect(report).toContain(`https://etherscan.io/address/${address}`);
  });
});
