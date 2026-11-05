import { describe, expect, it, vi } from 'vitest';
import { KeyRing, SarvamSpeech, SarvamTranscriber, detectLanguage } from '../src/core/ai-engine/sarvam';
import { TranscriberChain } from '../src/core/ai-engine/transcribe';

const json = (o: unknown, status = 200) => ({ ok: status < 300, status, json: async () => o }) as Response;
const form = (f: ReturnType<typeof vi.fn>, call = 0) => f.mock.calls[call]![1].body as FormData;
const keyOf = (f: ReturnType<typeof vi.fn>, call = 0) => f.mock.calls[call]![1].headers['api-subscription-key'] as string;
const fx = (f: ReturnType<typeof vi.fn>) => f as unknown as typeof fetch;

describe('SarvamTranscriber', () => {
  it('sends the recording with the key in the Sarvam header, and returns the transcript', async () => {
    const f = vi.fn().mockResolvedValue(json({ transcript: '  Remind me at six  ', language_code: 'en-IN' }));
    const out = await new SarvamTranscriber(['KEY'], fx(f)).transcribe(Buffer.alloc(300), 'audio/webm;codecs=opus');
    expect(out).toBe('Remind me at six');
    expect(f.mock.calls[0]![0]).toBe('https://api.sarvam.ai/speech-to-text');
    expect(keyOf(f)).toBe('KEY');
    expect(form(f).get('model')).toBe('saarika:v2.5');
    expect((form(f).get('file') as File).name).toBe('voice.webm');
  });

  it('maps the language hint, and detects the language when none is given', async () => {
    const f = vi.fn().mockResolvedValue(json({ transcript: 'x' }));
    const t = new SarvamTranscriber(['K'], fx(f));
    await t.transcribe(Buffer.alloc(300), 'audio/ogg', 'ta');
    expect(form(f, 0).get('language_code')).toBe('ta-IN');
    await t.transcribe(Buffer.alloc(300), 'audio/ogg');
    expect(form(f, 1).get('language_code')).toBe('unknown');
    await t.transcribe(Buffer.alloc(300), 'audio/ogg', 'auto');
    expect(form(f, 2).get('language_code')).toBe('unknown');
  });

  it('rotates to the next key when one is limited, and rests the limited key', async () => {
    let t = 1_000;
    const f = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValue(json({ transcript: 'ok' }));
    const s = new SarvamTranscriber(['K1', 'K2'], fx(f), undefined, () => t);
    expect(await s.transcribe(Buffer.alloc(300), 'audio/webm')).toBe('ok');
    expect([keyOf(f, 0), keyOf(f, 1)]).toEqual(['K1', 'K2']);
    f.mockClear();
    await s.transcribe(Buffer.alloc(300), 'audio/webm');
    expect(keyOf(f, 0)).toBe('K2'); // K1 is still resting
    t += 61_000;
    f.mockClear();
    await s.transcribe(Buffer.alloc(300), 'audio/webm');
    await s.transcribe(Buffer.alloc(300), 'audio/webm');
    expect(new Set([keyOf(f, 0), keyOf(f, 1)])).toEqual(new Set(['K1', 'K2'])); // K1 is back after a minute
  });

  it('throws when every key is limited or refused, so Whisper can take over', async () => {
    const f = vi.fn().mockResolvedValue(json({}, 429));
    await expect(new SarvamTranscriber(['K1', 'K2'], fx(f)).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow(/status 429/);
    expect(f).toHaveBeenCalledTimes(2);
    await expect(new SarvamTranscriber(['K'], fx(vi.fn().mockResolvedValue(json({}, 403)))).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow(/status 403/);
  });

  it('tries the second model only for request problems, not for limits', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 400)).mockResolvedValueOnce(json({ transcript: 'from saaras' }));
    expect(await new SarvamTranscriber(['K'], fx(f)).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('from saaras');
    expect(form(f, 1).get('model')).toBe('saaras:v3');
    const limited = vi.fn().mockResolvedValue(json({}, 429));
    await expect(new SarvamTranscriber(['K'], fx(limited)).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow();
    expect(limited).toHaveBeenCalledTimes(1);
  });
});

describe('SarvamSpeech', () => {
  it('asks the free-plan model Bulbul v3 for an MP3 in the right language and decodes it', async () => {
    const mp3 = Buffer.alloc(400, 7);
    const f = vi.fn().mockResolvedValue(json({ audios: [mp3.toString('base64')] }));
    const out = await new SarvamSpeech(['KEY'], fx(f)).synth('வணக்கம் ஐயா', 'priya');
    expect(out.mime).toBe('audio/mpeg');
    expect(out.data.equals(mp3)).toBe(true);
    expect(JSON.parse(f.mock.calls[0]![1].body)).toMatchObject({ speaker: 'priya', model: 'bulbul:v3', target_language_code: 'ta-IN', output_audio_codec: 'mp3', speech_sample_rate: 24000 });
  });

  it('uses the next key when one is limited, and fails clearly on errors or empty audio', async () => {
    const mp3 = Buffer.alloc(400, 1).toString('base64');
    const f = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({ audios: [mp3] }));
    expect((await new SarvamSpeech(['K1', 'K2'], fx(f)).synth('hi', 'priya')).data.length).toBe(400);
    await expect(new SarvamSpeech(['K'], fx(vi.fn().mockResolvedValue(json({}, 400)))).synth('hi', 'priya')).rejects.toThrow(/status 400/);
    await expect(new SarvamSpeech(['K'], fx(vi.fn().mockResolvedValue(json({ audios: [] })))).synth('hi', 'priya')).rejects.toThrow(/no audio/);
    await expect(new SarvamSpeech(['K'], fx(vi.fn())).synth('   ', 'priya')).rejects.toThrow(/Nothing to say/);
  });

  it('picks the language from the script', () => {
    expect([detectLanguage('Good day'), detectLanguage('வணக்கம்'), detectLanguage('नमस्ते'), detectLanguage('Hello வணக்கம்')]).toEqual(['en-IN', 'ta-IN', 'hi-IN', 'ta-IN']);
  });
});

describe('KeyRing', () => {
  it('rotates, rests, and reports an empty ring', () => {
    let t = 0;
    const ring = new KeyRing(['a', 'b', 'c'], () => t);
    expect(ring.ready()).toEqual(['a', 'b', 'c']);
    expect(ring.ready()).toEqual(['b', 'c', 'a']);
    ring.rest('c', 1000);
    expect(ring.ready()).not.toContain('c');
    t = 1001;
    expect(ring.ready()).toContain('c');
    expect(new KeyRing([]).ready()).toEqual([]);
  });
});

describe('TranscriberChain', () => {
  it('uses the first engine that answers, and treats silence as an answer, not a failure', async () => {
    const a = { transcribe: vi.fn().mockResolvedValue('') };
    const b = { transcribe: vi.fn().mockResolvedValue('from the backup') };
    expect(await new TranscriberChain([a, b]).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('');
    expect(b.transcribe).not.toHaveBeenCalled();
  });

  it('falls back when an engine throws, and throws when all do', async () => {
    const bad = { transcribe: vi.fn().mockRejectedValue(new Error('sarvam down')) };
    const ok = { transcribe: vi.fn().mockResolvedValue('backup works') };
    expect(await new TranscriberChain([bad, ok]).transcribe(Buffer.alloc(300), 'audio/webm', 'en')).toBe('backup works');
    expect(ok.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio/webm', 'en');
    await expect(new TranscriberChain([bad, bad]).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow(/sarvam down/);
  });
});
