import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import type { MessageStore } from '../src/core/memory/message.store';

const TOKEN = 'web-token-1234567890';
function setup() {
  const log: Array<{ direction: 'in' | 'out'; text: string }> = [];
  const store: MessageStore = {
    claimInbound: async (_i, _f, text) => (log.push({ direction: 'in', text }), true),
    saveOutbound: async (_i, _t, text) => void log.push({ direction: 'out', text }),
    recent: async () => log,
  };
  const respond = vi.fn().mockResolvedValue('Certainly, Sir.');
  const app = createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond, store, ownerChatId: '555' })] });
  return { app, respond };
}

describe('web chat api', () => {
  it('rejects missing or wrong tokens', async () => {
    const { app, respond } = setup();
    expect((await request(app).post('/api/chat').send({ query: 'hi' })).status).toBe(401);
    expect((await request(app).get('/api/history').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect(respond).not.toHaveBeenCalled();
  });

  it('answers as the owner on the telegram channel and records history', async () => {
    const { app, respond } = setup();
    const res = await request(app).post('/api/chat').set('Authorization', `Bearer ${TOKEN}`).send({ query: 'plan my day' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Certainly, Sir.');
    expect(respond).toHaveBeenCalledWith('plan my day', { channel: 'telegram', chatId: '555' });
    const h = await request(app).get('/api/history').set('Authorization', `Bearer ${TOKEN}`);
    expect(h.body.messages).toEqual([
      { role: 'user', text: 'plan my day' },
      { role: 'assistant', text: 'Certainly, Sir.' },
    ]);
  });

  it('rejects empty and oversized messages', async () => {
    const { app } = setup();
    const a = await request(app).post('/api/chat').set('Authorization', `Bearer ${TOKEN}`).send({ query: '  ' });
    const b = await request(app).post('/api/chat').set('Authorization', `Bearer ${TOKEN}`).send({ query: 'x'.repeat(4001) });
    expect([a.status, b.status]).toEqual([400, 400]);
  });
});

describe('web voice transcription', () => {
  const build = (transcribe?: (a: Buffer, m: string) => Promise<string>) =>
    createApp({
      isDbConnected: () => true,
      extraRouters: [webChatRouter({ token: TOKEN, respond: vi.fn(), store: { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] }, ownerChatId: '555', transcribe })],
    });
  const audio = Buffer.alloc(600, 1);

  it('requires the token and returns the transcript', async () => {
    const tr = vi.fn().mockResolvedValue('remind me at six');
    const app = build(tr);
    expect((await request(app).post('/api/transcribe').set('Content-Type', 'audio/webm').send(audio)).status).toBe(401);
    const ok = await request(app).post('/api/transcribe').set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'audio/webm;codecs=opus').send(audio);
    expect(ok.body).toEqual({ text: 'remind me at six' });
    expect(tr).toHaveBeenCalledWith(expect.any(Buffer), 'audio/webm;codecs=opus');
  });

  it('rejects tiny bodies, reports provider failure, and is absent when not configured', async () => {
    const bad = await request(build(vi.fn())).post('/api/transcribe').set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'audio/webm').send(Buffer.alloc(10));
    const down = await request(build(vi.fn().mockRejectedValue(new Error('x')))).post('/api/transcribe').set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'audio/webm').send(audio);
    const none = await request(build()).post('/api/transcribe').set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'audio/webm').send(audio);
    expect([bad.status, down.status, none.status]).toEqual([400, 502, 404]);
  });
});
