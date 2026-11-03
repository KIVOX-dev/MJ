import { logger } from '../../utils/logger';
import type { ChatMessage, ChatResult, ToolSpec } from '../ai-engine/groq.service';
import type { Channel, MessageStore } from '../memory/message.store';
import type { ToolRegistry } from '../tool-registry';

export interface ToolChat {
  chat(messages: ChatMessage[], opts?: { tools?: ToolSpec[] }): Promise<ChatResult>;
}

/** Minimal text-completion capability (satisfied by GroqService). */
export interface Completer {
  complete(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

export interface AgentContext {
  channel: Channel;
  chatId: string;
}

/** What chat handlers call: text in, final reply text out. Never throws. */
export type Responder = (text: string, ctx: AgentContext) => Promise<string>;

export const AI_FAILURE_REPLY = 'Apologies, Sir. I am unable to respond right now. Please try again shortly.';
const MAX_STEPS = 5;

/** Chat apps here show plain text: remove markdown emphasis/headings the model sometimes adds and use real bullets. */
export function toPlainChat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/([^\n])\n(• )/g, '$1\n\n$2') // a blank line before every bullet so items breathe
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function systemPrompt(now: Date, timezone: string, hasTools: boolean, extra = ""): string {
  const local = now.toLocaleString('en-IN', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
  const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: timezone, dateStyle: 'full' });
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  return (
    'You are MJ, a personal AI assistant (secretary, communication manager and research assistant) ' +
    'working for one user, whom you address as "Sir" where appropriate. Be concise, respectful and professional. ' +
    'Reply in the language the user writes in (English or Tamil). You are replying in a chat app, so keep ' +
    'answers short and use plain text only (no markdown, no asterisks).\n' +
    `Current time: ${local} (${timezone}); UTC ISO: ${now.toISOString()}.\n` +
    `Today is ${day(now)}. Tomorrow is ${day(tomorrow)}. "Tomorrow" ALWAYS means that next calendar day, even if it is currently early morning.\n` +
    (hasTools
      ? 'Use the provided tools to act. Only state that something was done (for example a reminder set or cancelled) ' +
        'if the tool result says ok:true, and report exactly what it returned. If a tool fails, say so honestly. ' +
        'Ask a short clarifying question if essential details (such as the time) are missing. ' +
        'When listing news or several items, write a one-line intro, then one bullet per item starting with "• " and ' +
        'a blank line between bullets, each as: short title, a dash, one sentence, then (Source). No markdown, no asterisks, no links. ' +
        'For relative times like "in 2 minutes" use in_minutes; for clock times pass day ("today"/"tomorrow"/YYYY-MM-DD) and time (HH:mm). '
      : '') +
    'You can NOT yet send emails, manage the calendar or search the web; say so honestly if asked.' +
    (extra ? `\n${extra}` : '')
  );
}

/**
 * Central orchestration loop: the model may call tools; results are fed back until it
 * produces a final answer. Tool results (from our own code) are the source of truth.
 */
export class Agent {
  constructor(
    private readonly deps: {
      ai: ToolChat;
      store: MessageStore;
      registry: ToolRegistry;
      timezone: string;
      /** Extra system-prompt text, e.g. which automatic features are already running. */
      extraInstructions?: string;
      now?: () => Date;
    },
  ) {}

  readonly respond: Responder = (text, ctx) => this.reply(text, ctx);

  async reply(text: string, ctx: AgentContext): Promise<string> {
    const { ai, store, registry, timezone } = this.deps;
    const now = this.deps.now ?? (() => new Date());
    try {
      const history = await store.recent(8);
      // history already includes the just-stored inbound message as the latest "in".
      const turns: ChatMessage[] = history.map((h) => ({
        role: h.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: h.text,
      }));
      if (!turns.length || turns[turns.length - 1]!.content !== text) turns.push({ role: 'user', content: text });

      const specs = registry.specs();
      const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(now(), timezone, specs.length > 0, this.deps.extraInstructions) }, ...turns];
      const toolCtx = { channel: ctx.channel, chatId: ctx.chatId, timezone, now };

      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await ai.chat(messages, { tools: specs });
        if (!res.toolCalls.length) return res.content ? toPlainChat(res.content) : AI_FAILURE_REPLY;

        messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          const result = await registry.execute(call.function.name, call.function.arguments, toolCtx);
          logger.info({ tool: call.function.name, ok: result.ok }, 'Tool executed');
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      return 'Apologies, Sir. I could not complete that request. Could you rephrase it?';
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Agent failed');
      return AI_FAILURE_REPLY;
    }
  }
}
