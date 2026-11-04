import Groq from 'groq-sdk';
import { logger } from '../../utils/logger';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A piece of a multimodal user message: text, or an image as a data: URL. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
        tools?: ToolSpec[];
        tool_choice?: 'auto';
      }): Promise<{ choices: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> }>;
    };
  };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

const RATE_LIMIT_COOLDOWN_MS = 60_000;

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

/**
 * Groq access with free-tier resilience:
 * - rotates across multiple API keys (round-robin start, skip keys in cooldown)
 * - falls back through an ordered list of models
 * Rate limits (429), auth failures (401/403), 5xx and network errors move to the
 * next key; a model-level failure (404/400 model unavailable) moves to the next model.
 */
export class GroqService {
  private readonly cooldownUntil = new Map<number, number>();
  private next = 0;

  constructor(
    private readonly clients: ChatClient[],
    private readonly models: string[],
    private readonly now: () => number = Date.now,
  ) {
    if (!clients.length) throw new Error('At least one Groq API key is required');
    if (!models.length) throw new Error('At least one Groq model is required');
  }

  static fromConfig(cfg: { apiKeys: string[]; models: string[] }): GroqService {
    return new GroqService(
      cfg.apiKeys.map((apiKey) => new Groq({ apiKey, maxRetries: 0 }) as unknown as ChatClient),
      cfg.models,
    );
  }

  private keyOrder(): number[] {
    const n = this.clients.length;
    const start = this.next++ % n;
    const order = Array.from({ length: n }, (_, i) => (start + i) % n);
    const t = this.now();
    const ready = order.filter((i) => (this.cooldownUntil.get(i) ?? 0) <= t);
    // If everything is cooling down, still try all rather than failing outright.
    return ready.length ? ready : order;
  }

  /** Chat completion that may return tool calls. */
  async chat(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; tools?: ToolSpec[]; /** override the model chain, e.g. a vision model */ models?: string[] } = {},
  ): Promise<ChatResult> {
    let lastErr: unknown;
    for (const model of opts.models?.length ? opts.models : this.models) {
      for (const idx of this.keyOrder()) {
        try {
          const res = await this.clients[idx]!.chat.completions.create({
            model,
            messages,
            temperature: opts.temperature ?? 0.4,
            max_tokens: opts.maxTokens ?? 1024,
            ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' as const } : {}),
          });
          const m = res.choices[0]?.message;
          const toolCalls = m?.tool_calls ?? [];
          const content = m?.content?.trim() || null;
          if (!content && !toolCalls.length) throw new Error('Groq returned an empty completion');
          return { content, toolCalls };
        } catch (err) {
          lastErr = err;
          const status = statusOf(err);
          // Never log keys; log only index/model/status.
          logger.warn({ keyIndex: idx, model, status }, 'Groq call failed, trying fallback');
          if (status === 429) this.cooldownUntil.set(idx, this.now() + RATE_LIMIT_COOLDOWN_MS);
          if (status === 400 || status === 404) break; // model-level problem: next model
        }
      }
    }
    throw new Error(`All Groq keys/models failed (last status: ${statusOf(lastErr) ?? 'n/a'})`);
  }

  /** Plain text completion (no tools). */
  async complete(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const r = await this.chat(messages, opts);
    if (!r.content) throw new Error('All Groq keys/models failed (no text content)');
    return r.content;
  }
}
