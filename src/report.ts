import type { Address } from 'viem';
import { formatRisk, type RiskReport } from './risk.js';

export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
}

export interface ReportExtras {
  /** Initial recipient of the mint (Transfer mode only). */
  holder?: Address | undefined;
  risk?: RiskReport | undefined;
}

/** Human-readable detection report. */
export function formatReport(token: TokenInfo, { holder, risk }: ReportExtras = {}): string {
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
  if (risk) lines.push('', ...formatRisk(risk));
  return lines.join('\n');
}
