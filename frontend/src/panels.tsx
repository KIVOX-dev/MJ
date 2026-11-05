import { useCallback, useEffect, useState } from 'react';
import { AlarmClock, BellRing, CheckCheck, Newspaper, Siren, Sparkles, Volume2, X } from 'lucide-react';
import {
  getPrefs,
  listNotifications,
  markRead,
  setPrefs,
  stopReminder,
  testPush,
  type Category,
  type NotificationItem,
  type Prefs,
  type Settings,
} from './api';
import { disablePush, enablePush, isIos, pushState, type PushState } from './push';
import { NATURAL_VOICES, canSpeak, listVoices, readSttLang, readVoiceName, speak, speechNote, writeSttLang, writeVoiceName, type SttLang } from './voice';

const ICONS: Record<Category, typeof BellRing> = { reminder: AlarmClock, alert: Siren, news: Newspaper, system: Sparkles };
const LABELS: Record<Category, string> = { reminder: 'Reminders', alert: 'Breaking news alerts', news: 'Morning news briefing', system: 'MJ messages' };

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

function Sheet(p: { title: string; onClose: () => void; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="scrim" onClick={p.onClose}>
      <section className="sheet" role="dialog" aria-label={p.title} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <header className="sheet-head">
          <h3>{p.title}</h3>
          <div className="sheet-actions">
            {p.action}
            <button className="icon-btn" aria-label="Close" onClick={p.onClose}>
              <X size={20} />
            </button>
          </div>
        </header>
        <div className="sheet-body">{p.children}</div>
      </section>
    </div>
  );
}

