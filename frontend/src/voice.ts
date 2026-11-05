import { fetchSpeech, type Settings } from './api';
import { renderMarkdown, splitDrafts } from './markdown';

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const canSpeak = () => typeof window !== 'undefined' && ('speechSynthesis' in window || 'Audio' in window);

// ---------------------------------------------------------------- recording
export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
}

const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));

async function openMic(): Promise<MediaStream> {
  if (!canRecord()) throw new Error('Voice needs a secure (https) page and a browser that can record audio.');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new Error('Microphone access was blocked. Allow it in your browser settings and try again.');
  }
}

/** Press-to-talk recording (the mic button in the message box). */
export async function startRecording(): Promise<Recording> {
  const stream = await openMic();
  const mime = pickMime();
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
        setTimeout(() => rec.state !== 'inactive' && rec.stop(), 350); // keep recording a moment so the last word is not cut off
      }),
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
  };
}

export interface Listener {
  /** The recorded speech, or null if nothing was said for a while or listening was cancelled. */
  done: Promise<Blob | null>;
  /** Stop now and send what was said (the user tapped). */
  finish(): void;
  cancel(): void;
}

/**
 * A microphone kept open for a whole voice conversation (so there is no start-up delay between turns, and the app can also
 * notice when you talk over a reply). `level()` is the live loudness (0..1); `listen()` records one spoken turn.
 */
export interface MicSession {
  level(): number;
  listen(onLevel: (level: number) => void, o?: { endSilenceMs?: number; waitMs?: number; maxMs?: number }): Listener;
  close(): void;
}

export async function openMicSession(): Promise<MicSession> {
  const stream = await openMic();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  void ctx.resume();
  const buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  const level = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / buf.length);
  };

  const listen: MicSession['listen'] = (onLevel, o = {}) => {
    // about a second of quiet after you finish is the signal to answer; a little less feels more alive
    const endSilence = o.endSilenceMs ?? 900;
    const waitMs = o.waitMs ?? 12_000;
    const maxMs = o.maxMs ?? 45_000;
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    let resolve!: (b: Blob | null) => void;
    const done = new Promise<Blob | null>((r) => (resolve = r));
    let finished = false;
    let spoke = false;
    let lastVoice = 0;
    const started = Date.now();
    let noise = 0.012; // adapts to the room's background noise
    let calibrate = 6;

    const end = (keep: boolean) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      onLevel(0);
      if (!keep) {
        rec.onstop = null;
        if (rec.state !== 'inactive') rec.stop();
        return resolve(null);
      }
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
      setTimeout(() => rec.state !== 'inactive' && rec.stop(), 200);
    };

    const timer = setInterval(() => {
      const rms = level();
      onLevel(Math.min(1, rms * 5));
      const now = Date.now();
      if (calibrate > 0) {
        noise = Math.max(noise, Math.min(rms * 1.2, 0.05));
        calibrate--;
        return;
      }
      if (rms > Math.max(noise * 2.6, 0.03)) {
        spoke = true;
        lastVoice = now;
      } else if (!spoke) noise = noise * 0.97 + rms * 0.03;
      if (spoke && now - lastVoice > endSilence) end(true);
      else if (!spoke && now - started > waitMs) end(false);
      else if (now - started > maxMs) end(spoke);
    }, 50);

    rec.start(250);
    return { done, finish: () => end(spoke || Date.now() - started > 600), cancel: () => end(false) };
  };

  return {
    level,
    listen,
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}

