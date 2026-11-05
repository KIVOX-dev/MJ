import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { logger } from '../../utils/logger';

/**
 * Human-sounding speech for replies, so MJ does not sound like a phone's built-in robot voice.
 *
 * Three engines, chosen by the voice id the app asks for (and each falls back to the Microsoft voice if it fails):
 *  - "sarvam:<voice>"  Sarvam AI Bulbul v3: voices made for Indian speech, English and Tamil. Needs SARVAM_API_KEY.
 *  - "edge:<voice>"  Microsoft neural voices (the ones Edge reads pages with). No account or key. Includes Indian English and Tamil.
 *  - "groq:<voice>"  Groq's Orpheus voices. Needs the Groq model terms to be accepted once in the Groq console.
 */
export interface Voice {
  id: string;
  label: string;
}

export const EDGE_VOICES: Voice[] = [
  { id: 'edge:en-IN-NeerjaNeural', label: 'Neerja (Indian English, sweet female)' },
  { id: 'edge:en-IN-PrabhatNeural', label: 'Prabhat (Indian English, warm male)' },
  { id: 'edge:en-US-AriaNeural', label: 'Aria (US, expressive female)' },
  { id: 'edge:en-US-JennyNeural', label: 'Jenny (US, friendly female)' },
  { id: 'edge:en-GB-SoniaNeural', label: 'Sonia (UK, gentle female)' },
  { id: 'edge:en-US-GuyNeural', label: 'Guy (US, friendly male)' },
  { id: 'edge:ta-IN-PallaviNeural', label: 'Pallavi (Tamil, female)' },
  { id: 'edge:ta-IN-ValluvarNeural', label: 'Valluvar (Tamil, male)' },
];

export const SARVAM_VOICES: Voice[] = [
  { id: 'sarvam:priya', label: 'Priya (warm female)' },
  { id: 'sarvam:ritu', label: 'Ritu (bright female)' },
  { id: 'sarvam:kavya', label: 'Kavya (gentle female)' },
  { id: 'sarvam:ishita', label: 'Ishita (friendly female)' },
  { id: 'sarvam:simran', label: 'Simran (calm female)' },
  { id: 'sarvam:shreya', label: 'Shreya (soft female)' },
  { id: 'sarvam:pooja', label: 'Pooja (cheerful female)' },
  { id: 'sarvam:neha', label: 'Neha (clear female)' },
  { id: 'sarvam:shubh', label: 'Shubh (warm male)' },
  { id: 'sarvam:aditya', label: 'Aditya (friendly male)' },
  { id: 'sarvam:rahul', label: 'Rahul (calm male)' },
  { id: 'sarvam:rohan', label: 'Rohan (deep male)' },
];

export const GROQ_VOICES: Voice[] = [
  { id: 'groq:hannah', label: 'Hannah (Groq, female)' },
  { id: 'groq:diana', label: 'Diana (Groq, female)' },
  { id: 'groq:autumn', label: 'Autumn (Groq, female)' },
  { id: 'groq:austin', label: 'Austin (Groq, male)' },
  { id: 'groq:daniel', label: 'Daniel (Groq, male)' },
  { id: 'groq:troy', label: 'Troy (Groq, male)' },
];

export const VOICE_IDS = [...SARVAM_VOICES, ...EDGE_VOICES, ...GROQ_VOICES].map((v) => v.id) as [string, ...string[]];
export const DEFAULT_VOICE = 'edge:en-IN-NeerjaNeural';

export const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
export const EDGE_MAX_CHARS = 1200;
export const GROQ_MAX_CHARS = 200;
/** The longest text any voice accepts in one request. */
export const TTS_MAX_CHARS = EDGE_MAX_CHARS;

export interface Speech {
  data: Buffer;
  mime: 'audio/mpeg' | 'audio/wav';
}

/** The account has not accepted the Groq model's terms yet (a one-time click in the Groq console). */
export class TtsTermsRequired extends Error {
  constructor() {
    super('The Groq voices need the model terms to be accepted once at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english');
  }
}

const clean = (t: string) => t.replace(/\s+/g, ' ').trim();

export class EdgeSpeech {
  constructor(private readonly timeoutMs = 25_000) {}

  async synth(text: string, voiceName: string): Promise<Speech> {
    const input = clean(text).slice(0, EDGE_MAX_CHARS);
    if (!input) throw new Error('Nothing to say');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(input);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('speech timed out')), this.timeoutMs);
      audioStream.on('data', (d: Buffer) => chunks.push(d));
      audioStream.on('end', () => (clearTimeout(timer), resolve()));
      audioStream.on('error', (e: Error) => (clearTimeout(timer), reject(e)));
    });
    const data = Buffer.concat(chunks);
    if (data.length < 200) throw new Error('speech was empty');
    tts.close?.();
    return { data, mime: 'audio/mpeg' };
  }
}

export class GroqSpeech {
  constructor(
    private readonly apiKeys: string[],
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Returns WAV audio for a short piece of text. */
  async synth(text: string, voice: string): Promise<Speech> {
    const input = clean(text).slice(0, GROQ_MAX_CHARS);
    if (!input) throw new Error('Nothing to say');
    let lastErr = 'no API key';
    for (const key of this.apiKeys) {
      try {
        const res = await this.fetchFn('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: GROQ_TTS_MODEL, voice, input, response_format: 'wav' }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return { data: Buffer.from(await res.arrayBuffer()), mime: 'audio/wav' };
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

type Synth = { synth(text: string, name: string): Promise<Speech> };

/**
 * Picks the engine from the voice id ("sarvam:...", "edge:..." or "groq:...") and enforces each engine's text limit.
 * If the chosen engine fails, the Microsoft neural voice speaks instead so a reply is never silent
 * (except "Groq terms not accepted", which is reported so the app can explain it).
 */
export class Speaker {
  constructor(private readonly engines: { edge: Synth; groq: Synth; sarvam?: Synth }) {}

  async synth(text: string, voiceId: string): Promise<Speech> {
    const [engine, name] = voiceId.split(':') as [string, string];
    const chosen = this.engines[engine as 'edge' | 'groq' | 'sarvam'];
    if (chosen) {
      try {
        return await chosen.synth(engine === 'groq' ? text.slice(0, GROQ_MAX_CHARS) : text, name);
      } catch (err) {
        if (err instanceof TtsTermsRequired || engine === 'edge') throw err;
        logger.warn({ engine, err: { message: (err as Error).message } }, 'Voice engine failed, using the Microsoft voice');
      }
    }
    return this.engines.edge.synth(text, /[\u0B80-\u0BFF]/.test(text) ? 'ta-IN-PallaviNeural' : 'en-IN-NeerjaNeural');
  }
}