export function NotificationsPanel(p: { settings: Settings; onClose: () => void; onUnread: (n: number) => void; onOpenSettings: () => void }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [stopped, setStopped] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const r = await listNotifications(p.settings);
      setItems(r.notifications);
      p.onUnread(r.unread);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.settings]);

  useEffect(() => {
    void load();
  }, [load]);

  const readAll = async () => {
    try {
      await markRead(p.settings);
      setItems((x) => x.map((n) => ({ ...n, read: true })));
      p.onUnread(0);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const readOne = async (n: NotificationItem) => {
    if (n.read) return;
    setItems((x) => x.map((y) => (y.id === n.id ? { ...y, read: true } : y)));
    try {
      await markRead(p.settings, [n.id]);
      p.onUnread(Math.max(0, items.filter((y) => !y.read).length - 1));
    } catch {
      /* the next refresh corrects it */
    }
  };
  const stop = async (n: NotificationItem) => {
    if (!n.reminderId) return;
    try {
      const r = await stopReminder(p.settings, n.reminderId);
      setStopped((s) => ({ ...s, [n.id]: true }));
      if (!r.stopped) setError('That reminder was already stopped.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unread = items.filter((n) => !n.read).length;
  return (
    <Sheet
      title="Notifications"
      onClose={p.onClose}
      action={
        unread > 0 ? (
          <button className="text-btn" onClick={() => void readAll()}>
            <CheckCheck size={16} /> Mark all read
          </button>
        ) : undefined
      }
    >
      {error && <p className="note err">{error}</p>}
      {loading && <p className="note">Loading...</p>}
      {!loading && items.length === 0 && !error && (
        <div className="empty-note">
          <BellRing size={28} />
          <p>No notifications yet. Reminders, breaking news and your morning briefing will appear here.</p>
          <button className="soft-btn" onClick={p.onOpenSettings}>
            Notification settings
          </button>
        </div>
      )}
      <ul className="notes">
        {items.map((n) => {
          const Icon = ICONS[n.category] ?? Sparkles;
          return (
            <li key={n.id} className={`note-item ${n.read ? '' : 'unread'}`} onClick={() => void readOne(n)}>
              <span className={`note-icon ${n.category}`}>
                <Icon size={18} />
              </span>
              <div className="note-main">
                <div className="note-top">
                  <strong>{n.title}</strong>
                  <time>{ago(n.createdAt)}</time>
                </div>
                <p>{n.body}</p>
                {n.category === 'reminder' && n.reminderId && (
                  <button
                    className="soft-btn small"
                    disabled={stopped[n.id]}
                    onClick={(e) => {
                      e.stopPropagation();
                      void stop(n);
                    }}
                  >
                    {stopped[n.id] ? 'Stopped' : 'Stop this reminder'}
                  </button>
                )}
              </div>
              {!n.read && <i className="dot" aria-label="Unread" />}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function Switch(p: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={p.on} aria-label={p.label} className={`switch ${p.on ? 'on' : ''}`} onClick={() => p.onChange(!p.on)}>
      <i />
    </button>
  );
}

export function SettingsPanel(p: {
  settings: Settings;
  required: boolean;
  speakAll: boolean;
  onSpeakAll: (v: boolean) => void;
  onSave: (s: Settings) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(p.settings.url);
  const [token, setToken] = useState(p.settings.token);
  const [state, setState] = useState<PushState>('off');
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState(readVoiceName());
  const [lang, setLang] = useState<SttLang>(readSttLang());
  const [voiceNote, setVoiceNote] = useState('');

  const refresh = useCallback(async () => {
    setState(await pushState());
    if (p.settings.token) getPrefs(p.settings).then(setPrefsState).catch(() => undefined);
  }, [p.settings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canSpeak()) return;
    const load = () => setVoices(listVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg('');
    try {
      const out = await fn();
      if (out) setMsg(out);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const toggle = (c: Category, v: boolean) => {
    setPrefsState((x) => (x ? { ...x, [c]: v } : x));
    setPrefs(p.settings, { [c]: v }).then(setPrefsState).catch((e: Error) => setMsg(e.message));
  };

  return (
    <Sheet title={p.required ? 'Connect to MJ' : 'Settings'} onClose={p.required ? () => undefined : p.onClose}>
      {!p.required && (
        <>
          <h4 className="group">Phone notifications</h4>
          <div className="card">
            {state === 'unsupported' && <p className="note">This browser cannot show push notifications. Try Chrome or Edge on Android, or install MJ to your Home Screen on iPhone.</p>}
            {state === 'ios-install' && (
              <p className="note">
                On iPhone, notifications work only from the installed app. In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>, open MJ from the Home Screen and come back here.
              </p>
            )}
            {state === 'blocked' && <p className="note">Notifications are blocked for this site. Open your browser's site settings, allow Notifications for MJ, then return here.</p>}
            {state === 'off' && (
              <>
                <p className="note">Get reminders, breaking news and your morning briefing as real notifications, even when MJ is closed.</p>
                <button className="primary" disabled={busy} onClick={() => void run(async () => (await enablePush(p.settings), 'Notifications are on.'))}>
                  Enable notifications
                </button>
              </>
            )}
            {state === 'on' && (
              <>
                <p className="note ok">Notifications are on for this device.</p>
                <div className="btn-row">
                  <button className="soft-btn" disabled={busy} onClick={() => void run(async () => `Test sent to ${(await testPush(p.settings)).delivered} device(s).`)}>
                    Send a test
                  </button>
                  <button className="soft-btn danger" disabled={busy} onClick={() => void run(async () => (await disablePush(p.settings), 'Notifications are off for this device.'))}>
                    Turn off
                  </button>
                </div>
              </>
            )}
            {prefs && (state === 'on' || state === 'off') && (
              <ul className="prefs">
                {(Object.keys(LABELS) as Category[]).map((c) => (
                  <li key={c}>
                    <span>{LABELS[c]}</span>
                    <Switch on={prefs[c]} onChange={(v) => toggle(c, v)} label={LABELS[c]} />
                  </li>
                ))}
              </ul>
            )}
            {msg && <p className="note">{msg}</p>}
            {isIos() && state === 'on' && <p className="note small">Tip: keep MJ on your Home Screen so iOS keeps delivering notifications.</p>}
          </div>

          <h4 className="group">Voice</h4>
          <div className="card">
            {canSpeak() ? (
              <>
                <div className="row-between">
                  <span>Speak every reply aloud</span>
                  <Switch on={p.speakAll} onChange={p.onSpeakAll} label="Speak every reply aloud" />
                </div>
                {(voices.length > 0 || NATURAL_VOICES.length > 0) && (
                  <label className="field">
                    Voice
                    <select
                      value={voice}
                      onChange={(e) => {
                        setVoice(e.target.value);
                        writeVoiceName(e.target.value);
                      }}
                    >
                      <optgroup label="Natural voices (English)">
                        {NATURAL_VOICES.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Voices on this phone">
                        <option value="">Automatic (best on this phone)</option>
                        {voices.map((v) => (
                          <option key={`${v.name}-${v.lang}`} value={v.name}>
                            {v.name} ({v.lang})
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                )}
                <button
                  className="soft-btn"
                  onClick={() => {
                    setVoiceNote('');
                    speak('Good day, Sir. This is how I will sound when I read your replies.', undefined, p.settings);
                    setTimeout(() => setVoiceNote(speechNote()), 3500);
                  }}
                >
                  <Volume2 size={16} /> Test voice
                </button>
                {voiceNote && <p className="note small">{voiceNote}</p>}
              </>
            ) : (
              <p className="note">This browser cannot speak replies aloud.</p>
            )}
            <label className="field">
              Language I speak to MJ
              <select
                value={lang}
                onChange={(e) => {
                  setLang(e.target.value as SttLang);
                  writeSttLang(e.target.value as SttLang);
                }}
              >
                <option value="auto">Automatic</option>
                <option value="en">English (best for English with an Indian accent)</option>
                <option value="ta">தமிழ் (Tamil)</option>
              </select>
            </label>
          </div>
        </>
      )}

      <h4 className="group">Connection</h4>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) p.onSave({ url: url.trim().replace(/\/+$/, ''), token: token.trim() });
        }}
      >
        <label className="field">
          Backend URL (optional)
          <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Leave empty to use this site's connection" />
        </label>
        <label className="field">
          Access token
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="WEB_API_TOKEN from the backend" />
        </label>
        <p className="note small">Leave the URL empty unless you use a different server. Settings stay on this phone.</p>
        <button className="primary" type="submit" disabled={!token.trim()}>
          Save and connect
        </button>
      </form>
    </Sheet>
  );
}
