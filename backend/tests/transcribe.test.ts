import { describe, expect, it, vi } from 'vitest';
import { GroqTranscriber } from '../src/core/ai-engine/transcribe';

const ok = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as Response;
const fail = (status: number) => ({ ok: false, status }) as Response;

describe('GroqTranscriber', () => {
  it('returns trimmed text and uses a matching file extension', async () => {
    const f = vi.fn().mockResolvedValue(ok('  hello Sir '));
    const t = new GroqTranscriber(['k1'], 'm', f as unknown as typeof fetch);
    expect(await t.transcribe(Buffer.alloc(300), 'audio/mp4')).toBe('hello Sir');
    const form = f.mock.calls[0]![1].body as FormData;
    expect((form.get('file') as File).name).toBe('voice.m4a');
  });

  it('names video recordings .mp4 so the sound is read from them', async () => {
    const f = vi.fn().mockResolvedValue(ok('hi'));
    await new GroqTranscriber(['k1'], 'm', f as unknown as typeof fetch).transcribe(Buffer.alloc(300), 'video/mp4');
    expect(((f.mock.calls[0]![1].body as FormData).get('file') as File).name).toBe('voice.mp4');
  });

  it('falls back to the next key when one is rate limited', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok('done'));
    const t = new GroqTranscriber(['k1', 'k2'], 'm', f as unknown as typeof fetch);
    expect(await t.transcribe(Buffer.alloc(300), 'audio/webm')).toBe('done');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('stops on bad audio and throws when everything fails', async () => {
    const f = vi.fn().mockResolvedValue(fail(400));
    await expect(new GroqTranscriber(['k1', 'k2'], 'm', f as unknown as typeof fetch).transcribe(Buffer.alloc(300), 'audio/webm')).rejects.toThrow(/failed/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
