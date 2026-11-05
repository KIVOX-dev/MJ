import crypto from 'node:crypto';
import { Router, json, raw, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from '../utils/logger';
import type { DocumentInput, ImageInput, Responder } from '../core/orchestrator/assistant';
import { extractPdfText, extractPlainText } from '../utils/pdf';
import type { EmailController } from '../modules/communication-manager/email/email.tools';
import { DEFAULT_VOICE, TTS_MAX_CHARS, TtsTermsRequired, VOICE_IDS, type Speech } from '../core/ai-engine/speech';
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
  transcribe?: (audio: Buffer, mime: string, language?: string) => Promise<string>;
  /** Today's MJ TIMES PDF, for the download button and for "send me the newspaper". */
  newspaper?: () => Promise<{ name: string; data: Buffer }>;
  /** Sends or discards email drafts when Sir taps the buttons on a draft card. */
  emailDrafts?: EmailController;
  /** Reads a generated picture by id (the id is random and unguessable, so the image link needs no token). */
  getImage?: (id: string) => Promise<{ data: Buffer; mime: string } | undefined>;
  /** Natural-sounding speech for replies; the /api/tts route is only offered when this is set. */
  speak?: (text: string, voiceId: string) => Promise<Speech>;
  /** The voices offered in Settings and the one used by default (depends on which engines are configured). */
  voices?: { default: string; voices: Array<{ id: string; label: string }> };
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

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mime: z.string().max(100).default(''),
  /** The file as base64 (a photo is resized by the app before it is sent). */
  data: z.string().min(1),
});
const MAX_ATTACHMENTS = 4;
const MAX_PHOTO_BYTES = 3_500_000; // keeps the model request under its 4 MB image limit
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

class BadAttachment extends Error {}

/** Photos go to the vision model; PDFs and text files are read into text. Same rules as the Telegram bot. */
async function readAttachments(list: Array<z.infer<typeof attachmentSchema>>): Promise<{ images: ImageInput[]; documents: DocumentInput[]; labels: string[] }> {
  const images: ImageInput[] = [];
  const documents: DocumentInput[] = [];
  const labels: string[] = [];
  for (const a of list) {
    const buf = Buffer.from(a.data, 'base64');
    if (!buf.length) throw new BadAttachment(`"${a.name}" is empty.`);
    const isPdf = a.mime === 'application/pdf' || /\.pdf$/i.test(a.name);
    const isText = /^text\/plain/i.test(a.mime) || /\.txt$/i.test(a.name);
    if (/^image\//i.test(a.mime)) {
      const mime = isJpeg(buf) ? 'image/jpeg' : isPng(buf) ? 'image/png' : undefined;
      if (!mime) throw new BadAttachment(`"${a.name}": I can read JPEG and PNG photos only.`);
      if (buf.length > MAX_PHOTO_BYTES) throw new BadAttachment(`"${a.name}" is too large. Please send a smaller photo.`);
      images.push({ mime, data: buf });
      labels.push(`photo ${a.name}`);
    } else if (isPdf || isText) {
      let doc;
      try {
        doc = isPdf ? await extractPdfText(buf) : extractPlainText(buf);
      } catch (e) {
        throw new BadAttachment(`"${a.name}": ${(e as Error).message}.`.replace('..', '.'));
      }
      if (!doc.text.trim()) throw new BadAttachment(`"${a.name}" has no text I can read. If it is a scan, please send photos of the pages instead.`);
      documents.push({ name: a.name, text: doc.truncated ? `${doc.text}\n[... the rest of the document was cut off ...]` : doc.text });
      labels.push(a.name);
    } else {
      throw new BadAttachment(`"${a.name}": I can read photos (JPEG/PNG), PDFs and text files.`);
    }
  }
  return { images, documents, labels };
}

const fail = (res: Response, err: unknown, what: string) => {
  logger.error({ err: { message: (err as Error).message } }, `Web ${what} failed`);
  res.status(500).json({ error: 'internal_error' });
};

