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

/** iOS only lets speech start from a tap: call this inside the tap handler so later replies can be spoken. */
export function unlockSpeech(): void {
  if (!canSpeak()) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

export function speak(markdown: string, onEnd?: () => void): void {
  if (!canSpeak()) return onEnd?.();
  stopSpeaking();
  const text = speakableText(markdown).slice(0, 3000);
  if (!text) return onEnd?.();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[஀-௿]/.test(text) ? 'ta-IN' : 'en-IN';
  u.rate = 1.02;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}
