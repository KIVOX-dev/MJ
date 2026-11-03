import { logger } from '../../../utils/logger';
import type { ChatMessage } from '../../../core/ai-engine/groq.service';
import { digitsOnly } from './signature';
import type { WhatsAppSender } from './whatsapp.client';
import type { MessageStore } from './message.store';

export interface Completer {
  complete(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

export interface HandlerDeps {
  ownerNumber: string;
  store: MessageStore;
  ai: Completer;
  sender: WhatsAppSender;
}

const SYSTEM_PROMPT =
  'You are MJ, a personal AI assistant (secretary, communication manager and research assistant) ' +
  'working for one user, whom you address as "Sir" where appropriate. Be concise, respectful and professional. ' +
  'Reply in the language the user writes in (English or Tamil). You are replying over WhatsApp, so keep ' +
  'answers short and use plain text. Never claim to have performed an action (sending email, scheduling, ' +
  'setting reminders) because those tools are not connected yet; say so honestly if asked.';

interface InboundMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
}

/** Pulls messages out of Meta's webhook payload. Statuses are logged only. */
function extract(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      for (const s of v?.statuses ?? []) {
        logger.info({ status: s.status, id: s.id }, 'WhatsApp delivery status');
      }
      for (const m of v?.messages ?? []) out.push(m as InboundMessage);
    }
  }
  return out;
}

export async function processWebhook(payload: unknown, deps: HandlerDeps): Promise<void> {
  const owner = digitsOnly(deps.ownerNumber);
  for (const msg of extract(payload)) {
    try {
      // Owner-only: ignore everyone else silently (fail closed if owner unset).
      if (!owner || digitsOnly(msg.from) !== owner) {
        logger.warn('Ignored WhatsApp message from non-owner');
        continue;
      }
      const text = msg.type === 'text' ? (msg.text?.body ?? '').trim() : '';
      // Duplicate prevention: Meta retries deliveries; the unique id makes this idempotent.
      const fresh = await deps.store.claimInbound(msg.id, msg.from, text, msg.type);
      if (!fresh) {
        logger.info({ id: msg.id }, 'Duplicate WhatsApp message skipped');
        continue;
      }
      if (msg.type !== 'text' || !text) {
        await deps.sender.sendText(
          msg.from,
          'Sir, I can only handle text messages at the moment. Voice notes and documents are coming soon.',
        );
        continue;
      }

      const history = await deps.store.recent(8);
      // history already includes the just-stored inbound message as the latest "in".
      const turns: ChatMessage[] = history.map((h) => ({
        role: h.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: h.text,
      }));
      if (!turns.length || turns[turns.length - 1]!.content !== text) turns.push({ role: 'user', content: text });

      let reply: string;
      try {
        reply = await deps.ai.complete([{ role: 'system', content: SYSTEM_PROMPT }, ...turns]);
      } catch (err) {
        logger.error({ err: { message: (err as Error).message } }, 'AI completion failed');
        reply = 'Apologies, Sir. I am unable to respond right now. Please try again shortly.';
      }
      const sent = await deps.sender.sendText(msg.from, reply);
      await deps.store.saveOutbound(sent.messageId, msg.from, reply);
    } catch (err) {
      logger.error({ err: { message: (err as Error).message }, id: msg.id }, 'Failed processing WhatsApp message');
    }
  }
}
