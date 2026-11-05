import { logger } from '../../../utils/logger';
import type { AgentContext, Responder } from '../../../core/orchestrator/assistant';
import type { MessageStore } from '../../../core/memory/message.store';
import { MAX_DOC_BYTES, extractPdfText, extractPlainText } from '../../../utils/pdf';
import type { TelegramSender } from './telegram.client';

export interface TelegramHandlerDeps {
  /** Numeric Telegram user id of the owner. Empty means fail closed. */
  ownerId: string;
  store: MessageStore;
  respond: Responder;
  sender: TelegramSender;
  /** Stops a reminder when its Stop button is pressed. Returns false if it was not active any more. */
  stopReminder?: (chatId: string, reminderId: string) => Promise<boolean>;
  /** Builds and sends today's MJ TIMES PDF to the chat. Throws if it cannot. */
  sendNewspaper?: (chatId: number) => Promise<void>;
  /** Speech-to-text for voice notes. Without it, voice notes get a polite "not enabled" reply. */
  transcribe?: (audio: Buffer, mime: string) => Promise<string>;
  /** Reads a picture MJ generated, so it can be sent to the chat. */
  getImage?: (id: string) => Promise<{ data: Buffer; mime: string } | undefined>;
}

/** Handles taps on inline buttons. Only the owner may press them; everything else is ignored. */
async function processCallback(update: TgUpdate, deps: TelegramHandlerDeps): Promise<void> {
  const cb = update.callback_query!;
  try {
    const fromId = String(cb.from.id);
    if (!deps.ownerId || fromId !== deps.ownerId) {
      logger.warn('Ignored Telegram button press from non-owner');
      return;
    }
    const m = /^stop:([a-f0-9]{24})$/i.exec(cb.data ?? '');
    if (!m || !deps.stopReminder || !cb.message) {
      await deps.sender.answerCallback?.(cb.id);
      return;
    }
    const chatId = String(cb.message.chat.id);
    const stopped = await deps.stopReminder(chatId, m[1]!);
    await deps.sender.answerCallback?.(cb.id, stopped ? 'Reminder stopped' : 'Already stopped');
    await deps.sender.clearKeyboard?.(cb.message.chat.id, cb.message.message_id).catch(() => undefined);
    if (stopped) await deps.sender.sendText(cb.message.chat.id, 'Understood, Sir. That reminder is stopped.');
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'Failed processing Telegram button press');
  }
}

export interface TgUpdate {
  update_id: number;
  /** A tap on an inline button (e.g. "Stop reminder"). */
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
    text?: string;
    /** Text that accompanies a photo or file. */
    caption?: string;
    /** The same photo in several sizes, smallest first. */
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
    /** A file sent as a document (images sent "as file" arrive here). */
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    /** A recorded voice note (OGG/Opus). */
    voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
    /** An audio file sent as music/audio. */
    audio?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
    /** A round "video message". Its sound is transcribed like a voice note. */
    video_note?: { file_id: string; duration?: number; file_size?: number };
    /** A normal video. Its sound is transcribed like a voice note. */
    video?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
  };
}

/** PDF or plain-text file the user sent (images sent as files are handled as photos). */
function pickDocument(msg: NonNullable<TgUpdate['message']>): { fileId: string; name: string; kind: 'pdf' | 'text'; tooBig: boolean } | undefined {
  const d = msg.document;
  if (!d) return undefined;
  const name = d.file_name ?? 'document';
  const mime = d.mime_type ?? '';
  const kind = mime === 'application/pdf' || /\.pdf$/i.test(name) ? 'pdf' : /^text\/plain/i.test(mime) || /\.txt$/i.test(name) ? 'text' : undefined;
  return kind ? { fileId: d.file_id, name, kind, tooBig: (d.file_size ?? 0) > MAX_DOC_BYTES } : undefined;
}

const MAX_VOICE_BYTES = 20_000_000;
const MAX_VOICE_SECONDS = 300;

/** Voice note or audio file the user sent. */
function pickVoice(msg: NonNullable<TgUpdate['message']>): { fileId: string; mime: string; seconds: number; tooBig: boolean } | undefined {
  const v = msg.voice ?? msg.audio ?? msg.video_note ?? msg.video;
  if (!v) return undefined;
  const isVideo = !!(msg.video_note ?? msg.video) && !msg.voice && !msg.audio;
  const mime = (v as { mime_type?: string }).mime_type || (isVideo ? 'video/mp4' : 'audio/ogg');
  return { fileId: v.file_id, mime, seconds: v.duration ?? 0, tooBig: (v.file_size ?? 0) > MAX_VOICE_BYTES };
}

