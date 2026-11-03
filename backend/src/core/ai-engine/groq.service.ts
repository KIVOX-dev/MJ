import Groq from 'groq-sdk';
import { logger } from '../../utils/logger';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
      }): Promise<{ choices: Array<{ message?: { content?: string | null } }> }>;
    };
  };
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

  async complete(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    let lastErr: unknown;
    for (const model of this.models) {
      for (const idx of this.keyOrder()) {
        try {
          const res = await this.clients[idx]!.chat.completions.create({
            model,
            messages,
            temperature: opts.temperature ?? 0.4,
            max_tokens: opts.maxTokens ?? 1024,
          });
          const text = res.choices[0]?.message?.content;
          if (!text) throw new Error('Groq returned an empty completion');
          return text.trim();
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
}
