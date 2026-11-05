import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import { GroqSpeech, TtsTermsRequired } from '../src/core/ai-engine/speech';
import type { MessageStore } from '../src/core/memory/message.store';

const wav = (n = 100) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(n).buffer }) as Response;
const err = (status: number, body = '') => ({ ok: false, status, text: async () => body }) as Response;

describe('GroqSpeech', () => {
  it('asks for a WAV in the chosen voice and returns the audio', async () => {
    const f = vi.fn().mockResolvedValue(wav(64));
    const out = await new GroqSpeech(['k'], f as unknown as typeof fetch).synth('  Good day,   Sir.  ', 'diana');
    expect(out.length).toBe(64);
    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ model: 'canopylabs/orpheus-v1-english', voice: 'diana', input: 'Good day, Sir.', response_format: 'wav' });
  });

  it('reports when the model terms have not been accepted yet', async () => {
    const f = vi.fn().mockResolvedValue(err(400, '{"error":{"code":"model_terms_required"}}'));
    await expect(new GroqSpeech(['k1', 'k2'], f as unknown as typeof fetch).synth('hi')).rejects.toBeInstanceOf(TtsTermsRequired);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tries the next key on a server error, and fails clearly when nothing works', async () => {
    const f = vi.fn().mockResolvedValueOnce(err(503)).mockResolvedValueOnce(wav());
    expect((await new GroqSpeech(['k1', 'k2'], f as unknown as typeof fetch).synth('hi')).length).toBe(100);
    await expect(new GroqSpeech(['k'], vi.fn().mockResolvedValue(err(500)) as unknown as typeof fetch).synth('hi')).rejects.toThrow(/Speech failed/);
  });
});

const TOKEN = 'web-token-1234567890';
const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] };
const app = (speak?: (t: string, v: string) => Promise<Buffer>) =>
  createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond: vi.fn(), store, ownerChatId: '1', speak: speak as never })] });
const auth = { Authorization: `Bearer ${TOKEN}` };

describe('POST /api/tts', () => {
  it('needs the token and returns audio/wav', async () => {
    const speak = vi.fn().mockResolvedValue(Buffer.from('RIFFxxxx'));
    expect((await request(app(speak)).post('/api/tts').send({ text: 'hi' })).status).toBe(401);
    const res = await request(app(speak)).post('/api/tts').set(auth).send({ text: 'Good day, Sir.', voice: 'austin' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect(speak).toHaveBeenCalledWith('Good day, Sir.', 'austin');
  });

  it('validates the text and the voice', async () => {
    const speak = vi.fn();
    for (const body of [{ text: '' }, { text: 'x'.repeat(201) }, { text: 'hi', voice: 'robot' }]) {
      expect((await request(app(speak)).post('/api/tts').set(auth).send(body)).status).toBe(400);
    }
    expect(speak).not.toHaveBeenCalled();
  });

  it('tells the app when the terms are not accepted, and is absent when not configured', async () => {
    const terms = vi.fn().mockRejectedValue(new TtsTermsRequired());
    const res = await request(app(terms)).post('/api/tts').set(auth).send({ text: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('tts_terms_required');
    expect((await request(app()).post('/api/tts').set(auth).send({ text: 'hi' })).status).toBe(404);
  });
});