const MAX_PHOTO_BYTES = 3_000_000; // keeps the base64 request well under the model's 4 MB limit
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Picks the biggest rendition that is still sensible to send to the model (<= 1600 px, <= 3 MB). */
function pickPhoto(msg: NonNullable<TgUpdate['message']>): string | undefined {
  if (msg.photo?.length) {
    const ok = msg.photo.filter((p) => p.width <= 1600 && p.height <= 1600 && (p.file_size ?? 0) <= MAX_PHOTO_BYTES);
    return (ok.length ? ok[ok.length - 1]! : msg.photo[0]!).file_id;
  }
  const d = msg.document;
  if (d && /^image\/(jpeg|png)$/i.test(d.mime_type ?? '') && (d.file_size ?? 0) <= MAX_PHOTO_BYTES) return d.file_id;
  return undefined;
}

export async function processTelegramUpdate(update: TgUpdate, deps: TelegramHandlerDeps): Promise<void> {
  if (update?.callback_query) return processCallback(update, deps);
  const msg = update?.message;
  if (!msg?.from || msg.from.is_bot || msg.chat.type !== 'private') return;
  try {
    const text = (msg.text ?? '').trim();
    const fromId = String(msg.from.id);
    // Pictures the assistant generates while answering are sent right after the text reply.
    const generated: string[] = [];
    const rctx: AgentContext = deps.getImage ? { channel: 'telegram', chatId: fromId, onImage: (pid) => void generated.push(pid) } : { channel: 'telegram', chatId: fromId };
    const sendImages = async () => {
      for (const pid of generated.splice(0)) {
        const img = await deps.getImage?.(pid).catch(() => undefined);
        if (img) await deps.sender.sendPhoto?.(msg.chat.id, img.data, img.mime).catch((e: Error) => logger.warn({ err: { message: e.message } }, 'Could not send the generated picture'));
      }
    };

    // Setup helper: lets the owner discover their numeric id. Reveals only the sender's own id.
    if (/^\/(myid|whoami)(@\w+)?$/i.test(text)) {
      await deps.sender.sendText(msg.chat.id, `Your Telegram user id is ${fromId}`);
      return;
    }

    // Owner-only: ignore everyone else silently (fail closed if owner unset).
    if (!deps.ownerId || fromId !== deps.ownerId) {
      logger.warn('Ignored Telegram message from non-owner');
      return;
    }

    const photoId = pickPhoto(msg);
    const docInfo = photoId ? undefined : pickDocument(msg);
    const voiceInfo = photoId || docInfo ? undefined : pickVoice(msg);
    const caption = (msg.caption ?? '').trim();

    // Duplicate prevention: Telegram retries; update_id makes this idempotent.
    const fresh = await deps.store.claimInbound(
      String(update.update_id),
      fromId,
      text || caption || (photoId ? '[photo]' : docInfo ? `[document: ${docInfo.name}]` : voiceInfo ? '[voice]' : ''),
      photoId ? 'photo' : docInfo ? 'document' : voiceInfo ? 'voice' : text ? 'text' : 'other',
    );
    if (!fresh) {
      logger.info({ id: update.update_id }, 'Duplicate Telegram update skipped');
      return;
    }

    // Photos: download, then let the agent look at it with the caption as the question.
    if (photoId) {
      let image: Buffer;
      try {
        if (!deps.sender.downloadFile) throw new Error('downloads not supported');
        image = await deps.sender.downloadFile(photoId);
      } catch (err) {
        logger.error({ err: { message: (err as Error).message } }, 'Telegram photo download failed');
        await deps.sender.sendText(msg.chat.id, 'Apologies, Sir. I could not download that photo. Please try sending it again.');
        return;
      }
      const mime = isJpeg(image) ? 'image/jpeg' : isPng(image) ? 'image/png' : undefined;
      if (!mime) {
        await deps.sender.sendText(msg.chat.id, 'Sir, I can read JPEG and PNG photos only.');
        return;
      }
      const reply = await deps.respond(caption, rctx, [{ mime, data: image }]);
      const sent = await deps.sender.sendText(msg.chat.id, reply);
      await sendImages();
      await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
      return;
    }

    // PDFs and text files: download, extract the text, and let the agent read it with the caption as the question.
    if (docInfo) {
      if (docInfo.tooBig) {
        await deps.sender.sendText(msg.chat.id, 'Sir, that file is over 10 MB. Please send a smaller one.');
        return;
      }
      let extracted;
      try {
        if (!deps.sender.downloadFile) throw new Error('downloads not supported');
        const file = await deps.sender.downloadFile(docInfo.fileId, MAX_DOC_BYTES);
        extracted = docInfo.kind === 'pdf' ? await extractPdfText(file) : extractPlainText(file);
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'Telegram document could not be read');
        await deps.sender.sendText(msg.chat.id, `Apologies, Sir. ${(err as Error).message}.`.replace('..', '.'));
        return;
      }
      if (!extracted.text.trim()) {
        await deps.sender.sendText(msg.chat.id, 'Sir, I found no text in that file. If it is a scan, please send photos of the pages instead.');
        return;
      }
      const body = extracted.truncated ? `${extracted.text}\n[... the rest of the document was cut off ...]` : extracted.text;
      const reply = await deps.respond(caption, rctx, undefined, [{ name: docInfo.name, text: body }]);
      const sent = await deps.sender.sendText(msg.chat.id, reply);
      await sendImages();
      await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
      return;
    }

    // Voice notes: download, transcribe, show what was heard, then answer exactly as if it had been typed.
    if (voiceInfo) {
      if (!deps.transcribe || !deps.sender.downloadFile) {
        await deps.sender.sendText(msg.chat.id, 'Sir, voice and video notes are not switched on yet. Please type your message for now.');
        return;
      }
      if (voiceInfo.tooBig || voiceInfo.seconds > MAX_VOICE_SECONDS) {
        await deps.sender.sendText(msg.chat.id, 'Sir, that recording is too long. Please keep it under 5 minutes.');
        return;
      }
      let said: string;
      try {
        const audio = await deps.sender.downloadFile(voiceInfo.fileId, MAX_VOICE_BYTES);
        said = (await deps.transcribe(audio, voiceInfo.mime)).trim();
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'Telegram voice note could not be transcribed');
        await deps.sender.sendText(msg.chat.id, 'Apologies, Sir. I could not understand that recording. Please try again or type it.');
        return;
      }
      if (!said) {
        await deps.sender.sendText(msg.chat.id, 'Sir, I could not hear any words in that recording.');
        return;
      }
      await deps.sender.sendText(msg.chat.id, `🎤 ${said}`);
      // Store the words as a normal text message so they become part of the conversation history.
      await deps.store.claimInbound(`voice-${update.update_id}`, fromId, said, 'text');
      const reply = await deps.respond(said, rctx);
      const sent = await deps.sender.sendText(msg.chat.id, reply);
      await sendImages();
      await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
      return;
    }

    if (!text) {
      await deps.sender.sendText(msg.chat.id, 'Sir, I can read text, photos, PDFs and text files, and I can listen to voice notes and video notes.');
      return;
    }
    if (text === '/start') {
      await deps.sender.sendText(msg.chat.id, 'Good day, Sir. MJ at your service. How may I help?');
      return;
    }

    // "Pdf ??", "send the newspaper": deliver today's MJ TIMES directly instead of asking the model.
    if (deps.sendNewspaper && text.length <= 60 && /\b(pdf|newspaper|mj times|e-?paper)\b/i.test(text)) {
      try {
        await deps.sender.sendText(msg.chat.id, 'One moment, Sir. Preparing today\'s MJ TIMES.');
        await deps.sendNewspaper(msg.chat.id);
      } catch (err) {
        logger.warn({ err: { message: (err as Error).message } }, 'On-demand MJ Times failed');
        await deps.sender.sendText(msg.chat.id, `Apologies, Sir. I could not produce the newspaper: ${(err as Error).message}.`.replace('..', '.'));
      }
      return;
    }

    const reply = await deps.respond(text, rctx);
    const sent = await deps.sender.sendText(msg.chat.id, reply);
      await sendImages();
    await deps.store.saveOutbound(`out-${sent.messageId}`, fromId, reply);
  } catch (err) {
    logger.error({ err: { message: (err as Error).message }, id: update.update_id }, 'Failed processing Telegram update');
  }
}
