import { describe, expect, it, vi } from 'vitest';
import { GroqTranscriber, STT_MODELS } from '../src/core/ai-engine/transcribe';

const ok = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as Response;
const fail = (status: number) => ({ ok: false, status }) as Response;
const form = (f: ReturnType<typeof vi.fn>, call = 0) => f.mock.calls[call]![1].body as FormData;
const make = (f: ReturnType<typeof vi.fn>, keys = ['k1'], models = ['m1', 'm2']) => new GroqTranscriber(keys, models, f as unknown as typeof fetch);

describe('GroqTranscriber', () => {
  it('uses the most accurate Whisper model first', () => {
    expect(STT_MODELS[0]).toBe('whisper-large-v3');
  });

  it('returns trimmed text and uses a matching file extension', async () => {
    const f = vi.fn().mockResolvedValue(ok('  hello Sir '));
    expect(await make(f).transcribe(Buffer.alloc(300), 'audio/mp4')).toBe('hello Sir');
    expect((form(f).get('file') as File).name).toBe('voice.m4a');
    expect(form(f).get('model')).toBe('m1');
    expect(String(form(f).get('prompt'))).toMatch(/Tamil Nadu/);
  });

  it('names video recordings .mp4 so the sound is read from them', async () => {
    const f = vi.fn().mockResolvedValue(ok('hi'));
    await make(f).transcribe(Buffer.alloc(300), 'video/mp4');
    expect((form(f).get('file') as File).name).toBe('voice.mp4');
  });

  it('passes a language hint, and ignores "auto" or nonsense', async () => {
    const f = vi.fn().mockResolvedValue(ok('vanakkam'));
    await make(f).transcribe(Buffer.alloc(300), 'audio/webm', 'ta');
    expect(form(f).get('language')).toBe('ta');
    await make(f).transcribe(Buffer.alloc(300), 'audio/webm', 'auto');
    await make(f).transcribe(Buffer.alloc(300), 'audio/webm', 'tamil!!');
    expect(form(f, 1).get('language')).toBeNull();
    expect(form(f, 2).get('language')).toBeNull();
  });

  it('moves to the next model when rate limited (the limit is account-wide, so other keys would not help)', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok('done'));
    expect(await make(f, ['k1', 'k2']).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('done');
    expect(f).toHaveBeenCalledTimes(2);
    expect(form(f, 1).get('model')).toBe('m2');
  });

  it('tries the next key on a server error', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok('ok'));
    expect(await make(f, ['k1', 'k2']).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('ok');
    expect(form(f, 1).get('model')).toBe('m1');
  });

  it('stops on bad audio for that model and throws when everything fails', async () => {
    const f = vi.fn().mockResolvedValue(fail(400));
    await expect(make(f, ['k1', 'k2']).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow(/failed/);
    expect(f).toHaveBeenCalledTimes(2); // one attempt per model
  });

  it('drops the invented text Whisper produces for silence', async () => {
    for (const filler of ['Thank you.', 'Thanks for watching', '.', 'you']) {
      expect(await make(vi.fn().mockResolvedValue(ok(filler))).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('');
    }
    expect(await make(vi.fn().mockResolvedValue(ok('Thank you for the reminder, Sir'))).transcribe(Buffer.alloc(300), 'audio/webm')).toBe('Thank you for the reminder, Sir');
  });
});
