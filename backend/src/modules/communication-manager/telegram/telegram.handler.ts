import { logger } from '../../../utils/logger';
import { generateReply, type Completer } from '../../../core/orchestrator/assistant';
import type { MessageStore } from '../../../core/memory/message.store';
import type { TelegramSender } from './telegram.client';

export interface TelegramHandlerDeps {
  /** Numeric Telegram user id of the owner. Empty means fail closed. */
  ownerId: string;
  store: MessageStore;
  ai: Completer;
  sender: TelegramSender;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
  };
}

export async function processTelegramUpdate(update: TgUpdate, deps: TelegramHandlerDeps): Promise<void> {
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

    const reply = await generateReply(deps.store, deps.ai, text);
    const sent = await deps.sender.sendText(msg.chat.id, reply);
    await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
  } catch (err) {
    logger.error({ err: { message: (err as Error).message }, id: update.update_id }, 'Failed processing Telegram update');
  }
}
