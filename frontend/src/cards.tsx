import { useState } from 'react';
import { Check, CheckCircle2, Mail, Send, Trash2 } from 'lucide-react';
import { discardDraft, sendDraft, type Settings } from './api';
import type { DraftData } from './markdown';

type State = 'idle' | 'sending' | 'sent' | 'discarded';
const KEY = 'mj.drafts';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-60))));
  } catch {
    /* ignore */
  }
};

/**
 * An email the assistant drafted. Nothing is sent until Sir taps Send here; the server then sends it through Brevo.
 * With `confirmReceiver` (voice mode, or whenever the address is missing) the receiver must first be checked and confirmed:
 * an address heard by a microphone can easily be wrong, so Send stays locked until Sir confirms it.
 */
export function DraftCard({ draft, settings, confirmReceiver = false }: { draft: DraftData; settings: Settings; confirmReceiver?: boolean }) {
  const needsConfirm = confirmReceiver || !draft.to;
  const [state, setState] = useState<State>(() => readOutcomes()[draft.id] ?? 'idle');
  const [to, setTo] = useState(draft.to);
  const [confirmed, setConfirmed] = useState(!needsConfirm);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState('');
  const validTo = EMAIL.test(to.trim());

  const send = async () => {
    setState('sending');
    setError('');
    try {
      await sendDraft(settings, draft.id, { to: to.trim(), subject, body });
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
        <Check size={18} /> Sent to <b>{to.trim()}</b>
      </div>
    );
  if (state === 'discarded') return <div className="draft done">Draft discarded</div>;

  return (
    <div className="draft">
      <div className="draft-head">
        <Mail size={16} /> Email draft
      </div>

      {confirmed ? (
        <div className="draft-to">
          To <b>{to.trim()}</b>
          {needsConfirm && (
            <>
              <span className="draft-ok">
                <CheckCircle2 size={14} /> receiver confirmed
              </span>
              <button className="draft-change" onClick={() => setConfirmed(false)}>
                Change
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="draft-receiver">
          <label>
            Who should receive it? Check the address:
            <input
              className="draft-subject"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="name@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="Receiver email address"
            />
          </label>
          {to.trim() && !validTo && <p className="draft-error">That does not look like an email address yet.</p>}
          <button className="draft-confirm" onClick={() => setConfirmed(true)} disabled={!validTo}>
            <CheckCircle2 size={16} /> Confirm receiver
          </button>
        </div>
      )}

      <input className="draft-subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" maxLength={200} />
      <textarea className="draft-body" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email text" rows={Math.min(12, Math.max(4, body.split('\n').length + 1))} />
      {error && <p className="draft-error">{error}</p>}
      <div className="draft-actions">
        <button className="draft-send" onClick={() => void send()} disabled={!confirmed || state === 'sending' || !subject.trim() || !body.trim()}>
          <Send size={16} /> {state === 'sending' ? 'Sending...' : confirmed ? 'Send email' : 'Confirm receiver to send'}
        </button>
        <button className="draft-discard" onClick={() => void discard()} disabled={state === 'sending'} aria-label="Discard draft">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
