import crypto from 'node:crypto';
import { Router, json, raw } from 'express';
import { logger } from '../utils/logger';
import type { Responder } from '../core/orchestrator/assistant';
import type { MessageStore } from '../core/memory/message.store';

export interface WebChatDeps {
  /** Shared secret the web app sends as "Authorization: Bearer <token>". */
  token: string;
  /** Same agent the Telegram bot uses, so memory, history and reminders are shared. */
  respond: Responder;
  store: MessageStore;
  /** The owner's chat id on the shared channel (the Telegram owner id). */
  ownerChatId: string;
  /** Speech-to-text for voice messages; the /api/transcribe route is only offered when this is set. */
  transcribe?: (audio: Buffer, mime: string) => Promise<string>;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Mobile web chat API: the same assistant as the Telegram bot, behind a bearer token. */
export function webChatRouter(deps: WebChatDeps): Router {
  const r = Router();

  r.use('/api', (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m || !safeEqual(m[1]!, deps.token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  r.get('/api/history', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
      const rows = await deps.store.recent(limit);
      res.json({ messages: rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', text: m.text })) });
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Web history failed');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  r.post('/api/chat', json({ limit: '32kb' }), async (req, res) => {
    // "query" matches the older MJ-CHAT-BOT UI; "message" is accepted too.
    const raw = (req.body ?? {}) as { query?: unknown; message?: unknown };
    const text = String(raw.query ?? raw.message ?? '').trim();
    if (!text || text.length > 4000) {
      res.status(400).json({ error: 'message must be 1-4000 characters' });
      return;
    }
    try {
      const id = `web-${crypto.randomUUID()}`;
      await deps.store.claimInbound(id, deps.ownerChatId, text, 'text');
      const reply = await deps.respond(text, { channel: 'telegram', chatId: deps.ownerChatId });
      await deps.store.saveOutbound(`out-${id}`, deps.ownerChatId, reply);
      res.json({ reply, answer: reply });
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Web chat failed');
      res.status(500).json({ error: 'internal_error' });
    }
  });

  if (deps.transcribe) {
    const transcribe = deps.transcribe;
    r.post('/api/transcribe', raw({ type: 'audio/*', limit: '10mb' }), async (req, res) => {
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length < 200) {
        res.status(400).json({ error: 'send audio as the request body (Content-Type: audio/*)' });
        return;
      }
      try {
        const text = await transcribe(audio, req.header('content-type') ?? 'audio/webm');
        res.json({ text });
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'Web transcription failed');
        res.status(502).json({ error: 'transcription_failed' });
      }
    });
  }

  return r;
}
