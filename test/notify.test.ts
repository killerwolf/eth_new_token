import { describe, expect, it, vi } from 'vitest';
import { describeError } from '../src/errors.js';
import { createNotifiers, discordNotifier, NotifierConfigError, telegramNotifier } from '../src/notify.js';

const ok = () => vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
const DISCORD = 'https://discord.com/api/webhooks/123456789/abc-DEF_ghi';

describe('notifiers', () => {
  it('posts to Discord with mentions disabled and content truncated', async () => {
    const fetchFn = ok();
    await discordNotifier(DISCORD, fetchFn).send('x'.repeat(5000));
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe(DISCORD);
    expect(body.content).toHaveLength(2000);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags).toBe(4); // SUPPRESS_EMBEDS: no link unfurling
  });

  it('posts to Telegram', async () => {
    const fetchFn = ok();
    await telegramNotifier('TOKEN', '42', fetchFn).send('hi');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'hi' });
  });

  it('escapes markdown for Discord but sends Telegram as plain text', async () => {
    expect(discordNotifier(DISCORD, ok()).escape('[x](https://evil)')).toBe('\\[x\\]\\(https://evil\\)');
    expect(telegramNotifier('T', '1', ok()).escape('[x](https://evil)')).toBe('[x](https://evil)');
  });

  it('never leaks the webhook URL when the request itself fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${DISCORD}`));
    const error = await discordNotifier(DISCORD, fetchFn).send('hi').catch((e: Error) => e);
    expect(describeError(error)).not.toContain('abc-DEF_ghi');
  });

  it('never leaks the webhook URL in errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const error = await discordNotifier(DISCORD, fetchFn).send('hi').catch((e: Error) => e);
    expect((error as Error).message).toBe('HTTP 500');
  });
});

describe('createNotifiers', () => {
  it('is empty without configuration', () => {
    expect(createNotifiers({})).toEqual([]);
  });

  it('enables each configured sink', () => {
    const names = createNotifiers({
      DISCORD_WEBHOOK_URL: DISCORD,
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '1',
    }).map((n) => n.name);
    expect(names).toEqual(['discord', 'telegram']);
  });

  it('rejects non-Discord webhook URLs (no arbitrary POST targets)', () => {
    expect(() => createNotifiers({ DISCORD_WEBHOOK_URL: 'https://evil.example/hook' })).toThrow(NotifierConfigError);
  });

  it('requires both Telegram variables', () => {
    expect(() => createNotifiers({ TELEGRAM_BOT_TOKEN: 't' })).toThrow(/both/);
  });
});
