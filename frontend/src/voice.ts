import { fetchSpeech, type Settings } from './api';
import { renderMarkdown } from './markdown';

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const canSpeak = () => typeof window !== 'undefined' && ('speechSynthesis' in window || 'Audio' in window);

export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
}

/** Starts the microphone. Rejects with a friendly Error if it is blocked or unavailable (needs https or localhost). */
export async function startRecording(): Promise<Recording> {
  if (!canRecord()) throw new Error('Voice needs a secure (https) page and a browser that can record audio.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new Error('Microphone access was blocked. Allow it in your browser settings and try again.');
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
  // A higher bitrate keeps consonants clear, which is what the transcriber struggles with first.
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  rec.start(250);
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          release();
          resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
        };
        if (rec.state === 'inactive') return done();
        rec.onstop = done;
        // keep recording for a moment so the last word is not cut off
        setTimeout(() => rec.state !== 'inactive' && rec.stop(), 350);
      }),
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}

/** Plain, speakable text from a Markdown reply. */
export function speakableText(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown), 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---- preferences ----
const VOICE_KEY = 'mj.voiceName';
const SPEAK_KEY = 'mj.speak';
const LANG_KEY = 'mj.sttLang';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

/** Replies are spoken by default; the owner can switch it off in Settings. */
export const readSpeakPref = () => read(SPEAK_KEY) !== '0';
export const writeSpeakPref = (on: boolean) => write(SPEAK_KEY, on ? '1' : '0');
/** A device voice name, or "groq:<name>" for one of the natural voices. */
export const readVoiceName = () => read(VOICE_KEY) ?? 'groq:hannah';
export const writeVoiceName = (name: string) => write(VOICE_KEY, name);
export type SttLang = 'auto' | 'en' | 'ta';
export const readSttLang = (): SttLang => (['en', 'ta'].includes(read(LANG_KEY) ?? '') ? (read(LANG_KEY) as SttLang) : 'auto');
export const writeSttLang = (l: SttLang) => write(LANG_KEY, l);

export const NATURAL_VOICES = [
  { id: 'groq:hannah', label: 'Hannah (female, warm)' },
  { id: 'groq:diana', label: 'Diana (female, clear)' },
  { id: 'groq:autumn', label: 'Autumn (female, soft)' },
  { id: 'groq:austin', label: 'Austin (male, relaxed)' },
  { id: 'groq:daniel', label: 'Daniel (male, calm)' },
  { id: 'groq:troy', label: 'Troy (male, deep)' },
];

/** Voices installed on this phone. They load late on some browsers, so callers should also listen for `voiceschanged`. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!('speechSynthesis' in window)) return [];
  const all = window.speechSynthesis.getVoices();
  const english = all.filter((v) => /^en(-|_|$)/i.test(v.lang) || /^ta(-|_|$)/i.test(v.lang));
  return (english.length ? english : all).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Why the natural voice was not used the last time ("" when it worked); shown next to the Test voice button. */
let note = '';
export const speechNote = () => note;

// ---- playback ----
let audio: HTMLAudioElement | null = null;
let run = 0; // bumped on every speak/stop so an old reply can never talk over a new one
const getAudio = () => (audio ??= new Audio());
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

/** Phones only allow sound after a tap: call this inside the tap handler so later replies can be spoken. */
export function unlockSpeech(): void {
  if (!canSpeak()) return;
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
  const a = getAudio();
  a.src = SILENT;
  void a.play().catch(() => undefined);
}

export function stopSpeaking(): void {
  run++;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Splits text into sentence-sized pieces (the natural voice takes ~200 characters at a time). */
function chunks(text: string, max = 170): string[] {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > max) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length > max + 30 ? (c.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [c]).map((x) => x.trim()) : [c]));
}

function pickDeviceVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const chosen = readVoiceName();
  const byName = chosen && !chosen.startsWith('groq:') ? voices.find((v) => v.name === chosen) : undefined;
  if (byName && (lang === 'en-IN' || byName.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))) return byName;
  const same = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang.slice(0, 2).toLowerCase()));
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase() ? 4 : 0) + (/natural|neural|online|google|enhanced|premium/i.test(v.name) ? 3 : 0) + (v.localService ? 0 : 1);
  return same.sort((a, b) => score(b) - score(a))[0];
}

function speakOnDevice(pieces: string[], lang: string, onEnd?: () => void): void {
  if (!('speechSynthesis' in window)) return onEnd?.();
  const voice = pickDeviceVoice(lang);
  pieces.forEach((piece, i) => {
    const u = new SpeechSynthesisUtterance(piece);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    if (i === pieces.length - 1) {
      u.onend = () => onEnd?.();
      u.onerror = () => onEnd?.();
    }
    window.speechSynthesis.speak(u);
  });
}

/** Plays one WAV through the shared audio element; resolves when it finishes (or throws if playback is blocked). */
function play(blob: Blob, myRun: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = getAudio();
    const url = URL.createObjectURL(blob);
    const done = () => {
      URL.revokeObjectURL(url);
      a.onended = a.onerror = null;
    };
    a.onended = () => (done(), resolve());
    a.onerror = () => (done(), reject(new Error('playback failed')));
    a.src = url;
    if (run !== myRun) return (done(), resolve());
    a.play().catch((e) => (done(), reject(e)));
  });
}

/** Natural voice, one sentence at a time, fetching the next while the current one plays. Falls back to the phone's voice on any problem. */
async function speakNatural(pieces: string[], voice: string, s: Settings, myRun: number, lang: string, onEnd?: () => void): Promise<void> {
  let next: Promise<Blob> | undefined = fetchSpeech(s, pieces[0]!, voice);
  next.catch(() => undefined);
  for (let i = 0; i < pieces.length; i++) {
    try {
      const blob = await next!;
      next = i + 1 < pieces.length ? fetchSpeech(s, pieces[i + 1]!, voice) : undefined;
      next?.catch(() => undefined);
      if (run !== myRun) return;
      await play(blob, myRun);
      if (run !== myRun) return;
    } catch (e) {
      if (run !== myRun) return;
      const m = (e as Error).message;
      note = m === 'tts_terms_required' ? 'Natural voices need a one-time approval in your Groq account (see the setup note). Using your phone voice for now.' : 'The natural voice is not available right now. Using your phone voice.';
      return speakOnDevice(pieces.slice(i), lang, onEnd);
    }
  }
  note = '';
  if (run === myRun) onEnd?.();
}

export function speak(markdown: string, onEnd?: () => void, settings?: Settings): void {
  if (!canSpeak()) return onEnd?.();
  stopSpeaking();
  const myRun = run;
  const text = speakableText(markdown).slice(0, 4000);
  if (!text) return onEnd?.();
  const tamil = /[஀-௿]/.test(text);
  const lang = tamil ? 'ta-IN' : 'en-IN';
  const pieces = chunks(text);
  const voice = readVoiceName();
  if (voice.startsWith('groq:') && settings?.token && !tamil) void speakNatural(pieces, voice.slice(5), settings, myRun, lang, onEnd);
  else speakOnDevice(pieces, lang, onEnd);
}

/** Replies the app itself produces when something went wrong should be shown, not read aloud. */
export const isFailureReply = (t: string) => /^(Apologies, Sir\.|Sir, my AI service is busy)/.test(t);
