import { describe, expect, it } from 'vitest';
import { escapeDiscordMarkdown, sanitizeLabel } from '../src/text.js';

describe('sanitizeLabel', () => {
  it('flattens newlines so a name cannot forge report lines', () => {
    const label = sanitizeLabel('X\nContract address: 0xFAKE\r\nEtherScan: https://evil.example');
    expect(label).not.toMatch(/[\n\r]/);
    expect(label).toContain('hxxps://evil[.]example');
  });

  it('strips ANSI escapes and invisible/bidi characters', () => {
    expect(sanitizeLabel('\u001b[31mRED\u001b[0m')).toBe('[31mRED [0m');
    expect(sanitizeLabel('ab‮cd​ef')).toBe('ab cd ef');
  });

  it('caps the length, by code point', () => {
    const label = sanitizeLabel('😀'.repeat(500));
    expect(Array.from(label)).toHaveLength(64);
    expect(label.endsWith('…')).toBe(true);
  });

  it('defangs bare domains so chat apps do not auto-link them', () => {
    expect(sanitizeLabel('Claim at evil.com')).toBe('Claim at evil[.]com');
    expect(sanitizeLabel('www.evil.co.uk/airdrop')).toBe('www[.]evil[.]co[.]uk/airdrop');
  });

  it('defangs non-ASCII domains and ideographic dots too', () => {
    expect(sanitizeLabel('café.com')).toBe('café[.]com');
    expect(sanitizeLabel('evil.рф')).toBe('evil[.]рф');
    expect(sanitizeLabel('evil\u3002com')).toBe('evil[.]com');
    expect(sanitizeLabel('evil\uFF0Ecom')).toBe('evil[.]com');
  });

  it('does not mangle ordinary names containing dots between digits or before spaces', () => {
    expect(sanitizeLabel('Pepe 2.0')).toBe('Pepe 2.0');
    expect(sanitizeLabel('St. Louis Token v1.2')).toBe('St. Louis Token v1.2');
  });

  it('leaves ordinary names alone and collapses whitespace', () => {
    expect(sanitizeLabel('  Wrapped   Ether ')).toBe('Wrapped Ether');
    expect(sanitizeLabel('\u0000\u0007')).toBe('');
  });
});

describe('escapeDiscordMarkdown', () => {
  it('neutralises links, emphasis and quotes', () => {
    expect(escapeDiscordMarkdown('[etherscan](https://x) *b* _i_ `c` > q')).toBe(
      '\\[etherscan\\]\\(https://x\\) \\*b\\* \\_i\\_ \\`c\\` \\> q',
    );
  });
});
