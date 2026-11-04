import { logger } from '../../../utils/logger';
import type { Responder } from '../../../core/orchestrator/assistant';
import type { MessageStore } from '../../../core/memory/message.store';
import type { TelegramSender } from './telegram.client';

export interface TelegramHandlerDeps {
  /** Numeric Telegram user id of the owner. Empty means fail closed. */
  ownerId: string;
  store: MessageStore;
  respond: Responder;
  sender: TelegramSender;
  /** Stops a reminder when its Stop button is pressed. Returns false if it was not active any more. */
  stopReminder?: (chatId: string, reminderId: string) => Promise<boolean>;
}

/** Handles taps on inline buttons. Only the owner may press them; everything else is ignored. */
async function processCallback(update: TgUpdate, deps: TelegramHandlerDeps): Promise<void> {
  const cb = update.callback_query!;
  try {
    const fromId = String(cb.from.id);
    if (!deps.ownerId || fromId !== deps.ownerId) {
      logger.warn('Ignored Telegram button press from non-owner');
      return;
    }
    const m = /^stop:([a-f0-9]{24})$/i.exec(cb.data ?? '');
    if (!m || !deps.stopReminder || !cb.message) {
      await deps.sender.answerCallback?.(cb.id);
      return;
    }
    const chatId = String(cb.message.chat.id);
    const stopped = await deps.stopReminder(chatId, m[1]!);
    await deps.sender.answerCallback?.(cb.id, stopped ? 'Reminder stopped' : 'Already stopped');
    await deps.sender.clearKeyboard?.(cb.message.chat.id, cb.message.message_id).catch(() => undefined);
    if (stopped) await deps.sender.sendText(cb.message.chat.id, 'Understood, Sir. That reminder is stopped.');
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'Failed processing Telegram button press');
  }
}

export interface TgUpdate {
  update_id: number;
  /** A tap on an inline button (e.g. "Stop reminder"). */
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
  };
}

export async function processTelegramUpdate(update: TgUpdate, deps: TelegramHandlerDeps): Promise<void> {
  if (update?.callback_query) return processCallback(update, deps);
  const msg = update?.message;
  if (!msg?.from || msg.from.is_bot || msg.chat.type !== 'private') return;
  try {
    const text = (msg.text ?? '').trim();
    const fromId = String(msg.from.id);

    // Setup helper: lets the owner discover their numeric id. Reveals only the sender's own id.
    if (/^\/(myid|whoami)(@\w+)?$/i.test(text)) {
      await deps.sender.sendText(msg.chat.id, `Your Telegram user id is ${fromId}`);
      return;
    }

    // Owner-only: ignore everyone else silently (fail closed if owner unset).
    if (!deps.ownerId || fromId !== deps.ownerId) {
      logger.warn('Ignored Telegram message from non-owner');
      return;
    }

    // Duplicate prevention: Telegram retries; update_id makes this idempotent.
    const fresh = await deps.store.claimInbound(String(update.update_id), fromId, text, text ? 'text' : 'other');
    if (!fresh) {
      logger.info({ id: update.update_id }, 'Duplicate Telegram update skipped');
      return;
    }

    if (!text) {
      await deps.sender.sendText(
        msg.chat.id,
        'Sir, I can only handle text messages at the moment. Voice notes and documents are coming soon.',
      );
      return;
    }
    if (text === '/start') {
      await deps.sender.sendText(msg.chat.id, 'Good day, Sir. MJ at your service. How may I help?');
      return;
    }

    const reply = await deps.respond(text, { channel: 'telegram', chatId: fromId });
    const sent = await deps.sender.sendText(msg.chat.id, reply);
    await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
  } catch (err) {
    logger.error({ err: { message: (err as Error).message }, id: update.update_id }, 'Failed processing Telegram update');
  }
}
