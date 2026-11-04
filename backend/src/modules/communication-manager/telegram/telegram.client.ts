export interface TelegramSender {
  /** `stopReminderId` adds an inline "Stop reminder" button for that reminder. */
  sendText(chatId: number | string, text: string, opts?: { stopReminderId?: string }): Promise<{ messageId: number }>;
  /** Acknowledges a button press (removes the spinner on the user's screen, optionally shows a toast). */
  answerCallback?(callbackQueryId: string, text?: string): Promise<void>;
  /** Removes the inline keyboard from a message once its button has been used. */
  clearKeyboard?(chatId: number | string, messageId: number): Promise<void>;
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
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      // multipart (file upload) sets its own Content-Type with the boundary
      ...(isForm ? { body: body as FormData } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
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

  async sendText(chatId: number | string, text: string, opts: { stopReminderId?: string } = {}): Promise<{ messageId: number }> {
    // Telegram text limit is 4096 chars
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4000),
      ...(opts.stopReminderId
        ? { reply_markup: { inline_keyboard: [[{ text: '⏹  Stop reminder', callback_data: `stop:${opts.stopReminderId}` }]] } }
        : {}),
    });
    return { messageId: r.message_id };
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call<boolean>('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async clearKeyboard(chatId: number | string, messageId: number): Promise<void> {
    await this.call<unknown>('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  /** Uploads a file (e.g. the MJ Times PDF). Telegram allows up to 50 MB for bots. */
  async sendDocument(chatId: number | string, data: Buffer, filename: string, caption?: string): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1000));
    form.set('document', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), filename);
    const r = await this.call<{ message_id: number }>('sendDocument', form);
    return { messageId: r.message_id };
  }

  getMe() {
    return this.call<{ id: number; username: string; first_name: string }>('getMe');
  }

  setWebhook(url: string, secretToken: string) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }
}
