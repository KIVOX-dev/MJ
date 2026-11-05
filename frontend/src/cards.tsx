import { useState } from 'react';
import { Check, Mail, Send, Trash2 } from 'lucide-react';
import { discardDraft, sendDraft, type Settings } from './api';
import type { DraftData } from './markdown';

type State = 'idle' | 'sending' | 'sent' | 'discarded';
const KEY = 'mj.drafts';

const readOutcomes = (): Record<string, 'sent' | 'discarded'> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, 'sent' | 'discarded'>;
  } catch {
    return {};
  }
};
const remember = (id: string, v: 'sent' | 'discarded') => {
  try {
    const all = readOutcomes();
    all[id] = v;
    const keep = Object.fromEntries(Object.entries(all).slice(-60));
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    /* ignore */
  }
};

/** An email the assistant drafted. Nothing is sent until Sir taps Send here; the server then sends it through Brevo. */
export function DraftCard({ draft, settings }: { draft: DraftData; settings: Settings }) {
  const [state, setState] = useState<State>(() => readOutcomes()[draft.id] ?? 'idle');
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState('');

  const send = async () => {
    setState('sending');
    setError('');
    try {
      await sendDraft(settings, draft.id, { subject, body });
      remember(draft.id, 'sent');
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };
  const discard = async () => {
    try {
      await discardDraft(settings, draft.id);
    } catch {
      /* it may already be gone */
    }
    remember(draft.id, 'discarded');
    setState('discarded');
  };

  if (state === 'sent')
    return (
      <div className="draft done ok">
        <Check size={18} /> Sent to <b>{draft.to}</b>
      </div>
    );
  if (state === 'discarded') return <div className="draft done">Draft discarded</div>;

  return (
    <div className="draft">
      <div className="draft-head">
        <Mail size={16} /> Email draft
      </div>
      <div className="draft-to">
        To <b>{draft.to}</b>
      </div>
      <input className="draft-subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" maxLength={200} />
      <textarea className="draft-body" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email text" rows={Math.min(14, Math.max(5, body.split('\n').length + 1))} />
      {error && <p className="draft-error">{error}</p>}
      <div className="draft-actions">
        <button className="draft-send" onClick={() => void send()} disabled={state === 'sending' || !subject.trim() || !body.trim()}>
          <Send size={16} /> {state === 'sending' ? 'Sending...' : 'Send email'}
        </button>
        <button className="draft-discard" onClick={() => void discard()} disabled={state === 'sending'} aria-label="Discard draft">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