/** Plain, speakable text from a Markdown reply (email draft cards and pictures are not read aloud). */
export function speakableText(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(splitDrafts(markdown).text), 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- preferences
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

export const DEFAULT_VOICE = 'edge:en-IN-NeerjaNeural';
/** Replies are spoken by default; the owner can switch it off in Settings. */
export const readSpeakPref = () => read(SPEAK_KEY) !== '0';
export const writeSpeakPref = (on: boolean) => write(SPEAK_KEY, on ? '1' : '0');
/** "edge:<voice>" or "groq:<voice>" (natural voices from the server), or the name of a voice on this phone. */
export const readVoiceName = () => {
  const v = read(VOICE_KEY);
  return v === null || v === 'groq:hannah' ? DEFAULT_VOICE : v; // "groq:hannah" was the old default and needs a one-time approval
};
export const writeVoiceName = (name: string) => write(VOICE_KEY, name);
export type SttLang = 'auto' | 'en' | 'ta';
export const readSttLang = (): SttLang => (['en', 'ta'].includes(read(LANG_KEY) ?? '') ? (read(LANG_KEY) as SttLang) : 'auto');
export const writeSttLang = (l: SttLang) => write(LANG_KEY, l);

export const NEURAL_VOICES = [
  { id: 'edge:en-IN-NeerjaNeural', label: 'Neerja (Indian English, sweet female)' },
  { id: 'edge:en-IN-PrabhatNeural', label: 'Prabhat (Indian English, warm male)' },
  { id: 'edge:en-US-AriaNeural', label: 'Aria (US, expressive female)' },
  { id: 'edge:en-US-JennyNeural', label: 'Jenny (US, friendly female)' },
  { id: 'edge:en-GB-SoniaNeural', label: 'Sonia (UK, gentle female)' },
  { id: 'edge:en-US-GuyNeural', label: 'Guy (US, friendly male)' },
  { id: 'edge:ta-IN-PallaviNeural', label: 'Pallavi (Tamil, female)' },
  { id: 'edge:ta-IN-ValluvarNeural', label: 'Valluvar (Tamil, male)' },
];
export const GROQ_VOICES = [
  { id: 'groq:hannah', label: 'Hannah (Groq, female)' },
  { id: 'groq:diana', label: 'Diana (Groq, female)' },
  { id: 'groq:autumn', label: 'Autumn (Groq, female)' },
  { id: 'groq:austin', label: 'Austin (Groq, male)' },
  { id: 'groq:daniel', label: 'Daniel (Groq, male)' },
  { id: 'groq:troy', label: 'Troy (Groq, male)' },
];

/** Voices installed on this phone. They load late on some browsers, so callers should also listen for `voiceschanged`. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!('speechSynthesis' in window)) return [];
  const all = window.speechSynthesis.getVoices();
  const english = all.filter((v) => /^en(-|_|$)/i.test(v.lang) || /^ta(-|_|$)/i.test(v.lang));
  return (english.length ? english : all).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Why the chosen voice was not used the last time ("" when it worked); shown next to the Test voice button. */
let note = '';
export const speechNote = () => note;

// ---------------------------------------------------------------- playback
let audio: HTMLAudioElement | null = null;
let run = 0; // bumped on every speak/stop so an old reply can never talk over a new one
let pending: (() => void) | null = null; // ends the reply that is being spoken, however it ends
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
  const p = pending;
  pending = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  p?.();
}

/** How much of the clip that is playing has been heard (0..1), so the captions can follow the voice word by word. */
export function playbackFraction(): number {
  return audio && audio.duration > 0 && audio.currentTime > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0;
}

// loudness of the voice for the animation (real for server voices, a gentle pulse for the phone's own voice)
let analyser: AnalyserNode | null = null;
let analyserBuf: Uint8Array<ArrayBuffer> | null = null;
export function outputLevel(): number {
  try {
    if (!analyser && audio && !audio.paused) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      analyserBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      void ctx.resume();
    }
    if (analyser && analyserBuf && audio && !audio.paused) {
      analyser.getByteTimeDomainData(analyserBuf);
      let sum = 0;
      for (const v of analyserBuf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / analyserBuf.length) * 5);
    }
  } catch {
    /* fall through to the pulse */
  }
  return 0.25 + 0.2 * Math.abs(Math.sin(Date.now() / 140));
}

