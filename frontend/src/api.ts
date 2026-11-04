// The app only talks to the MJ backend (or any server with the same two endpoints). Never call AI providers from the browser.
export interface Settings {
  url: string;
  token: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
}

const KEY = 'mj.settings';
const env = import.meta.env as Record<string, string | undefined>;

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* storage unavailable: fall back to build defaults */
  }
  // The URL is never taken from the build: empty means this site's own /api (forwarded to the backend by vercel.json), which avoids CORS blocks.
  return { url: (saved.url ?? '').replace(/\/+$/, ''), token: saved.token ?? env.VITE_API_TOKEN ?? '' };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ url: s.url.trim().replace(/\/+$/, ''), token: s.token.trim() }));
  } catch {
    /* ignore */
  }
}

async function call(s: Settings, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and the backend URL.');
  }
  if (res.status === 401) throw new Error('The access token was not accepted. Check it in Settings.');
  if (res.status === 429) throw new Error('Too many requests. Please wait a moment.');
  if (!res.ok) throw new Error(`The server had a problem (${res.status}). Please try again.`);
  return res.json();
}

export async function sendChat(s: Settings, text: string): Promise<string> {
  const j = (await call(s, '/api/chat', { method: 'POST', body: JSON.stringify({ query: text }) })) as { reply?: string; answer?: string };
  const reply = j.reply ?? j.answer;
  if (typeof reply !== 'string') throw new Error('The server sent an unexpected reply.');
  return reply;
}

export async function loadHistory(s: Settings): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const j = (await call(s, '/api/history?limit=40')) as { messages?: Array<{ role: 'user' | 'assistant'; text: string }> };
  return j.messages ?? [];
}

/** Sends a recording to the backend and returns what was said. */
export async function transcribeAudio(s: Settings, audio: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${s.url}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm', Authorization: `Bearer ${s.token}` },
      body: audio,
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and the backend URL.');
  }
  if (res.status === 401) throw new Error('The access token was not accepted. Check it in Settings.');
  if (res.status === 404) throw new Error('This server does not support voice messages.');
  if (!res.ok) throw new Error('I could not understand that recording. Please try again.');
  return String(((await res.json()) as { text?: string }).text ?? '').trim();
}
