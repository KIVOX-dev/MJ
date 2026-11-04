import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Mic, RotateCcw, Settings as Cog, Sparkles, Square, Volume2, VolumeX, X } from 'lucide-react';
import { loadHistory, loadSettings, saveSettings, sendChat, transcribeAudio, type ChatMessage, type Settings } from './api';
import { canRecord, canSpeak, speak, startRecording, stopSpeaking, unlockSpeech, type Recording } from './voice';
import { renderMarkdown } from './markdown';

const CHIPS = ["What's the latest news?", 'Remind me in 10 minutes to stretch', 'What do you remember about me?', 'Summarise my day'];
let counter = 0;
const uid = () => `m${Date.now()}-${counter++}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

type Status = 'idle' | 'online' | 'offline';
const MAX_SECONDS = 120;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const readSpeakPref = () => {
  try {
    return localStorage.getItem('mj.speak') === '1';
  } catch {
    return false;
  }
};

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(() => !loadSettings().token);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [speakAll, setSpeakAll] = useState(readSpeakPref);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<Recording | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load the earlier conversation (shared with the Telegram bot) once a token exists.
  useEffect(() => {
    if (!settings.token) return;
    let live = true;
    loadHistory(settings)
      .then((rows) => {
        if (!live) return;
        setStatus('online');
        setMessages(rows.map((r, i) => ({ id: `h${i}`, role: r.role, text: r.text, at: Date.now() - (rows.length - i) * 1000 })));
      })
      .catch((e: Error) => {
        if (!live) return;
        setStatus('offline');
        setMessages([{ id: uid(), role: 'error', text: e.message, at: Date.now() }]);
      });
    return () => {
      live = false;
    };
  }, [settings]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const send = useCallback(
    async (raw: string, viaVoice = false) => {
      const q = raw.trim();
      if (!q || busy) return;
      if (!settings.token) return setShowSettings(true);
      setText('');
      setBusy(true);
      setMessages((m) => [...m.filter((x) => x.role !== 'error'), { id: uid(), role: 'user', text: q, at: Date.now() }]);
      try {
        const reply = await sendChat(settings, q);
        setStatus('online');
        const id = uid();
        setMessages((m) => [...m, { id, role: 'assistant', text: reply, at: Date.now() }]);
        if (canSpeak() && (viaVoice || speakAll)) {
          setSpeakingId(id);
          speak(reply, () => setSpeakingId((cur) => (cur === id ? null : cur)));
        }
      } catch (e) {
        setStatus('offline');
        setMessages((m) => [...m, { id: uid(), role: 'error', text: (e as Error).message, at: Date.now() }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, settings, speakAll],
  );

  const fail = useCallback((msg: string) => setMessages((m) => [...m, { id: uid(), role: 'error', text: msg, at: Date.now() }]), []);

  const beginRecording = async () => {
    if (!settings.token) return setShowSettings(true);
    stopSpeaking();
    setSpeakingId(null);
    unlockSpeech(); // runs inside the tap so spoken replies are allowed later (iOS)
    try {
      recRef.current = await startRecording();
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      fail((e as Error).message);
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
      const said = await transcribeAudio(settings, audio);
      if (!said) throw new Error('I could not hear anything. Please try again.');
      await send(said, true);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }, [settings, send, fail]);

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

  const toggleSpeakAll = () => {
    const next = !speakAll;
    setSpeakAll(next);
    try {
      localStorage.setItem('mj.speak', next ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (next) unlockSpeech();
    else {
      stopSpeaking();
      setSpeakingId(null);
    }
  };

  const toggleSpeakMessage = (m: ChatMessage) => {
    if (speakingId === m.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(m.id);
    speak(m.text, () => setSpeakingId((cur) => (cur === m.id ? null : cur)));
  };

  const lastUser = useMemo(() => [...messages].reverse().find((m) => m.role === 'user')?.text, [messages]);
  const empty = messages.length === 0 && !busy;

  return (
    <div className="app">
      <header className="top">
        <img className="logo" src="/icon.svg" alt="" width={40} height={40} />
        <div className="title">
          <h1>MJ</h1>
          <span className={`pill ${status}`}>
            <i />
            {status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Connecting'}
          </span>
        </div>
        {canSpeak() && (
          <button
            className={`icon-btn ${speakAll ? 'on' : ''}`}
            aria-label={speakAll ? 'Turn off spoken replies' : 'Speak every reply'}
            aria-pressed={speakAll}
            onClick={toggleSpeakAll}
          >
            {speakAll ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
        )}
        <button className="icon-btn" aria-label="Settings" onClick={() => setShowSettings(true)}>
          <Cog size={20} />
        </button>
      </header>

      <main className="stream" aria-live="polite">
        {empty && (
          <section className="hello">
            <div className="spark">
              <Sparkles size={22} />
            </div>
            <h2>Good day, Sir.</h2>
            <p>Ask anything, set reminders, or get the news. This chat is the same MJ as on Telegram.</p>
            <div className="chips">
              {CHIPS.map((c) => (
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
              <div className="bubble ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              <div className="meta">
                <time>{clock(m.at)}</time>
                {canSpeak() && (
                  <button
                    className={`speak ${speakingId === m.id ? 'on' : ''}`}
                    aria-label={speakingId === m.id ? 'Stop speaking' : 'Read aloud'}
                    onClick={() => toggleSpeakMessage(m)}
                  >
                    {speakingId === m.id ? <Square size={13} /> : <Volume2 size={15} />}
                  </button>
                )}
              </div>
            </div>
          ) : m.role === 'user' ? (
            <div key={m.id} className="row me">
              <div className="bubble me">{m.text}</div>
              <time>{clock(m.at)}</time>
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
            <div className="bubble me soft">Transcribing...</div>
          </div>
        )}
        {busy && (
          <div className="row ai">
            <div className="bubble ai typing" aria-label="MJ is typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
          inputRef.current?.focus();
        }}
      >
        {recording ? (
          <>
            <button type="button" className="icon-btn" aria-label="Cancel recording" onClick={cancelRecording}>
              <X size={22} />
            </button>
            <div className="rec" role="status">
              <span className="rec-dot" /> Listening... <b>{mmss(seconds)}</b>
            </div>
            <button type="button" className="send" aria-label="Send voice message" onClick={() => void finishRecording()}>
              <ArrowUp size={20} />
            </button>
          </>
        ) : (
          <>
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
            {text.trim() || !canRecord() ? (
              <button className="send" type="submit" disabled={!text.trim() || busy} aria-label="Send">
                <ArrowUp size={20} />
              </button>
            ) : (
              <button type="button" className="send mic" disabled={busy || transcribing} aria-label="Record a voice message" onClick={() => void beginRecording()}>
                <Mic size={20} />
              </button>
            )}
          </>
        )}
      </form>

      {showSettings && (
        <SettingsSheet
          initial={settings}
          required={!settings.token}
          onClose={() => setShowSettings(false)}
          onClear={() => {
            setMessages([]);
            setShowSettings(false);
          }}
          onSave={(s) => {
            saveSettings(s);
            setSettings(s);
            setStatus('idle');
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

function SettingsSheet(p: { initial: Settings; required: boolean; onClose: () => void; onClear: () => void; onSave: (s: Settings) => void }) {
  const [url, setUrl] = useState(p.initial.url);
  const [token, setToken] = useState(p.initial.token);
  return (
    <div className="scrim" onClick={p.required ? undefined : p.onClose}>
      <form
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) p.onSave({ url: url.trim().replace(/\/+$/, ''), token: token.trim() });
        }}
      >
        <div className="grab" />
        <div className="sheet-head">
          <h3>{p.required ? 'Connect to MJ' : 'Settings'}</h3>
          {!p.required && (
            <button type="button" className="icon-btn" aria-label="Close" onClick={p.onClose}>
              <X size={20} />
            </button>
          )}
        </div>
        <label>
          Backend URL (optional)
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Leave empty to use this site's connection"
          />
        </label>
        <label>
          Access token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="WEB_API_TOKEN from the backend"
          />
        </label>
        <p className="hint">
          Leave the URL empty unless you use a different server. Works with MJ or any server that offers <code>POST /api/chat</code> and <code>GET /api/history</code>. Settings stay on this phone.
        </p>
        <button className="primary" type="submit" disabled={!token.trim()}>
          Save and connect
        </button>
        {!p.required && (
          <button type="button" className="ghost" onClick={p.onClear}>
            Clear this screen
          </button>
        )}
      </form>
    </div>
  );
}
