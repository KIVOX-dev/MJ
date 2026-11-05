import crypto from 'node:crypto';
import { Router, json, raw, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from '../utils/logger';
import type { Responder } from '../core/orchestrator/assistant';
import type { MessageStore } from '../core/memory/message.store';
import type { SessionRepo } from '../core/memory/session.repo';
import { CATEGORIES, type PushService } from '../modules/communication-manager/push/push.service';

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
  /** Separate web chats (like ChatGPT conversations). Reminders and memory stay global across all of them. */
  sessions?: SessionRepo;
  storeFor?: (sessionId: string) => MessageStore;
  respondFor?: (sessionId: string) => Responder;
  /** Web Push: subscriptions, notification history and preferences. */
  push?: PushService;
  /** Stops a (repeating) reminder; used by the Stop button on a push notification. */
  stopReminder?: (reminderId: string) => Promise<boolean>;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000).startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

const fail = (res: Response, err: unknown, what: string) => {
  logger.error({ err: { message: (err as Error).message } }, `Web ${what} failed`);
  res.status(500).json({ error: 'internal_error' });
};

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

  /** "main" (or nothing) is the shared Telegram conversation; any other id must be an existing web chat. */
  async function pick(sessionId: unknown): Promise<{ id?: string; store: MessageStore; respond: Responder } | undefined> {
    const id = typeof sessionId === 'string' && sessionId && sessionId !== 'main' ? sessionId : undefined;
    if (!id) return { store: deps.store, respond: deps.respond };
    if (!deps.sessions || !deps.storeFor || !deps.respondFor || !(await deps.sessions.exists(id))) return undefined;
    return { id, store: deps.storeFor(id), respond: deps.respondFor(id) };
  }

  // ---- conversations ----
  r.get('/api/history', async (req, res) => {
    try {
      const chat = await pick(req.query.session_id);
      if (!chat) return void res.status(404).json({ error: 'unknown_session' });
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
      const rows = await chat.store.recent(limit);
      res.json({ messages: rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', text: m.text })) });
    } catch (err) {
      fail(res, err, 'history');
    }
  });

  r.post('/api/chat', json({ limit: '32kb' }), async (req, res) => {
    // "query" matches the older MJ-CHAT-BOT UI; "message" is accepted too.
    const raw = (req.body ?? {}) as { query?: unknown; message?: unknown; session_id?: unknown };
    const text = String(raw.query ?? raw.message ?? '').trim();
    if (!text || text.length > 4000) {
      res.status(400).json({ error: 'message must be 1-4000 characters' });
      return;
    }
    try {
      const chat = await pick(raw.session_id);
      if (!chat) return void res.status(404).json({ error: 'unknown_session' });
      const id = `web-${crypto.randomUUID()}`;
      await chat.store.claimInbound(id, deps.ownerChatId, text, 'text');
      // Reminders, memory and tools always act for the owner, whichever chat the message came from.
      const reply = await chat.respond(text, { channel: 'telegram', chatId: deps.ownerChatId });
      await chat.store.saveOutbound(`out-${id}`, deps.ownerChatId, reply);
      if (chat.id && deps.sessions) {
        await deps.sessions.autoTitle(chat.id, text);
        await deps.sessions.touch(chat.id);
      }
      res.json({ reply, answer: reply });
    } catch (err) {
      fail(res, err, 'chat');
    }
  });

  if (deps.sessions) {
    const sessions = deps.sessions;
    r.get('/api/sessions', async (_req, res) => {
      try {
        res.json({ main: { id: 'main', title: 'Telegram chat' }, sessions: await sessions.list() });
      } catch (err) {
        fail(res, err, 'sessions');
      }
    });
    r.post('/api/sessions', async (_req, res) => {
      try {
        res.status(201).json(await sessions.create());
      } catch (err) {
        fail(res, err, 'session create');
      }
    });
    r.patch('/api/sessions/:id', json({ limit: '4kb' }), async (req, res) => {
      const p = z.object({ title: z.string().trim().min(1).max(80) }).safeParse(req.body);
      if (!p.success) return void res.status(400).json({ error: 'title required' });
      try {
        const ok = await sessions.rename(String(req.params.id), p.data.title);
        res.status(ok ? 200 : 404).json({ ok });
      } catch (err) {
        fail(res, err, 'session rename');
      }
    });
    r.delete('/api/sessions/:id', async (req, res) => {
      try {
        const ok = await sessions.remove(String(req.params.id));
        res.status(ok ? 200 : 404).json({ ok });
      } catch (err) {
        fail(res, err, 'session delete');
      }
    });
  }

  // ---- voice ----
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

  // ---- reminders ----
  if (deps.stopReminder) {
    const stop = deps.stopReminder;
    r.post('/api/reminders/:id/stop', async (req, res) => {
      const id = String(req.params.id);
      if (!/^[a-f0-9]{24}$/i.test(id)) return void res.status(400).json({ error: 'bad_id' });
      try {
        res.json({ stopped: await stop(id) });
      } catch (err) {
        fail(res, err, 'reminder stop');
      }
    });
  }

  // ---- push notifications ----
  if (deps.push) {
    const push = deps.push;
    const testLimit = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });

    r.get('/api/push/status', async (_req: Request, res: Response) => {
      try {
        res.json(await push.status());
      } catch (err) {
        fail(res, err, 'push status');
      }
    });

    r.post('/api/push/subscribe', json({ limit: '8kb' }), async (req, res) => {
      if (!push.enabled) return void res.status(503).json({ error: 'push_not_configured' });
      const p = subscriptionSchema.safeParse((req.body as { subscription?: unknown })?.subscription);
      if (!p.success) return void res.status(400).json({ error: 'invalid_subscription' });
      try {
        await push.subscribe({ ...p.data, userAgent: req.header('user-agent') ?? undefined });
        res.status(201).json({ ok: true });
      } catch (err) {
        fail(res, err, 'push subscribe');
      }
    });

    r.post('/api/push/unsubscribe', json({ limit: '4kb' }), async (req, res) => {
      const p = z.object({ endpoint: z.string().url().max(1000) }).safeParse(req.body);
      if (!p.success) return void res.status(400).json({ error: 'invalid_endpoint' });
      try {
        await push.unsubscribe(p.data.endpoint);
        res.json({ ok: true });
      } catch (err) {
        fail(res, err, 'push unsubscribe');
      }
    });

    r.post('/api/push/test', testLimit, async (_req, res) => {
      if (!push.enabled) return void res.status(503).json({ error: 'push_not_configured' });
      const out = await push.send({ title: 'MJ test notification', body: 'Notifications are working, Sir.', category: 'system', url: '/', tag: 'mj-test' });
      res.json(out);
    });

    r.get('/api/push/prefs', async (_req, res) => {
      try {
        res.json(await push.getPrefs());
      } catch (err) {
        fail(res, err, 'prefs');
      }
    });
    r.post('/api/push/prefs', json({ limit: '2kb' }), async (req, res) => {
      const shape = Object.fromEntries(CATEGORIES.map((c) => [c, z.boolean().optional()]));
      const p = z.object(shape).strict().safeParse(req.body);
      if (!p.success) return void res.status(400).json({ error: 'invalid_prefs' });
      try {
        res.json(await push.setPrefs(p.data as Record<string, boolean>));
      } catch (err) {
        fail(res, err, 'prefs');
      }
    });

    r.get('/api/notifications', async (req, res) => {
      try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
        const [items, status] = await Promise.all([push.list(limit), push.status()]);
        res.json({ notifications: items, unread: status.unread });
      } catch (err) {
        fail(res, err, 'notifications');
      }
    });
    r.post('/api/notifications/read', json({ limit: '8kb' }), async (req, res) => {
      const p = z.object({ ids: z.array(z.string().max(40)).max(200).optional() }).safeParse(req.body ?? {});
      if (!p.success) return void res.status(400).json({ error: 'invalid_ids' });
      try {
        res.json({ updated: await push.markRead(p.data.ids) });
      } catch (err) {
        fail(res, err, 'mark read');
      }
    });
  }

  return r;
}
