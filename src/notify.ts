export interface Notifier {
  readonly name: string;
  send(message: string): Promise<void>;
}

type FetchFn = typeof fetch;

const TIMEOUT_MS = 10_000;

async function postJson(fetchFn: FetchFn, url: string, body: unknown): Promise<void> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // Deliberately omit the URL: it embeds the webhook / bot secret.
    throw new Error(`HTTP ${response.status}`);
  }
}

/** Discord rejects `content` longer than 2000 characters. */
const DISCORD_LIMIT = 2000;

export function discordNotifier(webhookUrl: string, fetchFn: FetchFn = fetch): Notifier {
  return {
    name: 'discord',
    send: (message) =>
      postJson(fetchFn, webhookUrl, {
        content: message.slice(0, DISCORD_LIMIT),
        // Never let a token name ping @everyone.
        allowed_mentions: { parse: [] },
      }),
  };
}

export function telegramNotifier(
  botToken: string,
  chatId: string,
  fetchFn: FetchFn = fetch,
): Notifier {
  return {
    name: 'telegram',
    send: (message) =>
      postJson(fetchFn, `https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: message.slice(0, 4096),
        disable_web_page_preview: true,
      }),
  };
}

const DISCORD_WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export class NotifierConfigError extends Error {}

/** Build the notifiers enabled by the environment. Console output is handled separately. */
export function createNotifiers(env: NodeJS.ProcessEnv, fetchFn: FetchFn = fetch): Notifier[] {
  const notifiers: Notifier[] = [];

  const discord = env.DISCORD_WEBHOOK_URL?.trim();
  if (discord) {
    if (!DISCORD_WEBHOOK.test(discord)) {
      throw new NotifierConfigError('DISCORD_WEBHOOK_URL is not a valid Discord webhook URL.');
    }
    notifiers.push(discordNotifier(discord, fetchFn));
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (botToken || chatId) {
    if (!botToken || !chatId) {
      throw new NotifierConfigError('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
    }
    notifiers.push(telegramNotifier(botToken, chatId, fetchFn));
  }

  return notifiers;
}
