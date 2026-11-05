export interface TelegramSender {
  /** `stopReminderId` adds an inline "Stop reminder" button for that reminder. */
  sendText(chatId: number | string, text: string, opts?: { stopReminderId?: string; buttons?: Array<{ text: string; data: string }> }): Promise<{ messageId: number }>;
  /** Acknowledges a button press (removes the spinner on the user's screen, optionally shows a toast). */
  answerCallback?(callbackQueryId: string, text?: string): Promise<void>;
  /** Removes the inline keyboard from a message once its button has been used. */
  clearKeyboard?(chatId: number | string, messageId: number): Promise<void>;
  /** Downloads a file the user sent (photo etc.) by its file_id. */
  downloadFile?(fileId: string, maxBytes?: number): Promise<Buffer>;
  /** Sends a picture (e.g. one MJ generated). */
  sendPhoto?(chatId: number | string, data: Buffer, mime: string, caption?: string): Promise<{ messageId: number }>;
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

  async sendText(chatId: number | string, text: string, opts: { stopReminderId?: string; buttons?: Array<{ text: string; data: string }> } = {}): Promise<{ messageId: number }> {
    // Telegram text limit is 4096 chars
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4000),
      ...(opts.stopReminderId
        ? { reply_markup: { inline_keyboard: [[{ text: '⏹  Stop reminder', callback_data: `stop:${opts.stopReminderId}` }]] } }
        : opts.buttons?.length
          ? { reply_markup: { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }
          : {}),
    });
    return { messageId: r.message_id };
  }

  /** getFile + download. Errors never include the bot token (it is part of the download URL). */
  async downloadFile(fileId: string, maxBytes = 5_000_000): Promise<Buffer> {
    const info = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!info.file_path) throw new Error('Telegram returned no file path');
    if ((info.file_size ?? 0) > maxBytes) throw new Error('File is too large');
    const res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('File is too large');
    return buf;
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

  async sendPhoto(chatId: number | string, data: Buffer, mime: string, caption?: string): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1000));
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    form.set('photo', new Blob([new Uint8Array(data)], { type: mime }), `mj-image.${ext}`);
    const r = await this.call<{ message_id: number }>('sendPhoto', form);
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
