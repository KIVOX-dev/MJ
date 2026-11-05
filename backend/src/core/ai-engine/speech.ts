/**
 * Natural-sounding speech through Groq's Orpheus text-to-speech model, so replies do not sound like a phone's built-in robot voice.
 * Each request is limited to ~200 characters, so the app sends one sentence at a time.
 */
export const TTS_MODEL = 'canopylabs/orpheus-v1-english';
export const TTS_VOICES = ['hannah', 'diana', 'autumn', 'austin', 'daniel', 'troy'] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const TTS_MAX_CHARS = 200;

/** The account has not accepted the model's terms yet (a one-time click in the Groq console). */
export class TtsTermsRequired extends Error {
  constructor() {
    super('Natural voices need the Groq model terms to be accepted once at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english');
  }
}

export class GroqSpeech {
  constructor(
    private readonly apiKeys: string[],
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Returns WAV audio for a short piece of text. */
  async synth(text: string, voice: TtsVoice = 'hannah'): Promise<Buffer> {
    const input = text.replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
    if (!input) throw new Error('Nothing to say');
    let lastErr = 'no API key';
    for (const key of this.apiKeys) {
      try {
        const res = await this.fetchFn('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: TTS_MODEL, voice, input, response_format: 'wav' }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        const body = await res.text().catch(() => '');
        if (/model_terms_required/.test(body)) throw new TtsTermsRequired();
        lastErr = `status ${res.status}`;
        if (res.status === 400 || res.status === 429) break; // account-wide: other keys will not help
      } catch (err) {
        if (err instanceof TtsTermsRequired) throw err;
        lastErr = (err as Error).message;
      }
    }
    throw new Error(`Speech failed (${lastErr})`);
  }
}
