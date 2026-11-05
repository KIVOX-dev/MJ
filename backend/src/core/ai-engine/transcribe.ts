/**
 * Speech-to-text through Groq's Whisper endpoint.
 * - The most accurate model (whisper-large-v3) is tried first, then the faster turbo model if it is busy or fails.
 * - A language hint ("en", "ta", ...) stops Whisper guessing the wrong language for accented speech.
 * - A short vocabulary prompt helps with names and Indian English.
 * - Each API key is tried in turn so one rate-limited key does not stop voice.
 */
export const STT_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'];

const PROMPT =
  'Conversation with a personal assistant called MJ. The speaker is from Tamil Nadu, India, and speaks Indian English, sometimes with Tamil words. ' +
  'Words that may come up: Sir, MJ, reminder, remind me, Telegram, email, news, Chennai, Coimbatore, Kovai, Madurai, Tamil Nadu, Kollywood, MJ Times.';

/** Whisper invents text for silence ("Thank you for watching"): drop transcripts that are only such filler. */
const FILLER = /^(thanks?( you)?( so much)?( for watching)?|bye|you|okay|\.+)[.!\s]*$/i;

export class GroqTranscriber {
  constructor(
    private readonly apiKeys: string[],
    private readonly models: string[] = STT_MODELS,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
    const ext = /video\/mp4/i.test(mime) ? 'mp4' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : /ogg/i.test(mime) ? 'ogg' : /wav/i.test(mime) ? 'wav' : /mpeg|mp3/i.test(mime) ? 'mp3' : 'webm';
    const lang = language && /^[a-z]{2}$/i.test(language) && language !== 'auto' ? language.toLowerCase() : undefined;
    let lastErr = 'no API key';
    for (const model of this.models) {
      for (const key of this.apiKeys) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), `voice.${ext}`);
        form.append('model', model);
        form.append('response_format', 'json');
        form.append('temperature', '0');
        if (lang) form.append('language', lang);
        form.append('prompt', PROMPT);
        try {
          const res = await this.fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.timeout(30_000),
          });
          if (res.ok) {
            const text = String(((await res.json()) as { text?: string }).text ?? '').trim();
            return FILLER.test(text) ? '' : text;
          }
          lastErr = `status ${res.status}`;
          if (res.status === 400 || res.status === 413) break; // the audio itself is bad: another key will not help
          if (res.status === 429) break; // account-wide limit: try the next model instead of every key
        } catch (err) {
          lastErr = (err as Error).message;
        }
      }
    }
    throw new Error(`Transcription failed (${lastErr})`);
  }
}

/** Tries each transcriber in turn (for example Sarvam, then Whisper). An empty transcript is a valid answer ("nothing was said"), not a failure. */
export class TranscriberChain {
  constructor(private readonly list: Array<{ transcribe(audio: Buffer, mime: string, language?: string): Promise<string> }>) {}

  async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
    let last: unknown;
    for (const t of this.list) {
      try {
        return await t.transcribe(audio, mime, language);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('Transcription failed');
  }
}
