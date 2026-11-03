import { logger } from '../../utils/logger';
import type { ChatMessage } from '../ai-engine/groq.service';
import type { MessageStore } from '../memory/message.store';

export interface Completer {
  complete(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

export const SYSTEM_PROMPT =
  'You are MJ, a personal AI assistant (secretary, communication manager and research assistant) ' +
  'working for one user, whom you address as "Sir" where appropriate. Be concise, respectful and professional. ' +
  'Reply in the language the user writes in (English or Tamil). You are replying in a chat app, so keep ' +
  'answers short and use plain text. Never claim to have performed an action (sending email, scheduling, ' +
  'setting reminders) because those tools are not connected yet; say so honestly if asked.';

export const AI_FAILURE_REPLY = 'Apologies, Sir. I am unable to respond right now. Please try again shortly.';

/** Channel-agnostic: builds context from stored history and asks the model. Never throws. */
export async function generateReply(store: MessageStore, ai: Completer, text: string): Promise<string> {
  const history = await store.recent(8);
  // history already includes the just-stored inbound message as the latest "in".
  const turns: ChatMessage[] = history.map((h) => ({
    role: h.direction === 'in' ? ('user' as const) : ('assistant' as const),
    content: h.text,
  }));
  if (!turns.length || turns[turns.length - 1]!.content !== text) turns.push({ role: 'user', content: text });
  try {
    return await ai.complete([{ role: 'system', content: SYSTEM_PROMPT }, ...turns]);
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'AI completion failed');
    return AI_FAILURE_REPLY;
  }
}
