import { useEffect, useRef, useState } from 'react';
import { Ear, Mic, MicOff, X } from 'lucide-react';
import { transcribeAudio, type Settings } from './api';
import { DraftCard } from './cards';
import { renderMarkdown, splitDrafts, type DraftData } from './markdown';
import { openMicSession, playbackFraction, readSttLang, speakAsync, speakableText, stopSpeaking, unlockSpeech, type Listener, type MicSession } from './voice';

type Phase = 'listening' | 'thinking' | 'speaking' | 'paused';

const STATUS: Record<Phase, string> = {
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking... tap to interrupt',
  paused: 'Tap the circle to talk',
};

const BARGE_KEY = 'mj.barge';
const readBarge = () => {
  try {
    return localStorage.getItem(BARGE_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Hands-free conversation, like ChatGPT's voice mode: speak, pause, and MJ answers out loud, then listens again.
 * The microphone stays open for the whole conversation, the captions follow the voice as it speaks, and with
 * "Talk over me" on you can simply start talking to interrupt. Email drafts appear right here with a
 * "Confirm receiver" step and a Send button (an address heard by a microphone must be checked before it is used).
 */
export function VoiceMode(p: { settings: Settings; ask: (text: string) => Promise<string | undefined>; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('listening');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [spokenChars, setSpokenChars] = useState(0);
  const [drafts, setDrafts] = useState<DraftData[]>([]);
  const [pictures, setPictures] = useState('');
  const [error, setError] = useState('');
  const [barge, setBarge] = useState(readBarge);
  const run = useRef(0);
  const mic = useRef<MicSession | null>(null);
  const listener = useRef<Listener | null>(null);
  const phaseRef = useRef<Phase>('listening');
  const level = useRef(0);
  const progress = useRef({ base: 0, len: 0 });
  const orb = useRef<HTMLDivElement>(null);

  const go = (ph: Phase) => {
    phaseRef.current = ph;
    setPhase(ph);
  };

  async function cycle() {
    const my = ++run.current;
    const alive = () => my === run.current;
    while (alive()) {
      go('listening');
      setError('');
      let l: Listener;
      try {
        mic.current ??= await openMicSession();
        l = mic.current.listen((v) => (level.current = v));
      } catch (e) {
        setError((e as Error).message);
        return go('paused');
      }
      listener.current = l;
      const blob = await l.done;
      if (!alive()) return;
      if (!blob) return go('paused'); // nothing was said for a while
      go('thinking');
      let said = '';
      try {
        said = await transcribeAudio(p.settings, blob, readSttLang());
      } catch (e) {
        setError((e as Error).message);
        return go('paused');
      }
      if (!alive()) return;
      if (!said) continue; // heard only noise: listen again
      setHeard(said);
      setReply('');
      setDrafts([]);
      setPictures('');
      setSpokenChars(0);
      const answer = await p.ask(said);
      if (!alive()) return;
      if (!answer) return go('paused');
      const { text, drafts: cards } = splitDrafts(answer);
      setDrafts(cards);
      setPictures([...text.matchAll(/!\[[^\]]*\]\(\/api\/images\/[a-f0-9]{32}\)/g)].map((m) => m[0]).join('\n\n'));
      const caption = speakableText(answer);
      setReply(caption);
      go('speaking');
      progress.current = { base: 0, len: 0 };
      await speakAsync(answer, p.settings, (before, chunk) => (progress.current = { base: before ? before.length + 1 : 0, len: chunk.length })); // resolves when finished or interrupted
      setSpokenChars(caption.length);
    }
  }

  useEffect(() => {
    unlockSpeech();
    void cycle();
    return () => {
      run.current++;
      listener.current?.cancel();
      stopSpeaking();
      mic.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the circle breathes with the mic while listening and with the voice while speaking
  useEffect(() => {
    let raf = 0;
    let cur = 0;
    const tick = () => {
      const ph = phaseRef.current;
      const target = ph === 'listening' ? level.current : ph === 'speaking' ? 0.2 + 0.25 * Math.abs(Math.sin(Date.now() / 150)) : ph === 'thinking' ? 0.18 + 0.12 * Math.sin(Date.now() / 260) : 0.05;
      cur += (target - cur) * 0.25;
      orb.current?.style.setProperty('--lvl', String(1 + cur * 0.4));
      if (ph === 'speaking') setSpokenChars((prev) => { const n = Math.round(progress.current.base + progress.current.len * playbackFraction()); return n > prev ? n : prev; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // "Talk over me": while MJ speaks, sustained louder sound on the mic than MJ's own voice leaking in means Sir is speaking
  useEffect(() => {
    if (phase !== 'speaking' || !barge) return;
    let loud = 0;
    let own = 0;
    const t0 = Date.now();
    const id = setInterval(() => {
      const lv = mic.current?.level() ?? 0;
      if (Date.now() - t0 < 800) {
        own = Math.max(own, lv); // learn how loud MJ's own voice is at the mic
        return;
      }
      loud = lv > Math.max(0.12, own * 2.2) ? loud + 1 : Math.max(0, loud - 1);
      if (loud >= 4) {
        loud = 0;
        stopSpeaking(); // the loop goes straight back to listening
      }
    }, 60);
    return () => clearInterval(id);
  }, [phase, barge]);

  const tapOrb = () => {
    if (phase === 'listening') listener.current?.finish();
    else if (phase === 'speaking') stopSpeaking();
    else if (phase === 'paused') void cycle();
  };

  const pause = () => {
    run.current++;
    listener.current?.cancel();
    stopSpeaking();
    go('paused');
  };

  const close = () => {
    run.current++;
    listener.current?.cancel();
    stopSpeaking();
    p.onClose();
  };

  const toggleBarge = () => {
    const next = !barge;
    setBarge(next);
    try {
      localStorage.setItem(BARGE_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const done = reply.slice(0, Math.min(reply.length, spokenChars));
  const rest = reply.slice(done.length);

  return (
    <div className="voice" role="dialog" aria-label="Voice mode">
      <div className="voice-top">
        <span>Voice mode</span>
        <button className="icon-btn" aria-label="Close voice mode" onClick={close}>
          <X size={22} />
        </button>
      </div>

      <button className={`orb-wrap ${phase}`} onClick={tapOrb} aria-label={STATUS[phase]}>
        <div className="orb" ref={orb}>
          <i />
        </div>
      </button>

      <p className="voice-status" role="status">
        {STATUS[phase]}
      </p>

      <div className="voice-captions">
        {error && <p className="voice-error">{error}</p>}
        {heard && <p className="heard">{heard}</p>}
        {reply && (
          <p className="said">
            <span className="spoken">{done}</span>
            <span className="unspoken">{rest}</span>
          </p>
        )}
        {pictures && <div className="voice-pics md" dangerouslySetInnerHTML={{ __html: renderMarkdown(pictures) }} />}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} settings={p.settings} confirmReceiver />
        ))}
      </div>

      <div className="voice-bar">
        <button className={`vbtn ${barge ? 'on' : ''}`} aria-label={barge ? 'Talk over me: on' : 'Talk over me: off'} aria-pressed={barge} onClick={toggleBarge} title="Talk over me (best with headphones)">
          <Ear size={24} />
        </button>
        <button className="vbtn" aria-label={phase === 'paused' ? 'Start listening' : 'Pause'} onClick={() => (phase === 'paused' ? void cycle() : pause())}>
          {phase === 'paused' ? <Mic size={26} /> : <MicOff size={26} />}
        </button>
        <button className="vbtn end" aria-label="End voice mode" onClick={close}>
          <X size={26} />
        </button>
      </div>
      <p className="voice-hint">{barge ? 'Talk over me is on: just start speaking to interrupt. Headphones work best.' : 'Tap the circle to interrupt, or turn on the ear to talk over me.'}</p>
    </div>
  );
}
