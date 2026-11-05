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

const DEFAULT_RETRY_MS = 20_000;
/** Longest we will wait for a rate limit to clear before answering, so a chat message is delayed but not abandoned. */
const MAX_WAIT_MS = 25_000;

/** How long Groq asks us to wait: the Retry-After header, or "try again in 27.9s" in the message. */
export function retryAfterMs(err: unknown): number {
  const h = (err as { headers?: unknown })?.headers as { get?: (k: string) => string | null } & Record<string, string | undefined>;
  const header = typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after'];
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
  const m = /try again in\s+(?:(\d+)m)?\s*([\d.]+)(ms|s)/i.exec((err as Error)?.message ?? '');
  if (m) return Math.min((Number(m[1] ?? 0) * 60 + Number(m[2]) * (m[3] === 'ms' ? 0.001 : 1)) * 1000, 60_000);
  return DEFAULT_RETRY_MS;
}

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
  /** `${keyIndex}:${model}` -> time until which that key may not be used for that model. */
  private readonly cooldownUntil = new Map<string, number>();
  private next = 0;

  constructor(
    private readonly clients: ChatClient[],
    private readonly models: string[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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

  /** Keys not cooling down for this model, starting from a rotating position. */
  private keyOrder(model: string): number[] {
    const n = this.clients.length;
    const start = this.next++ % n;
    const t = this.now();
    return Array.from({ length: n }, (_, i) => (start + i) % n).filter((i) => (this.cooldownUntil.get(`${i}:${model}`) ?? 0) <= t);
  }

  private soonestReady(model: string): number {
    let soonest = Infinity;
    for (let i = 0; i < this.clients.length; i++) soonest = Math.min(soonest, this.cooldownUntil.get(`${i}:${model}`) ?? 0);
    return soonest;
  }

  /**
   * Chat completion that may return tool calls.
   * Groq's token limits belong to the whole account, so extra keys rarely help: after two rate-limited keys on a model we move to the
   * next model, and if everything is rate-limited we wait (up to MAX_WAIT_MS) for the earliest limit to clear and try once more.
   */
  async chat(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; tools?: ToolSpec[]; /** override the model chain, e.g. a vision model */ models?: string[] } = {},
  ): Promise<ChatResult> {
    let lastErr: unknown;
    for (let round = 0; round < 2; round++) {
      let limited = false;
      let soonest = Infinity;
      for (const model of opts.models?.length ? opts.models : this.models) {
        const keys = this.keyOrder(model);
        if (!keys.length) {
          limited = true;
          soonest = Math.min(soonest, this.soonestReady(model));
          continue;
        }
        let limitedKeys = 0;
        for (const idx of keys) {
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
            if (status === 429) {
              const until = this.now() + retryAfterMs(err);
              this.cooldownUntil.set(`${idx}:${model}`, until);
              limited = true;
              soonest = Math.min(soonest, until);
              if (++limitedKeys >= 2) break; // the limit is account-wide: more keys will not help
            }
            if (status === 400 || status === 404) break; // model-level problem: next model
          }
        }
      }
      const wait = soonest - this.now();
      if (round === 1 || !limited || !Number.isFinite(soonest) || wait > MAX_WAIT_MS) break;
      logger.info({ waitMs: Math.max(wait, 0) }, 'Groq rate-limited, waiting for the limit to clear');
      await this.sleep(Math.max(wait, 500) + 250);
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
