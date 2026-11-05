import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, AudioLines, Bell, Check, Copy, Download, FileText, Menu, MessageSquare, Mic, Paperclip, Pencil, RotateCcw, Settings as Cog, SquarePen, Square, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import {
  createSession,
  deleteSession,
  getPushStatus,
  listSessions,
  loadHistory,
  loadSettings,
  renameSession,
  saveSettings,
  sendChat,
  transcribeAudio,
  type Msg,
  type Session,
  type Settings,
} from './api';
import { renderMarkdown, setImageBase, splitDrafts } from './markdown';
import { DraftCard } from './cards';
import { VoiceMode } from './VoiceMode';
import { ImageCreating, wantsImage, type Aspect } from './creating';
import { MAX_FILES, prepareFile, type Pending } from './attach';
import { NotificationsPanel, SettingsPanel } from './panels';
import { refreshSubscription, registerServiceWorker, writeSwConfig } from './push';
import { canRecord, canSpeak, isFailureReply, readSpeakPref, readSttLang, speak, startRecording, stopSpeaking, unlockSpeech, writeSpeakPref, type Recording } from './voice';

const SUGGESTIONS = ["What's the latest news?", 'Remind me in 10 minutes to stretch', 'Draw a futuristic city at sunset', 'Email me a summary of today'];
const MAX_SECONDS = 120;
const MAIN: Session = { id: 'main', title: 'Telegram chat', updatedAt: '' };
let counter = 0;
const uid = () => `m${Date.now()}-${counter++}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

type Status = 'idle' | 'online' | 'offline';
type Panel = null | 'notifications' | 'settings';

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [panel, setPanel] = useState<Panel>(() => (loadSettings().token ? null : 'settings'));
  const [drawer, setDrawer] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>(() => store.get('mj.active') || 'main');
  const [chats, setChats] = useState<Record<string, Msg[]>>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [unread, setUnread] = useState(0);
  const [speakAll, setSpeakAll] = useState(readSpeakPref);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [creating, setCreating] = useState<Aspect | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<Recording | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  setImageBase(settings.url); // generated pictures are loaded from the backend
  const messages = chats[activeId] ?? [];
  const active = activeId === 'main' ? MAIN : (sessions.find((s) => s.id === activeId) ?? { id: activeId, title: 'New chat', updatedAt: '' });
  const put = useCallback((id: string, fn: (m: Msg[]) => Msg[]) => setChats((c) => ({ ...c, [id]: fn(c[id] ?? []) })), []);
  const fail = useCallback((id: string, msg: string) => put(id, (m) => [...m, { id: uid(), role: 'error', text: msg, at: Date.now() }]), [put]);

  // ---- loading ----
  const loadChat = useCallback(
    async (id: string, s: Settings) => {
      if (!s.token || loadedRef.current.has(id)) return;
      loadedRef.current.add(id);
      try {
        const rows = await loadHistory(s, id);
        setStatus('online');
        setChats((c) => ({ ...c, [id]: rows.map((r, i) => ({ id: `h${id}-${i}`, role: r.role, text: r.text, at: Date.now() - (rows.length - i) * 1000 })) }));
      } catch (e) {
        loadedRef.current.delete(id);
        setStatus('offline');
        if (id === 'main' || (e as Error).message.includes('token')) fail(id, (e as Error).message);
        else {
          // a chat that no longer exists on the server: fall back to the main chat
          setActiveId('main');
          store.set('mj.active', 'main');
        }
      }
    },
    [fail],
  );

  useEffect(() => {
    if (!settings.token) return;
    void registerServiceWorker();
    void writeSwConfig(settings);
    void listSessions(settings).then(setSessions);
    void getPushStatus(settings).then((s) => setUnread(s.unread)).catch(() => undefined);
    void refreshSubscription(settings);
  }, [settings]);

  useEffect(() => {
    void loadChat(activeId, settings);
  }, [activeId, settings, loadChat]);

  // unread badge: refresh now and then, and when the app comes back to the front
  useEffect(() => {
    if (!settings.token) return;
    const tick = () => void getPushStatus(settings).then((s) => setUnread(s.unread)).catch(() => undefined);
    const t = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'notification-click') {
        setPanel('notifications');
        tick();
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
      navigator.serviceWorker?.removeEventListener('message', onMsg);
    };
  }, [settings]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, activeId]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  // ---- chats ----
  const select = (id: string) => {
    stopSpeaking();
    setSpeakingId(null);
    setActiveId(id);
    store.set('mj.active', id);
    setDrawer(false);
  };

  const newChat = async () => {
    // reuse an empty chat instead of piling up blank ones
    const blank = sessions.find((s) => (chats[s.id] ?? []).length === 0 && loadedRef.current.has(s.id));
    if (blank) return select(blank.id);
    try {
      const s = await createSession(settings);
      loadedRef.current.add(s.id);
      setChats((c) => ({ ...c, [s.id]: [] }));
      setSessions((x) => [s, ...x]);
      select(s.id);
    } catch (e) {
      fail(activeId, (e as Error).message);
      setDrawer(false);
    }
  };

  const removeChat = async (s: Session) => {
    if (!window.confirm(`Delete "${s.title}"? Reminders you set in it will keep working.`)) return;
    try {
      await deleteSession(settings, s.id);
      setSessions((x) => x.filter((y) => y.id !== s.id));
      if (activeId === s.id) select('main');
    } catch (e) {
      fail(activeId, (e as Error).message);
    }
  };

  const renameChat = async (s: Session) => {
    const title = window.prompt('Rename chat', s.title)?.trim();
    if (!title) return;
    setSessions((x) => x.map((y) => (y.id === s.id ? { ...y, title } : y)));
    try {
      await renameSession(settings, s.id, title);
    } catch (e) {
      fail(activeId, (e as Error).message);
    }
  };

  // ---- sending ----
  const send = useCallback(
    async (raw: string, opts: { quiet?: boolean; voice?: boolean } = {}): Promise<string | undefined> => {
      const q = raw.trim();
      if ((!q && !files.length) || busy) return undefined;
      if (!settings.token) {
        setPanel('settings');
        return undefined;
      }
      const sid = activeId;
      const sending = files;
      unlockSpeech(); // runs inside the tap so spoken replies are allowed later
      stopSpeaking();
      setSpeakingId(null);
      setText('');
      setBusy(true);
      setFiles([]);
      setCreating(wantsImage(q));
      put(sid, (m) => [
        ...m.filter((x) => x.role !== 'error'),
        { id: uid(), role: 'user', text: q, at: Date.now(), files: sending.length ? sending.map((f) => ({ name: f.name, mime: f.mime, preview: f.preview })) : undefined },
      ]);
      try {
        const reply = await sendChat(settings, q, sid, sending.map(({ name, mime, data }) => ({ name, mime, data })), { voice: opts.voice });
        setStatus('online');
        const id = uid();
        put(sid, (m) => [...m, { id, role: 'assistant', text: reply, at: Date.now() }]);
        if (canSpeak() && speakAll && !opts.quiet && !isFailureReply(reply)) {
          setSpeakingId(id);
          speak(reply, () => setSpeakingId((cur) => (cur === id ? null : cur)), settings);
        }
        if (sid !== 'main') void listSessions(settings).then(setSessions);
        return reply;
      } catch (e) {
        setStatus('offline');
        fail(sid, (e as Error).message);
        return undefined;
      } finally {
        setBusy(false);
        setCreating(null);
      }
    },
    [activeId, busy, fail, files, put, settings, speakAll],
  );

  // ---- voice input ----
  const beginRecording = async () => {
    if (!settings.token) return setPanel('settings');
    stopSpeaking();
    setSpeakingId(null);
    unlockSpeech();
    try {
      recRef.current = await startRecording();
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      fail(activeId, (e as Error).message);
    }
  };
  const cancelRecording = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
  };
  const finishRecording = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    setTranscribing(true);
    try {
      const audio = await rec.stop();
      if (audio.size < 800) throw new Error('That was too short. Tap the mic and speak a little longer.');
      const said = await transcribeAudio(settings, audio, readSttLang());
      if (!said) throw new Error('I could not hear anything. Please try again.');
      await send(said);
    } catch (e) {
      fail(activeId, (e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }, [activeId, fail, send, settings]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) void finishRecording();
  }, [recording, seconds, finishRecording]);
  useEffect(
    () => () => {
      recRef.current?.cancel();
      stopSpeaking();
    },
    [],
  );

  // ---- voice output / actions ----
  const toggleSpeakAll = (on = !speakAll) => {
    setSpeakAll(on);
    writeSpeakPref(on);
    if (on) unlockSpeech();
    else {
      stopSpeaking();
      setSpeakingId(null);
    }
  };
  const toggleSpeakMessage = (m: Msg) => {
    if (speakingId === m.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(m.id);
    speak(m.text, () => setSpeakingId((cur) => (cur === m.id ? null : cur)), settings);
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const room = MAX_FILES - files.length;
    if (list.length > room) fail(activeId, `You can attach up to ${MAX_FILES} files at a time.`);
    for (const f of Array.from(list).slice(0, Math.max(room, 0))) {
      try {
        const p = await prepareFile(f);
        setFiles((x) => (x.length < MAX_FILES ? [...x, p] : x));
      } catch (e) {
        fail(activeId, (e as Error).message);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  // Pictures fade in from a soft blur once they have loaded (like ChatGPT); a picture that fails to load can be tapped to retry.
  const streamRef = useRef<HTMLElement>(null);
  const retryImage = (img: HTMLImageElement) => {
    img.classList.remove('broken', 'loaded');
    const base = img.src.replace(/[?&]r=\d+$/, '');
    img.src = `${base}${base.includes('?') ? '&' : '?'}r=${Date.now()}`;
  };
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const mark = (img: HTMLImageElement) => {
      if (img.complete && img.naturalWidth > 0) img.classList.add('loaded');
      else if (img.complete) img.classList.add('broken');
    };
    el.querySelectorAll<HTMLImageElement>('img.gen-img').forEach(mark);
    const onLoad = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'IMG' && t.classList.contains('gen-img')) (t as HTMLImageElement).classList.add('loaded');
    };
    const onError = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'IMG' && t.classList.contains('gen-img')) (t as HTMLImageElement).classList.add('broken');
    };
    el.addEventListener('load', onLoad, true);
    el.addEventListener('error', onError, true);
    return () => {
      el.removeEventListener('load', onLoad, true);
      el.removeEventListener('error', onError, true);
    };
  }, [messages, activeId]);

  // Saves the picture reliably (a plain download link fails for pictures from another address, or when it was not ready).
  const savePicture = async (src: string) => {
    try {
      const blob = await (await fetch(src)).blob();
      if (!blob.size || !blob.type.startsWith('image/')) throw new Error('not an image');
      const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
      const file = new File([blob], `mj-image.${ext}`, { type: blob.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      window.open(src, '_blank', 'noopener'); // last resort: open it so it can be saved by long-pressing
    }
  };

  const copy = async (m: Msg) => {
    try {
      await navigator.clipboard.writeText(splitDrafts(m.text).text);
      setCopied(m.id);
      setTimeout(() => setCopied((c) => (c === m.id ? '' : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const lastUser = useMemo(() => [...messages].reverse().find((m) => m.role === 'user')?.text, [messages]);
  const empty = messages.length === 0 && !busy;

  return (
    <div className="app">
      <header className="top">
        <button className="icon-btn" aria-label="Open chats" onClick={() => setDrawer(true)}>
          <Menu size={22} />
        </button>
        <div className="title">
          <h1>{active.title}</h1>
          <span className={`pill ${status}`}>
            <i />
            {status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Connecting'}
          </span>
        </div>
        {canRecord() && (
          <button className="icon-btn" aria-label="Voice mode" onClick={() => (unlockSpeech(), setVoiceOpen(true))}>
            <AudioLines size={21} />
          </button>
        )}
        {canSpeak() && (
          <button className={`icon-btn ${speakAll ? 'on' : ''}`} aria-label={speakAll ? 'Turn off spoken replies' : 'Speak every reply'} aria-pressed={speakAll} onClick={() => toggleSpeakAll()}>
            {speakAll ? <Volume2 size={21} /> : <VolumeX size={21} />}
          </button>
        )}
        <button className="icon-btn bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => setPanel('notifications')}>
          <Bell size={21} />
          {unread > 0 && <b className="badge">{unread > 9 ? '9+' : unread}</b>}
        </button>
        <button className="icon-btn" aria-label="New chat" onClick={() => void newChat()}>
          <SquarePen size={21} />
        </button>
      </header>

      <main
        ref={streamRef}
        className="stream"
        aria-live="polite"
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.tagName === 'IMG' && t.classList.contains('gen-img')) {
            const img = t as HTMLImageElement;
            if (img.classList.contains('broken')) retryImage(img);
            else setLightbox(img.src);
          }
        }}
      >
        {empty && (
          <section className="hello">
            <img src="/logo.png" alt="" width={64} height={64} />
            <h2>How can I help, Sir?</h2>
            <p>Ask anything, set reminders, get the news or have me email you. I will speak every reply.</p>
            <div className="chips">
              {SUGGESTIONS.map((c) => (
                <button key={c} className="chip" onClick={() => void send(c)}>
                  {c}
                </button>
              ))}
            </div>
          </section>
        )}

        {messages.map((m) =>
          m.role === 'assistant' ? (
            <div key={m.id} className="row ai">
              <img className="avatar" src="/logo.png" alt="" width={28} height={28} />
              <div className="ai-body">
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(splitDrafts(m.text).text) }} />
                {splitDrafts(m.text).drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} settings={settings} />
                ))}
                <div className="meta">
                  <time>{clock(m.at)}</time>
                  <button className="act" aria-label="Copy" onClick={() => void copy(m)}>
                    {copied === m.id ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                  {canSpeak() && (
                    <button className={`act ${speakingId === m.id ? 'on' : ''}`} aria-label={speakingId === m.id ? 'Stop speaking' : 'Read aloud'} onClick={() => toggleSpeakMessage(m)}>
                      {speakingId === m.id ? <Square size={13} /> : <Volume2 size={15} />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : m.role === 'user' ? (
            <div key={m.id} className="row me">
              <div className="bubble">
                {m.files && (
                  <div className="sent-files">
                    {m.files.map((f, i) =>
                      f.preview ? (
                        <img key={i} src={f.preview} alt={f.name} />
                      ) : (
                        <span key={i} className="sent-doc">
                          <FileText size={15} /> {f.name}
                        </span>
                      ),
                    )}
                  </div>
                )}
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="row ai">
              <div className="bubble err" role="alert">
                {m.text}
                {lastUser && (
                  <div>
                    <button className="retry" onClick={() => void send(lastUser)}>
                      <RotateCcw size={14} /> Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
          ),
        )}

        {transcribing && !busy && (
          <div className="row me">
            <div className="bubble soft">Transcribing...</div>
          </div>
        )}
        {busy && (
          <div className="row ai">
            <img className="avatar" src="/logo.png" alt="" width={28} height={28} />
            {creating ? (
              <ImageCreating aspect={creating} />
            ) : (
              <div className="typing" aria-label="MJ is typing">
                <i />
                <i />
                <i />
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </main>

      {speakingId && (
        <button
          className="speaking"
          onClick={() => {
            stopSpeaking();
            setSpeakingId(null);
          }}
        >
          <Volume2 size={16} /> Speaking... tap to stop
        </button>
      )}

      {files.length > 0 && (
        <div className="pending">
          {files.map((f) => (
            <div key={f.id} className="pending-chip">
              {f.preview ? <img src={f.preview} alt={f.name} /> : <FileText size={20} />}
              {!f.preview && <span>{f.name}</span>}
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
          inputRef.current?.focus();
        }}
      >
        {recording ? (
          <div className="pill-input rec-bar">
            <button type="button" className="icon-btn" aria-label="Cancel recording" onClick={cancelRecording}>
              <X size={22} />
            </button>
            <span className="rec" role="status">
              <span className="rec-dot" /> Listening... <b>{mmss(seconds)}</b>
            </span>
            <button type="button" className="send" aria-label="Send voice message" onClick={() => void finishRecording()}>
              <ArrowUp size={20} />
            </button>
          </div>
        ) : (
          <div className="pill-input">
            <input ref={fileRef} type="file" hidden multiple accept="image/*,application/pdf,text/plain,.pdf,.txt" onChange={(e) => void addFiles(e.target.files)} />
            <button type="button" className="attach" aria-label="Attach photos or files" disabled={busy || transcribing || files.length >= MAX_FILES} onClick={() => fileRef.current?.click()}>
              <Paperclip size={20} />
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={transcribing ? 'Transcribing...' : 'Message MJ'}
              enterKeyHint="send"
              autoComplete="off"
              aria-label="Message"
              disabled={transcribing}
            />
            {text.trim() || files.length > 0 || !canRecord() ? (
              <button className="send" type="submit" disabled={(!text.trim() && !files.length) || busy} aria-label="Send">
                <ArrowUp size={20} />
              </button>
            ) : (
              <button type="button" className="send mic" disabled={busy || transcribing} aria-label="Record a voice message" onClick={() => void beginRecording()}>
                <Mic size={20} />
              </button>
            )}
          </div>
        )}
      </form>

      {voiceOpen && <VoiceMode settings={settings} ask={(t) => send(t, { quiet: true, voice: true })} onClose={() => setVoiceOpen(false)} />}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
            <button className="lb-btn" aria-label="Download" onClick={() => void savePicture(lightbox)}>
              <Download size={20} />
            </button>
            <button className="lb-btn" aria-label="Close" onClick={() => setLightbox(null)}>
              <X size={22} />
            </button>
          </div>
          <img src={lightbox} alt="Generated" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {drawer && (
        <div className="drawer-scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" aria-label="Chats" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <img src="/logo.png" alt="" width={34} height={34} />
              <strong>MJ</strong>
              <button className="icon-btn" aria-label="Close" onClick={() => setDrawer(false)}>
                <X size={20} />
              </button>
            </div>
            <button className="new-chat" onClick={() => void newChat()}>
              <SquarePen size={18} /> New chat
            </button>
            <div className="drawer-list">
              <h5>Shared with Telegram</h5>
              <button className={`chat-item ${activeId === 'main' ? 'active' : ''}`} onClick={() => select('main')}>
                <MessageSquare size={16} /> Telegram chat
              </button>
              <h5>Chats</h5>
              {sessions.length === 0 && <p className="note small">No chats yet. Tap New chat to start one.</p>}
              {sessions.map((s) => (
                <div key={s.id} className={`chat-item ${activeId === s.id ? 'active' : ''}`}>
                  <button className="chat-name" onClick={() => select(s.id)}>
                    <MessageSquare size={16} /> <span>{s.title}</span>
                  </button>
                  <button className="mini" aria-label={`Rename ${s.title}`} onClick={() => void renameChat(s)}>
                    <Pencil size={14} />
                  </button>
                  <button className="mini" aria-label={`Delete ${s.title}`} onClick={() => void removeChat(s)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="drawer-foot">
              <button
                onClick={() => {
                  setDrawer(false);
                  setPanel('notifications');
                }}
              >
                <Bell size={18} /> Notifications {unread > 0 && <b className="badge inline">{unread}</b>}
              </button>
              <button
                onClick={() => {
                  setDrawer(false);
                  setPanel('settings');
                }}
              >
                <Cog size={18} /> Settings
              </button>
            </div>
          </nav>
        </div>
      )}

      {panel === 'notifications' && (
        <NotificationsPanel settings={settings} onClose={() => setPanel(null)} onUnread={setUnread} onOpenSettings={() => setPanel('settings')} />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          required={!settings.token}
          speakAll={speakAll}
          onSpeakAll={toggleSpeakAll}
          onClose={() => setPanel(null)}
          onSave={(s) => {
            saveSettings(s);
            loadedRef.current = new Set();
            setChats({});
            setSettings(s);
            setStatus('idle');
            setPanel(null);
          }}
        />
      )}
    </div>
  );
}