/** Mobile web chat API: the same assistant as the Telegram bot, behind a bearer token. */
export function webChatRouter(deps: WebChatDeps): Router {
  const r = Router();

  // Generated pictures are loaded by <img> tags, which cannot send the access token. The 128-bit random id is the key.
  if (deps.getImage) {
    const getImage = deps.getImage;
    r.get('/api/images/:id', async (req, res) => {
      const id = String(req.params.id);
      if (!/^[a-f0-9]{32}$/.test(id)) return void res.status(404).json({ error: 'not_found' });
      try {
        const img = await getImage(id);
        if (!img) return void res.status(404).json({ error: 'not_found' });
        res.setHeader('Content-Type', img.mime);
        res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(img.data);
      } catch (err) {
        fail(res, err, 'image');
      }
    });
  }

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

  r.post('/api/chat', json({ limit: '16mb' }), async (req, res) => {
    // "query" matches the older MJ-CHAT-BOT UI; "message" is accepted too.
    const raw = (req.body ?? {}) as { query?: unknown; message?: unknown; session_id?: unknown; attachments?: unknown; voice?: unknown };
    const typed = String(raw.query ?? raw.message ?? '').trim();
    const parsedFiles = z.array(attachmentSchema).max(MAX_ATTACHMENTS).safeParse(raw.attachments ?? []);
    if (!parsedFiles.success) return void res.status(400).json({ error: `Up to ${MAX_ATTACHMENTS} files, each with a name and content.` });
    if (typed.length > 4000 || (!typed && !parsedFiles.data.length)) {
      res.status(400).json({ error: 'message must be 1-4000 characters' });
      return;
    }
    let files: Awaited<ReturnType<typeof readAttachments>>;
    try {
      files = await readAttachments(parsedFiles.data);
    } catch (err) {
      if (err instanceof BadAttachment) return void res.status(400).json({ error: err.message });
      return fail(res, err, 'attachments');
    }
    const text = typed || 'Please look at what I attached and tell me what it is.';
    // What is kept in the chat history: the words plus the names of the attached files.
    const stored = files.labels.length ? `${typed}${typed ? '\n' : ''}${files.labels.map((l) => `📎 ${l}`).join('\n')}` : typed;
    try {
      const chat = await pick(raw.session_id);
      if (!chat) return void res.status(404).json({ error: 'unknown_session' });
      const id = `web-${crypto.randomUUID()}`;
      await chat.store.claimInbound(id, deps.ownerChatId, stored || text, 'text');
      // Reminders, memory and tools always act for the owner, whichever chat the message came from.
      const pictures: string[] = [];
      const draftCards: Array<{ id: string; to: string; subject: string; body: string; attachNewspaper?: boolean }> = [];
      const fileCards: Array<{ name: string; path: string }> = [];
      const who = {
        channel: 'telegram' as const,
        chatId: deps.ownerChatId,
        ...(raw.voice === true ? { voice: true } : {}),
        ...(deps.getImage ? { onImage: (pid: string) => void pictures.push(pid) } : {}),
        ...(deps.emailDrafts ? { onDraft: (d: { id: string; to: string; subject: string; body: string; attachNewspaper?: boolean }) => void draftCards.push(d) } : {}),
        ...(deps.newspaper ? { onFile: (f: { name: string; path: string }) => void fileCards.push(f) } : {}),
      };
      const answer = files.labels.length
        ? await chat.respond(text, who, files.images.length ? files.images : undefined, files.documents.length ? files.documents : undefined)
        : await chat.respond(text, who);
      // Pictures made during this turn go under the reply as Markdown images (the app shows them as cards).
      // A draft becomes a card in the app (a fenced block it renders with Send / Discard buttons). Backticks are escaped so the text cannot break the fence.
      const cards = draftCards.map((d) => `\n\n\`\`\`mj-email\n${JSON.stringify(d).replace(/`/g, '\\u0060')}\n\`\`\``).join('');
      const fileFences = fileCards.map((f) => `\n\n\`\`\`mj-file\n${JSON.stringify(f).replace(/`/g, '\\u0060')}\n\`\`\``).join('');
      const reply = answer + pictures.map((pid) => `\n\n![Generated image](/api/images/${pid})`).join('') + fileFences + cards;
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
        const text = await transcribe(audio, req.header('content-type') ?? 'audio/webm', req.header('x-language') ?? undefined);
        res.json({ text });
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'Web transcription failed');
        res.status(502).json({ error: 'transcription_failed' });
      }
    });
  }

  // ---- natural voice ----
  if (deps.speak) {
    const speak = deps.speak;
    const ttsLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
    r.get('/api/tts/voices', (_req, res) => void res.json(deps.voices ?? { default: DEFAULT_VOICE, voices: [] }));
    r.post('/api/tts', ttsLimit, json({ limit: '4kb' }), async (req, res) => {
      const p = z.object({ text: z.string().trim().min(1).max(TTS_MAX_CHARS), voice: z.enum(VOICE_IDS).default(deps.voices?.default ?? DEFAULT_VOICE) }).safeParse(req.body);
      if (!p.success) return void res.status(400).json({ error: `text must be 1-${TTS_MAX_CHARS} characters and voice one of the listed voices` });
      try {
        const audio = await speak(p.data.text, p.data.voice);
        res.setHeader('Content-Type', audio.mime);
        res.setHeader('Cache-Control', 'no-store');
        res.send(audio.data);
      } catch (err) {
        if (err instanceof TtsTermsRequired) return void res.status(503).json({ error: 'tts_terms_required', message: err.message });
        logger.warn({ err: { message: (err as Error).message } }, 'Web speech failed');
        res.status(502).json({ error: 'speech_failed' });
      }
    });
  }

  // ---- the newspaper ----
  if (deps.newspaper) {
    const paper = deps.newspaper;
    r.get('/api/newspaper.pdf', async (_req, res) => {
      try {
        const f = await paper();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/[^\w.-]/g, '_')}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(f.data);
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'Newspaper download failed');
        res.status(503).json({ error: 'newspaper_unavailable' });
      }
    });
  }

  // ---- email draft buttons ----
  if (deps.emailDrafts) {
    const mail = deps.emailDrafts;
    const sendLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
    r.post('/api/email/send', sendLimit, json({ limit: '64kb' }), async (req, res) => {
      const p = z
        .object({ draft_id: z.string().min(4).max(20), attach_newspaper: z.boolean().optional(), to: z.string().trim().email().max(200).optional(), subject: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(10000).optional() })
        .safeParse(req.body);
      if (!p.success) return void res.status(400).json({ error: 'A draft id is required.' });
      try {
        res.json(await mail.send(p.data.draft_id, { to: p.data.to, subject: p.data.subject, body: p.data.body, attachNewspaper: p.data.attach_newspaper }));
      } catch (err) {
        // expected problems (expired draft, daily limit, mail service refusing) are shown to Sir as they are
        logger.warn({ err: { message: (err as Error).message } }, 'Email send from the app failed');
        res.status(400).json({ error: (err as Error).message.slice(0, 200) });
      }
    });
    r.post('/api/email/discard', json({ limit: '4kb' }), (req, res) => {
      const id = String((req.body as { draft_id?: unknown })?.draft_id ?? '');
      res.json({ discarded: mail.discard(id) });
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
