import { describe, expect, it, vi } from 'vitest';
import { GroqService, retryAfterMs, type ChatClient } from '../src/core/ai-engine/groq.service';

const rateLimit = (msg = 'Rate limit reached. Please try again in 5s.') => Object.assign(new Error(msg), { status: 429 });
const reply = (content: string) => ({ choices: [{ message: { content } }] });
const client = (create: ReturnType<typeof vi.fn>): ChatClient => ({ chat: { completions: { create } } }) as unknown as ChatClient;
const msg = [{ role: 'user' as const, content: 'hi' }];

describe('retryAfterMs', () => {
  it('reads the Retry-After header, or the "try again in" text, with a safe default', () => {
    expect(retryAfterMs(Object.assign(new Error('x'), { headers: { 'retry-after': '7' } }))).toBe(7000);
    expect(retryAfterMs(new Error('Rate limit. Please try again in 27.9s. Need more tokens?'))).toBe(27900);
    expect(retryAfterMs(new Error('Please try again in 1m30s'))).toBe(90000 > 60000 ? 60000 : 90000);
    expect(retryAfterMs(new Error('Please try again in 850ms'))).toBe(850);
    expect(retryAfterMs(new Error('nothing useful'))).toBe(20000);
  });
});

describe('GroqService rate limits', () => {
  it('stops after two limited keys on a model and moves to the next model', async () => {
    const limited = vi.fn().mockRejectedValue(rateLimit());
    const ok = vi.fn().mockResolvedValue(reply('from model two'));
    // the same fake client serves both models: it only succeeds for model "m2"
    const create = vi.fn(async (p: { model: string }) => (p.model === 'm2' ? ok() : limited()));
    const svc = new GroqService([client(create), client(create), client(create), client(create)], ['m1', 'm2']);
    expect((await svc.chat(msg)).content).toBe('from model two');
    expect(limited).toHaveBeenCalledTimes(2); // not 4
  });

  it('waits for the limit to clear and then answers, instead of failing straight away', async () => {
    let t = 1_000_000;
    const sleep = vi.fn(async (ms: number) => void (t += ms));
    const create = vi.fn().mockRejectedValueOnce(rateLimit('Please try again in 5s.')).mockRejectedValueOnce(rateLimit('Please try again in 5s.')).mockResolvedValue(reply('worth the wait'));
    const svc = new GroqService([client(create), client(create)], ['m1'], () => t, sleep);
    expect((await svc.chat(msg)).content).toBe('worth the wait');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(5000);
  });

  it('does not wait when the limit is far away, and reports the 429', async () => {
    const sleep = vi.fn();
    const create = vi.fn().mockRejectedValue(rateLimit('Please try again in 45s.'));
    const svc = new GroqService([client(create)], ['m1'], () => 1_000_000, sleep);
    await expect(svc.chat(msg)).rejects.toThrow(/429/);
    expect(sleep).not.toHaveBeenCalled();
  });
});
