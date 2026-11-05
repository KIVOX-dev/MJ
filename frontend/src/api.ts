// The app only talks to the MJ backend (or any server with the same endpoints). Never call AI providers from the browser.
export interface Settings {
  url: string;
  token: string;
}
export interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
}
export interface Session {
  id: string;
  title: string;
  updatedAt: string;
}
export type Category = 'reminder' | 'alert' | 'news' | 'system';
export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  url: string;
  category: Category;
  reminderId?: string;
  read: boolean;
  createdAt: string;
}
export interface PushStatus {
  enabled: boolean;
  publicKey?: string;
  subscriptions: number;
  unread: number;
}
export type Prefs = Record<Category, boolean>;

const KEY = 'mj.settings';
const env = import.meta.env as Record<string, string | undefined>;

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* storage unavailable: fall back to defaults */
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

async function call<T>(s: Settings, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}), Authorization: `Bearer ${s.token}` },
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and the backend URL.');
  }
  if (res.status === 401) throw new Error('The access token was not accepted. Check it in Settings.');
  if (res.status === 429) throw new Error('Too many requests. Please wait a moment.');
  if (res.status === 503) throw new Error('That feature is not switched on at the server yet.');
  if (!res.ok) throw new Error(`The server had a problem (${res.status}). Please try again.`);
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const sid = (id: string) => (id === 'main' ? '' : `&session_id=${encodeURIComponent(id)}`);

// ---- chat ----
export async function sendChat(s: Settings, text: string, sessionId: string): Promise<string> {
  const j = await call<{ reply?: string; answer?: string }>(s, '/api/chat', post({ query: text, ...(sessionId !== 'main' ? { session_id: sessionId } : {}) }));
  const reply = j.reply ?? j.answer;
  if (typeof reply !== 'string') throw new Error('The server sent an unexpected reply.');
  return reply;
}

export async function loadHistory(s: Settings, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const j = await call<{ messages?: Array<{ role: 'user' | 'assistant'; text: string }> }>(s, `/api/history?limit=60${sid(sessionId)}`);
  return j.messages ?? [];
}

// ---- chats (sessions) ----
export async function listSessions(s: Settings): Promise<Session[]> {
  try {
    return (await call<{ sessions?: Session[] }>(s, '/api/sessions')).sessions ?? [];
  } catch {
    return []; // a server without chat sessions still works with the single chat
  }
}
export const createSession = (s: Settings) => call<Session>(s, '/api/sessions', { method: 'POST' });
export const renameSession = (s: Settings, id: string, title: string) => call<{ ok: boolean }>(s, `/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const deleteSession = (s: Settings, id: string) => call<{ ok: boolean }>(s, `/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---- voice ----
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

// ---- push notifications ----
export const getPushStatus = (s: Settings) => call<PushStatus>(s, '/api/push/status');
export const subscribePush = (s: Settings, subscription: unknown) => call<{ ok: boolean }>(s, '/api/push/subscribe', post({ subscription }));
export const unsubscribePush = (s: Settings, endpoint: string) => call<{ ok: boolean }>(s, '/api/push/unsubscribe', post({ endpoint }));
export const testPush = (s: Settings) => call<{ delivered: number }>(s, '/api/push/test', { method: 'POST' });
export const getPrefs = (s: Settings) => call<Prefs>(s, '/api/push/prefs');
export const setPrefs = (s: Settings, p: Partial<Prefs>) => call<Prefs>(s, '/api/push/prefs', post(p));
export const listNotifications = (s: Settings) => call<{ notifications: NotificationItem[]; unread: number }>(s, '/api/notifications?limit=40');
export const markRead = (s: Settings, ids?: string[]) => call<{ updated: number }>(s, '/api/notifications/read', post(ids ? { ids } : {}));
export const stopReminder = (s: Settings, id: string) => call<{ stopped: boolean }>(s, `/api/reminders/${encodeURIComponent(id)}/stop`, { method: 'POST' });
