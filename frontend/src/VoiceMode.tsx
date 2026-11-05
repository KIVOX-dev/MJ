import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
import { transcribeAudio, type Settings } from './api';
import { listen, outputLevel, readSttLang, speakAsync, stopSpeaking, unlockSpeech, type Listener } from './voice';

type Phase = 'listening' | 'thinking' | 'speaking' | 'paused';

const STATUS: Record<Phase, string> = {
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking... tap to interrupt',
  paused: 'Tap the circle to talk',
};

/**
 * Hands-free conversation, like ChatGPT's voice mode: speak, pause, and MJ answers out loud, then listens again.
 * Tap the circle to send early, to interrupt a reply, or to start again after a pause.
 */
export function VoiceMode(p: { settings: Settings; ask: (text: string) => Promise<string | undefined>; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('listening');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const run = useRef(0);
  const listener = useRef<Listener | null>(null);
  const phaseRef = useRef<Phase>('listening');
  const level = useRef(0);
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
        l = await listen((v) => (level.current = v));
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
      const answer = await p.ask(said);
      if (!alive()) return;
      if (!answer) return go('paused');
      setReply(answer.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim());
      go('speaking');
      await speakAsync(answer, p.settings); // resolves when finished or interrupted
    }
  }

  useEffect(() => {
    unlockSpeech();
    void cycle();
    return () => {
      run.current++;
      listener.current?.cancel();
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the orb breathes with the mic while listening and with the voice while speaking
  useEffect(() => {
    let raf = 0;
    let cur = 0;
    const tick = () => {
      const ph = phaseRef.current;
      const target = ph === 'listening' ? level.current : ph === 'speaking' ? outputLevel() : ph === 'thinking' ? 0.18 + 0.12 * Math.sin(Date.now() / 260) : 0.05;
      cur += (target - cur) * 0.25;
      orb.current?.style.setProperty('--lvl', String(1 + cur * 0.4));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const tapOrb = () => {
    if (phase === 'listening') listener.current?.finish();
    else if (phase === 'speaking') stopSpeaking(); // the loop then goes straight back to listening
    else if (phase === 'paused') void cycle();
  };

  const close = () => {
    run.current++;
    listener.current?.cancel();
    stopSpeaking();
    p.onClose();
  };

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
        {reply && <p className="said">{reply}</p>}
      </div>

      <div className="voice-bar">
        <button className="vbtn" aria-label={phase === 'paused' ? 'Start listening' : 'Pause'} onClick={() => (phase === 'paused' ? void cycle() : (run.current++, listener.current?.cancel(), stopSpeaking(), go('paused')))}>
          {phase === 'paused' ? <Mic size={26} /> : <MicOff size={26} />}
        </button>
        <button className="vbtn end" aria-label="End voice mode" onClick={close}>
          <X size={26} />
        </button>
      </div>
    </div>
  );
}
