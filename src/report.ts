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
export function formatReport(
  token: TokenInfo,
  { holder, risk }: ReportExtras = {},
  /** Escapes the (sanitised but still attacker-chosen) name/symbol for the target medium. */
  escape: (label: string) => string = (label) => label,
): string {
  const { address } = token;
  const lines = [
    `New ERC-20 token detected: ${escape(token.name)} (${escape(token.symbol)})`,
    `Contract address: ${address}`,
    `DexScreener: https://dexscreener.com/ethereum/${address}`,
    `EtherScan: https://etherscan.io/address/${address}`,
    `TokenSniffer: https://tokensniffer.com/token/eth/${address}`,
  ];
  // GeckoTerminal pages are addressed by *pool*, not by token: only link a pool that exists.
  const pool = risk?.liquidity.pools[0];
  if (pool) lines.push(`GeckoTerminal: https://www.geckoterminal.com/eth/pools/${pool}`);
  if (holder) lines.push(`Holder: https://debank.com/profile/${holder}`);
  if (risk) lines.push('', ...formatRisk(risk));
  return lines.join('\n');
}

/** Follow-up sent when a token announced without liquidity has since got a pool. */
export function formatLiquidityUpdate(
  token: TokenInfo,
  risk: RiskReport,
  escape: (label: string) => string = (label) => label,
): string {
  const { address } = token;
  const pool = risk.liquidity.pools[0];
  const lines = [
    `Liquidity added: ${escape(token.name)} (${escape(token.symbol)})`,
    `Contract address: ${address}`,
    `DexScreener: https://dexscreener.com/ethereum/${address}`,
    `EtherScan: https://etherscan.io/address/${address}`,
  ];
  if (pool) lines.push(`GeckoTerminal: https://www.geckoterminal.com/eth/pools/${pool}`);
  lines.push('', ...formatRisk(risk));
  return lines.join('\n');
}
