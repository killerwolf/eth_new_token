import type { Address } from 'viem';

export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
}

/** Human-readable detection report. `holder` is the initial recipient (Transfer mode only). */
export function formatReport(token: TokenInfo, holder?: Address): string {
  const { address } = token;
  const lines = [
    `New ERC-20 token detected: ${token.name} (${token.symbol})`,
    `Contract address: ${address}`,
    `DexScreener: https://dexscreener.com/ethereum/${address}`,
    `EtherScan: https://etherscan.io/address/${address}`,
    `TokenSniffer: https://tokensniffer.com/token/eth/${address}`,
    `GeckoTerminal: https://www.geckoterminal.com/eth/pools/${address}`,
  ];
  if (holder) lines.push(`Holder: https://debank.com/profile/${holder}`);
  return lines.join('\n');
}
