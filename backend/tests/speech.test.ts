import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import { DEFAULT_VOICE, EDGE_VOICES, GroqSpeech, Speaker, TtsTermsRequired, VOICE_IDS, type Speech } from '../src/core/ai-engine/speech';
import type { MessageStore } from '../src/core/memory/message.store';

const wav = (n = 100) => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(n).buffer }) as Response;
const err = (status: number, body = '') => ({ ok: false, status, text: async () => body }) as Response;

describe('GroqSpeech', () => {
  it('asks for a WAV in the chosen voice and returns the audio', async () => {
    const f = vi.fn().mockResolvedValue(wav(64));
    const out = await new GroqSpeech(['k'], f as unknown as typeof fetch).synth('  Good day,   Sir.  ', 'diana');
    expect(out.data.length).toBe(64);
    expect(out.mime).toBe('audio/wav');
    expect(JSON.parse(f.mock.calls[0]![1].body as string)).toMatchObject({ model: 'canopylabs/orpheus-v1-english', voice: 'diana', input: 'Good day, Sir.', response_format: 'wav' });
  });

  it('reports when the model terms have not been accepted yet', async () => {
    const f = vi.fn().mockResolvedValue(err(400, '{"error":{"code":"model_terms_required"}}'));
    await expect(new GroqSpeech(['k1', 'k2'], f as unknown as typeof fetch).synth('hi', 'hannah')).rejects.toBeInstanceOf(TtsTermsRequired);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tries the next key on a server error, and fails clearly when nothing works', async () => {
    const f = vi.fn().mockResolvedValueOnce(err(503)).mockResolvedValueOnce(wav());
    expect((await new GroqSpeech(['k1', 'k2'], f as unknown as typeof fetch).synth('hi', 'hannah')).data.length).toBe(100);
    await expect(new GroqSpeech(['k'], vi.fn().mockResolvedValue(err(500)) as unknown as typeof fetch).synth('hi', 'hannah')).rejects.toThrow(/Speech failed/);
  });
});

describe('Speaker', () => {
  const speech = (mime: Speech['mime']): Speech => ({ data: Buffer.from('x'), mime });
  const engines = () => ({
    edge: { synth: vi.fn().mockResolvedValue(speech('audio/mpeg')) },
    groq: { synth: vi.fn().mockResolvedValue(speech('audio/wav')) },
    sarvam: { synth: vi.fn().mockResolvedValue(speech('audio/mpeg')) },
  });

  it('sends each voice id to its own engine, trimming Groq text to its limit', async () => {
    const e = engines();
    const sp = new Speaker(e);
    await sp.synth('hello', 'edge:en-IN-NeerjaNeural');
    expect(e.edge.synth).toHaveBeenCalledWith('hello', 'en-IN-NeerjaNeural');
    await sp.synth('hello', 'sarvam:priya');
    expect(e.sarvam.synth).toHaveBeenCalledWith('hello', 'priya');
    await sp.synth('y'.repeat(500), 'groq:hannah');
    expect(e.groq.synth.mock.calls[0]![0]).toHaveLength(200);
    expect(e.groq.synth.mock.calls[0]![1]).toBe('hannah');
  });

  it('falls back to the Microsoft voice (Tamil-aware) when Sarvam fails, so a reply is never silent', async () => {
    const e = engines();
    e.sarvam.synth.mockRejectedValue(new Error('Sarvam down'));
    const sp = new Speaker(e);
    await sp.synth('Good day', 'sarvam:priya');
    expect(e.edge.synth).toHaveBeenLastCalledWith('Good day', 'en-IN-NeerjaNeural');
    await sp.synth('வணக்கம்', 'sarvam:priya');
    expect(e.edge.synth).toHaveBeenLastCalledWith('வணக்கம்', 'ta-IN-PallaviNeural');
  });

  it('uses the Microsoft voice when no Sarvam key is configured, and still reports unaccepted Groq terms', async () => {
    const e = engines();
    await new Speaker({ edge: e.edge, groq: e.groq }).synth('hi', 'sarvam:priya');
    expect(e.edge.synth).toHaveBeenCalled();
    e.groq.synth.mockRejectedValue(new TtsTermsRequired());
    await expect(new Speaker(e).synth('hi', 'groq:hannah')).rejects.toBeInstanceOf(TtsTermsRequired);
  });

  it('offers Sarvam, Indian English and Tamil voices', () => {
    expect(DEFAULT_VOICE).toBe('edge:en-IN-NeerjaNeural');
    expect(VOICE_IDS).toEqual(expect.arrayContaining(['sarvam:priya', 'edge:en-IN-NeerjaNeural', 'edge:ta-IN-PallaviNeural', 'groq:hannah']));
    expect(EDGE_VOICES.length).toBeGreaterThan(5);
  });
});

const TOKEN = 'web-token-1234567890';
const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] };
const app = (speak?: (t: string, v: string) => Promise<Speech>, voices?: { default: string; voices: Array<{ id: string; label: string }> }) =>
  createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond: vi.fn(), store, ownerChatId: '1', speak, voices })] });
const auth = { Authorization: `Bearer ${TOKEN}` };

describe('POST /api/tts', () => {
  it('needs the token and returns the audio with its real type', async () => {
    const speak = vi.fn().mockResolvedValue({ data: Buffer.from('ID3xxxx'), mime: 'audio/mpeg' });
    expect((await request(app(speak)).post('/api/tts').send({ text: 'hi' })).status).toBe(401);
    const res = await request(app(speak)).post('/api/tts').set(auth).send({ text: 'Good day, Sir.', voice: 'sarvam:priya' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(speak).toHaveBeenCalledWith('Good day, Sir.', 'sarvam:priya');
  });

  it('uses the server default voice when none is chosen', async () => {
    const speak = vi.fn().mockResolvedValue({ data: Buffer.from('ID3xxxx'), mime: 'audio/mpeg' });
    await request(app(speak, { default: 'sarvam:priya', voices: [] })).post('/api/tts').set(auth).send({ text: 'no voice chosen' });
    expect(speak).toHaveBeenLastCalledWith('no voice chosen', 'sarvam:priya');
    await request(app(speak)).post('/api/tts').set(auth).send({ text: 'plain default' });
    expect(speak).toHaveBeenLastCalledWith('plain default', 'edge:en-IN-NeerjaNeural');
  });

  it('validates the text and the voice, and lists the configured voices', async () => {
    const speak = vi.fn();
    for (const body of [{ text: '' }, { text: 'x'.repeat(1201) }, { text: 'hi', voice: 'robot' }, { text: 'hi', voice: 'edge:../../etc/passwd' }]) {
      expect((await request(app(speak)).post('/api/tts').set(auth).send(body)).status).toBe(400);
    }
    expect(speak).not.toHaveBeenCalled();
    const menu = { default: 'sarvam:priya', voices: [{ id: 'sarvam:priya', label: 'Priya' }] };
    const list = await request(app(speak, menu)).get('/api/tts/voices').set(auth);
    expect(list.body).toEqual(menu);
  });

  it('tells the app when Groq terms are not accepted, fails softly, and is absent when not configured', async () => {
    const terms = vi.fn().mockRejectedValue(new TtsTermsRequired());
    const res = await request(app(terms)).post('/api/tts').set(auth).send({ text: 'hi', voice: 'groq:hannah' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('tts_terms_required');
    expect((await request(app(vi.fn().mockRejectedValue(new Error('down')))).post('/api/tts').set(auth).send({ text: 'hi' })).status).toBe(502);
    expect((await request(app()).post('/api/tts').set(auth).send({ text: 'hi' })).status).toBe(404);
  });
});
