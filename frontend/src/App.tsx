import { useEffect, useState } from 'react';
import { API_URL, getReady } from './api';

export function App() {
  const [state, setState] = useState<'checking' | 'ready' | 'degraded' | 'offline'>('checking');

  useEffect(() => {
    getReady()
      .then((r) => setState(r.status === 'ready' ? 'ready' : 'degraded'))
      .catch(() => setState('offline'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 560, margin: '15vh auto', padding: '0 16px' }}>
      <h1>MJ</h1>
      <p>Your Personal Intelligence Assistant</p>
      <p>
        Backend (<code>{API_URL}</code>): <strong>{state}</strong>
      </p>
    </main>
  );
}
