/**
 * Sarvam AI: speech models built for Indian voices and accents.
 * - SarvamTranscriber: speech to text (Saarika, with Saaras as the second model). Understands Indian English and Tamil
 *   and detects the language by itself.
 * - SarvamSpeech: text to speech (Bulbul v3, the model that works on the free plan). Human-sounding voices for English and Tamil.
 *
 * Free-plan friendly: several API keys can be given (comma separated). A key that hits its limit or is refused rests for a
 * while and the next key is used; when every key is limited the caller falls back to Whisper (listening) or the Microsoft
 * voices (speaking), so nothing stops working. Keys are sent only to api.sarvam.ai.
 */
export const SARVAM_STT_MODELS = ['saarika:v2.5', 'saaras:v3'];
export const SARVAM_TTS_MODEL = 'bulbul:v3';

const LANGS: Record<string, string> = { en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN', te: 'te-IN', ml: 'ml-IN', kn: 'kn-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', pa: 'pa-IN' };

/** The language to speak, from the script the text is written in. */
export function detectLanguage(text: string): string {
  if (/[஀-௿]/.test(text)) return 'ta-IN';
  if (/[ऀ-ॿ]/.test(text)) return 'hi-IN';
  if (/[ఀ-౿]/.test(text)) return 'te-IN';
  if (/[ഀ-ൿ]/.test(text)) return 'ml-IN';
  if (/[ಀ-೿]/.test(text)) return 'kn-IN';
  return 'en-IN';
}

const extFor = (mime: string) =>
  /video\/mp4/i.test(mime) ? 'mp4' : /webm/i.test(mime) ? 'webm' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : /ogg|opus/i.test(mime) ? 'ogg' : /wav/i.test(mime) ? 'wav' : /mpeg|mp3/i.test(mime) ? 'mp3' : 'webm';

/** Hands out API keys in turn and rests a key for a while after it was limited or refused. */
export class KeyRing {
  private readonly restUntil = new Map<string, number>();
  private start = 0;

  constructor(
    private readonly keys: string[],
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.keys.length;
  }

  /** Keys that are not resting, beginning with the next one in turn. */
  ready(): string[] {
    const t = this.now();
    const n = this.keys.length;
    const first = n ? this.start++ % n : 0;
    return Array.from({ length: n }, (_, i) => this.keys[(first + i) % n]!).filter((k) => (this.restUntil.get(k) ?? 0) <= t);
  }

  rest(key: string, ms: number): void {
    this.restUntil.set(key, this.now() + ms);
  }
}

class SarvamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One request, rotating over keys: 429 rests a key for a minute, 401/403 for ten, 5xx/network moves on without resting. */
async function withKeys<T>(ring: KeyRing, what: string, attempt: (key: string) => Promise<T>): Promise<T> {
  let last: Error = new Error(`${what}: no API key`);
  for (const key of ring.ready()) {
    try {
      return await attempt(key);
    } catch (err) {
      last = err as Error;
      const status = (err as SarvamError).status;
      if (status === 429) ring.rest(key, 60_000);
      else if (status === 401 || status === 403) ring.rest(key, 600_000);
      else if (status && status < 500) throw err; // a request problem (bad model, bad audio): another key will not fix it
    }
  }
  throw last;
}

export class SarvamTranscriber {
  private readonly ring: KeyRing;

  constructor(
    apiKeys: string[],
    private readonly fetchFn: typeof fetch = fetch,
    private readonly models: string[] = SARVAM_STT_MODELS,
    now?: () => number,
  ) {
    this.ring = new KeyRing(apiKeys, now);
  }

  /** `language` is a two-letter hint (en, ta...); anything else means "detect it". Throws on failure so a fallback can take over. */
  async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
    let lastErr: Error = new Error('Sarvam transcription failed');
    for (const model of this.models) {
      try {
        return await withKeys(this.ring, 'Sarvam transcription', async (key) => {
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), `voice.${extFor(mime)}`);
          form.append('model', model);
          form.append('language_code', (language && LANGS[language.toLowerCase()]) || 'unknown');
          const res = await this.fetchFn('https://api.sarvam.ai/speech-to-text', {
            method: 'POST',
            headers: { 'api-subscription-key': key },
            body: form,
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new SarvamError(`Sarvam transcription failed (status ${res.status})`, res.status);
          return String(((await res.json()) as { transcript?: string }).transcript ?? '').trim();
        });
      } catch (err) {
        lastErr = err as Error;
        if ((err as SarvamError).status === 429 || (err as SarvamError).status === 403) break; // the limit is per account: the other model will not help
      }
    }
    throw lastErr;
  }
}

export class SarvamSpeech {
  private readonly ring: KeyRing;

  constructor(
    apiKeys: string[],
    private readonly fetchFn: typeof fetch = fetch,
    private readonly model = SARVAM_TTS_MODEL,
    now?: () => number,
  ) {
    this.ring = new KeyRing(apiKeys, now);
  }

  /** MP3 audio of `text` in the named voice (for example "priya"). */
  async synth(text: string, speaker: string): Promise<{ data: Buffer; mime: 'audio/mpeg' }> {
    const input = text.replace(/\s+/g, ' ').trim().slice(0, 2400);
    if (!input) throw new Error('Nothing to say');
    return withKeys(this.ring, 'Sarvam speech', async (key) => {
      const res = await this.fetchFn('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input,
          target_language_code: detectLanguage(input),
          speaker,
          model: this.model,
          pace: 1.0,
          speech_sample_rate: 24000,
          output_audio_codec: 'mp3',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new SarvamError(`Sarvam speech failed (status ${res.status})`, res.status);
      const b64 = ((await res.json()) as { audios?: string[] }).audios?.[0];
      const data = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
      if (data.length < 200) throw new Error('Sarvam returned no audio');
      return { data, mime: 'audio/mpeg' as const };
    });
  }
}