/** Splits text into sentence-sized pieces so the first words are heard quickly and long replies are never cut off. */
function chunks(text: string, max: number): string[] {
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

/** Like chunks(), but the first piece is one short sentence so the first words are heard as soon as possible. */
function chunksLive(text: string, max: number): string[] {
  const first = /^[^.!?\n]{15,140}[.!?]+\s*/.exec(text);
  return first ? [first[0].trim(), ...chunks(text.slice(first[0].length), max)] : chunks(text, max);
}

function pickDeviceVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const chosen = readVoiceName();
  const byName = chosen && !chosen.includes(':') ? voices.find((v) => v.name === chosen) : undefined;
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

/** Plays one clip through the shared audio element; resolves when it finishes (or throws if playback is blocked). */
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

/** A human-sounding server voice, one chunk at a time, fetching the next while the current one plays. Falls back to the phone's voice on any problem. */
async function speakServer(pieces: string[], voice: string, s: Settings, myRun: number, lang: string, onEnd: () => void, onProgress?: (before: string, chunk: string) => void): Promise<void> {
  let next: Promise<Blob> | undefined = fetchSpeech(s, pieces[0]!, voice);
  next.catch(() => undefined);
  for (let i = 0; i < pieces.length; i++) {
    try {
      const blob = await next!;
      next = i + 1 < pieces.length ? fetchSpeech(s, pieces[i + 1]!, voice) : undefined;
      next?.catch(() => undefined);
      if (run !== myRun) return;
      onProgress?.(pieces.slice(0, i).join(' '), pieces[i]!);
      await play(blob, myRun);
      if (run !== myRun) return;
    } catch (e) {
      if (run !== myRun) return;
      note =
        (e as Error).message === 'tts_terms_required'
          ? 'That voice needs a one-time approval in your Groq account. Using the sweet Indian English voice instead.'
          : 'The natural voice is not reachable right now. Using your phone voice.';
      if ((e as Error).message === 'tts_terms_required' && voice.startsWith('groq:')) return void speakServerFallback(pieces.slice(i), s, myRun, lang, onEnd);
      return speakOnDevice(pieces.slice(i), lang, onEnd);
    }
  }
  note = '';
  if (run === myRun) onEnd();
}

function speakServerFallback(pieces: string[], s: Settings, myRun: number, lang: string, onEnd: () => void): void {
  void speakServer(pieces, lang === 'ta-IN' ? 'edge:ta-IN-PallaviNeural' : DEFAULT_VOICE, s, myRun, lang, onEnd);
}

export function speak(markdown: string, onEnd?: () => void, settings?: Settings, onProgress?: (before: string, chunk: string) => void): void {
  if (!canSpeak()) return onEnd?.();
  stopSpeaking();
  const myRun = run;
  const text = speakableText(markdown).slice(0, 4000);
  if (!text) return onEnd?.();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (pending === finish) pending = null;
    onEnd?.();
  };
  pending = finish;
  const tamil = /[஀-௿]/.test(text);
  const lang = tamil ? 'ta-IN' : 'en-IN';
  let voice = readVoiceName();
  if (tamil && !voice.startsWith('edge:ta')) voice = 'edge:ta-IN-PallaviNeural'; // Tamil replies get a Tamil voice
  const server = voice.startsWith('edge:') || voice.startsWith('groq:');
  if (server && settings?.token) void speakServer(voice.startsWith('groq:') ? chunks(text, 170) : chunksLive(text, 420), voice, settings, myRun, lang, finish, onProgress);
  else {
    onProgress?.(text, ''); // the phone's own voice gives no timing: show everything as spoken
    speakOnDevice(chunks(text, 170), lang, finish);
  }
}

/** Speaks a reply and resolves when it has finished (or was interrupted). Used by voice mode. */
export const speakAsync = (markdown: string, settings: Settings, onProgress?: (before: string, chunk: string) => void): Promise<void> => new Promise((resolve) => speak(markdown, resolve, settings, onProgress));

/** Replies the app itself produces when something went wrong should be shown, not read aloud. */
export const isFailureReply = (t: string) => /^(Apologies, Sir\.|Sir, my AI service is busy)/.test(t);
