const MAX_LABEL_LENGTH = 64;

/**
 * Token names/symbols are chosen by whoever deployed the contract, i.e. by an attacker.
 * Before they reach a terminal, Discord or Telegram: drop control characters (newline spoofing,
 * ANSI escapes), invisible/bidi format characters, defang URL schemes and domain dots so chat
 * clients don't auto-link them, and cap the length so a long name can never push the real address and the
 * risk section out of a message limit.
 */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\bh(tt)(ps?:\/\/)/gi, 'hxx$2')
    // Bare domains ("evil.com", "www.evil.com") are auto-linked by Discord/Telegram too.
    .replace(/([\p{L}\p{N}-])[.\u3002\uFF0E](?=\p{L}{2,})/gu, '$1[.]')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > MAX_LABEL_LENGTH ? `${chars.slice(0, MAX_LABEL_LENGTH - 1).join('')}…` : cleaned;
}

/** Backslash-escape Discord markdown so a name can't render links, bold text or quotes. */
export const escapeDiscordMarkdown = (text: string): string => text.replace(/[\\*_~`|>[\]()#]/g, '\\$&');
