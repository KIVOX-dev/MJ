export interface TelegramSender {
  sendText(chatId: number | string, text: string): Promise<{ messageId: number }>;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** Telegram Bot API client (https://core.telegram.org/bots/api). */
export class TelegramBotClient implements TelegramSender {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
    // Verify the API really accepted the call; never assume success. The token is never put in errors.
    if (!res.ok || !json.ok || json.result === undefined) {
      throw new Error(
        `Telegram ${method} failed (HTTP ${res.status}, code ${json.error_code ?? 'n/a'}): ${json.description ?? 'unknown error'}`,
      );
    }
    return json.result;
  }

  async sendText(chatId: number | string, text: string): Promise<{ messageId: number }> {
    // Telegram text limit is 4096 chars
    const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, 4000) });
    return { messageId: r.message_id };
  }

  getMe() {
    return this.call<{ id: number; username: string; first_name: string }>('getMe');
  }

  setWebhook(url: string, secretToken: string) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
  }
}
