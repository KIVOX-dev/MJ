import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { Agent, PHOTO_FAILURE_REPLY, PHOTO_LIMIT_REPLY } from '../src/core/orchestrator/assistant';
import { ToolRegistry } from '../src/core/tool-registry';
import { GroqService, type ChatClient } from '../src/core/ai-engine/groq.service';
import { processTelegramUpdate, type TgUpdate } from '../src/modules/communication-manager/telegram/telegram.handler';
import { TelegramBotClient } from '../src/modules/communication-manager/telegram/telegram.client';
import type { MessageStore } from '../src/core/memory/message.store';

function png(w = 8, h = 8): Buffer {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h, 0x70);
  for (let y = 0; y < h; y++) raw[y * stride] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);

const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] };
const photoUpdate = (over: Partial<NonNullable<TgUpdate['message']>> = {}, fromId = 7): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 1, from: { id: fromId }, chat: { id: fromId, type: 'private' },
    photo: [{ file_id: 'small', width: 90, height: 60, file_size: 2000 }, { file_id: 'medium', width: 800, height: 600, file_size: 90_000 }, { file_id: 'huge', width: 4000, height: 3000, file_size: 6_000_000 }],
    caption: 'What is this?', ...over,
  },
});
function deps(image: Buffer | Error = JPEG) {
  const sender = {
    sendText: vi.fn().mockResolvedValue({ messageId: 5 }),
    downloadFile: vi.fn(async () => { if (image instanceof Error) throw image; return image; }),
  };
  const respond = vi.fn().mockResolvedValue('Sir, I see a laptop.');
  return { sender, respond, d: { ownerId: '7', store, respond, sender } };
}

describe('Telegram photo handling', () => {
  it('downloads a suitable size (not the huge one) and asks the agent with the caption', async () => {
    const { sender, respond, d } = deps();
    await processTelegramUpdate(photoUpdate(), d);
    expect(sender.downloadFile).toHaveBeenCalledWith('medium');
    expect(respond).toHaveBeenCalledWith('What is this?', { channel: 'telegram', chatId: '7' }, [{ mime: 'image/jpeg', data: JPEG }]);
    expect(sender.sendText).toHaveBeenCalledWith(7, 'Sir, I see a laptop.');
  });

  it('works for PNG photos sent as a file (document) and for photos without a caption', async () => {
    const p = png();
    const { respond, sender, d } = deps(p);
    await processTelegramUpdate(photoUpdate({ photo: undefined, caption: undefined, document: { file_id: 'doc1', mime_type: 'image/png', file_size: 1000 } }), d);
    expect(sender.downloadFile).toHaveBeenCalledWith('doc1');
    expect(respond).toHaveBeenCalledWith('', expect.anything(), [{ mime: 'image/png', data: p }]);
  });

  it('ignores photos from anyone but the owner (no download, no reply)', async () => {
    const { sender, respond, d } = deps();
    await processTelegramUpdate(photoUpdate({}, 999), d);
    expect(sender.downloadFile).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('is polite when the download fails or the file is not JPEG/PNG', async () => {
    const failed = deps(new Error('boom'));
    await processTelegramUpdate(photoUpdate(), failed.d);
    expect(failed.sender.sendText).toHaveBeenCalledWith(7, expect.stringContaining('could not download'));
    expect(failed.respond).not.toHaveBeenCalled();
    const gif = deps(Buffer.from('GIF89a......'));
    await processTelegramUpdate(photoUpdate(), gif.d);
    expect(gif.sender.sendText).toHaveBeenCalledWith(7, expect.stringContaining('JPEG and PNG'));
    expect(gif.respond).not.toHaveBeenCalled();
  });

  it('does not treat an unsupported file type as a photo or document', async () => {
    const { sender, respond, d } = deps();
    await processTelegramUpdate(photoUpdate({ photo: undefined, caption: undefined, document: { file_id: 'zip', mime_type: 'application/zip', file_name: 'a.zip', file_size: 10 } }), d);
    expect(sender.downloadFile).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalledWith(7, expect.stringContaining('PDFs and text files'));
  });
});

describe('Agent with photos', () => {
  const mk = (chat: unknown, visionModels = ['vision-model']) =>
    new Agent({ ai: { chat } as never, registry: new ToolRegistry(), timezone: 'Asia/Kolkata', store, visionModels });

  it('sends the photo as a multimodal message to the vision model only, with the no-face-identification rule', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'It is a laptop.', toolCalls: [] });
    const out = await mk(chat).reply('What is this?', { channel: 'telegram', chatId: '7' }, [{ mime: 'image/png', data: png() }]);
    expect(out).toBe('Sir, it is a laptop.');
    const [messages, opts] = chat.mock.calls[0]!;
    expect(opts.models).toEqual(['vision-model']);
    const user = messages.at(-1);
    expect(user.content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(user.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(messages[0].content).toContain('Do NOT identify real people');
  });

  it('uses a default question when there is no caption, and the normal models for plain text', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'Fine.', toolCalls: [] });
    const agent = mk(chat);
    await agent.reply('', { channel: 'telegram', chatId: '7' }, [{ mime: 'image/jpeg', data: JPEG }]);
    expect(chat.mock.calls[0]![0].at(-1).content[0].text).toContain('without a caption');
    await agent.reply('hello', { channel: 'telegram', chatId: '7' });
    expect(chat.mock.calls[1]![1].models).toBeUndefined();
  });

  it('explains clearly when the vision rate limit is hit or reading fails', async () => {
    const img = [{ mime: 'image/jpeg' as const, data: JPEG }];
    const limited = mk(vi.fn().mockRejectedValue(new Error('All Groq keys/models failed (last status: 429)')));
    expect(await limited.reply('x', { channel: 'telegram', chatId: '7' }, img)).toBe(PHOTO_LIMIT_REPLY);
    const broken = mk(vi.fn().mockRejectedValue(new Error('boom')));
    expect(await broken.reply('x', { channel: 'telegram', chatId: '7' }, img)).toBe(PHOTO_FAILURE_REPLY);
  });
});

describe('GroqService model override', () => {
  it('uses the vision model chain instead of the text chain when asked', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const svc = new GroqService([{ chat: { completions: { create } } } as ChatClient], ['text-model']);
    await svc.chat([{ role: 'user', content: 'hi' }], { models: ['vision-model'] });
    await svc.chat([{ role: 'user', content: 'hi' }]);
    expect(create.mock.calls[0]![0].model).toBe('vision-model');
    expect(create.mock.calls[1]![0].model).toBe('text-model');
  });
});

describe('TelegramBotClient.downloadFile', () => {
  it('resolves the path, downloads, and never leaks the token in errors', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 10 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(JPEG).buffer });
    const buf = await new TelegramBotClient('SECRETTOKEN', f as unknown as typeof fetch).downloadFile('fid');
    expect(buf.equals(JPEG)).toBe(true);
    expect(f.mock.calls[1]![0]).toBe('https://api.telegram.org/file/botSECRETTOKEN/photos/a.jpg');

    const bad = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/a.jpg' } }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    const err = await new TelegramBotClient('SECRETTOKEN', bad as unknown as typeof fetch).downloadFile('fid').then(() => new Error('no'), (e: Error) => e);
    expect(err.message).toMatch(/404/);
    expect(err.message).not.toContain('SECRETTOKEN');
  });
});
