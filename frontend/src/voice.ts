import { renderMarkdown } from './markdown';

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export interface Recording {
  stop(): Promise<Blob>;
  cancel(): void;
}

/** Starts the microphone. Rejects with a friendly Error if it is blocked or unavailable (needs https or localhost). */
export async function startRecording(): Promise<Recording> {
  if (!canRecord()) throw new Error('Voice needs a secure (https) page and a browser that can record audio.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new Error('Microphone access was blocked. Allow it in your browser settings and try again.');
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop());
  rec.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          release();
          resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
        };
        if (rec.state === 'inactive') return done();
        rec.onstop = done;
        rec.stop();
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

// ---- spoken replies ----
const VOICE_KEY = 'mj.voiceName';
const SPEAK_KEY = 'mj.speak';

/** Replies are spoken by default; the owner can switch it off in Settings. */
export function readSpeakPref(): boolean {
  try {
    return localStorage.getItem(SPEAK_KEY) !== '0';
  } catch {
    return true;
  }
}
export function writeSpeakPref(on: boolean): void {
  try {
    localStorage.setItem(SPEAK_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
export function readVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? '';
  } catch {
    return '';
  }
}
export function writeVoiceName(name: string): void {
  try {
    localStorage.setItem(VOICE_KEY, name);
  } catch {
    /* ignore */
  }
}

/** Voices installed on this phone. They load late on some browsers, so callers should also listen for `voiceschanged`. */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!canSpeak()) return [];
  const all = window.speechSynthesis.getVoices();
  const english = all.filter((v) => /^en(-|_|$)/i.test(v.lang) || /^ta(-|_|$)/i.test(v.lang));
  return (english.length ? english : all).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** The chosen voice, or the most natural-sounding English (India first) voice available. */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const chosen = readVoiceName();
  const byName = chosen ? voices.find((v) => v.name === chosen) : undefined;
  if (byName && (lang === 'en-IN' || byName.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))) return byName;
  const sameLang = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang.slice(0, 2).toLowerCase()));
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase() ? 4 : 0) + (/natural|neural|online|google|enhanced|premium/i.test(v.name) ? 3 : 0) + (v.localService ? 0 : 1);
  return sameLang.sort((a, b) => score(b) - score(a))[0];
}

/** iOS and some Android browsers only start speech from a tap: call this inside the tap handler so later replies can be spoken. */
export function unlockSpeech(): void {
  if (!canSpeak()) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

/** Splits text into sentence-sized pieces; long utterances are cut off by Chrome after ~15 seconds. */
function chunks(text: string): string[] {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > 170) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function speak(markdown: string, onEnd?: () => void): void {
  if (!canSpeak()) return onEnd?.();
  stopSpeaking();
  const text = speakableText(markdown).slice(0, 4000);
  if (!text) return onEnd?.();
  const lang = /[஀-௿]/.test(text) ? 'ta-IN' : 'en-IN';
  const voice = pickVoice(lang);
  const pieces = chunks(text);
  pieces.forEach((piece, i) => {
    const u = new SpeechSynthesisUtterance(piece);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    u.rate = 1;
    u.pitch = 1;
    if (i === pieces.length - 1) {
      u.onend = () => onEnd?.();
      u.onerror = () => onEnd?.();
    }
    window.speechSynthesis.speak(u);
  });
}
