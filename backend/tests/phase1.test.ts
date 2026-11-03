import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { GroqService, type ChatClient } from '../src/core/ai-engine/groq.service';

describe('config', () => {
  it('rejects missing required vars', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/MONGODB_URI/);
  });
  it('applies defaults and prefers the Catalyst port', () => {
    const c = loadConfig({
      MONGODB_URI: 'mongodb://x',
      GROQ_API_KEYS: 'k1, k2',
      X_ZOHO_CATALYST_LISTEN_PORT: '9000',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.port).toBe(9000);
    expect(c.timezone).toBe('Asia/Kolkata');
  });
});

describe('health endpoints', () => {
  it('/health is 200', async () => {
    const res = await request(createApp({ isDbConnected: () => true })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  it('/ready is 503 when DB is down', async () => {
    const res = await request(createApp({ isDbConnected: () => false })).get('/ready');
    expect(res.status).toBe(503);
  });
  it('unknown route is 404 JSON', async () => {
    const res = await request(createApp({ isDbConnected: () => true })).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('GroqService', () => {
  const ok = (content: string | null): ChatClient => ({
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } },
  });
  const failing = (status: number): ChatClient => ({
    chat: { completions: { create: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status })) } },
  });
  const msg = [{ role: 'user' as const, content: 'hi' }];

  it('returns trimmed completion and passes model', async () => {
    const c = ok('  hello Sir  ');
    expect(await new GroqService([c], ['m1']).complete(msg)).toBe('hello Sir');
    expect(c.chat.completions.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'm1' }));
  });
  it('throws when everything returns empty', async () => {
    await expect(new GroqService([ok(null)], ['m']).complete(msg)).rejects.toThrow(/All Groq/);
  });
  it('rotates to the next key on 429 and cools the limited key down', async () => {
    const limited = failing(429);
    const good = ok('done');
    const svc = new GroqService([limited, good], ['m']);
    expect(await svc.complete(msg)).toBe('done');
    await svc.complete(msg);
    await svc.complete(msg);
    expect(limited.chat.completions.create).toHaveBeenCalledTimes(1); // skipped while cooling
  });
  it('falls back to the next model when the first is unavailable', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: 'fallback' } }] });
    const svc = new GroqService([{ chat: { completions: { create } } }], ['primary', 'backup']);
    expect(await svc.complete(msg)).toBe('fallback');
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'backup' }));
  });
});
