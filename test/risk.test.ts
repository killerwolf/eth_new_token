import { describe, expect, it } from 'vitest';
import { toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem';
import { classifyOwner, cloneImplementation, formatRisk, scanBytecode } from '../src/risk.js';

const sel = (signature: string) => toFunctionSelector(signature).slice(2);
const IMPL = '0x00000000000000000000000000000000000000cc' as Address;

describe('scanBytecode', () => {
  it('flags capabilities whose selectors appear in the bytecode', () => {
    const code = `0x6080${sel('mint(address,uint256)')}${sel('pause()')}00` as Hex;
    expect(scanBytecode(code)).toEqual(['mintable', 'pausable']);
  });

  it('reports nothing for plain code or missing code', () => {
    expect(scanBytecode('0x6080604052')).toEqual([]);
    expect(scanBytecode(undefined)).toEqual([]);
  });
});

describe('cloneImplementation', () => {
  it('extracts the target of an EIP-1167 minimal proxy', () => {
    const code = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(cloneImplementation(code)).toBe(IMPL);
  });

  it('ignores ordinary contracts', () => {
    expect(cloneImplementation('0x6080604052')).toBeUndefined();
  });
});

describe('classifyOwner', () => {
  it('distinguishes none / renounced / active owners', () => {
    expect(classifyOwner(undefined)).toEqual({ kind: 'none' });
    expect(classifyOwner(zeroAddress)).toEqual({ kind: 'renounced' });
    expect(classifyOwner('0x000000000000000000000000000000000000dEaD')).toEqual({ kind: 'renounced' });
    expect(classifyOwner(IMPL)).toEqual({ kind: 'address', address: IMPL });
  });
});

describe('formatRisk', () => {
  it('renders every signal', () => {
    const lines = formatRisk({
      decimals: 18,
      owner: { kind: 'renounced' },
      proxy: undefined,
      capabilities: ['mintable'],
      liquidity: { v2: true, v3Fees: [3000] },
    });
    expect(lines).toEqual([
      'Decimals: 18',
      'Owner: renounced',
      'Proxy: no',
      'Flags: mintable',
      'Liquidity (vs WETH): Uniswap V2, Uniswap V3 0.3%',
    ]);
  });
});
