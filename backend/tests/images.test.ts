import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import { ToolRegistry } from '../src/core/tool-registry';
import {
  ImageBusy,
  ImageService,
  geminiProvider,
  huggingFaceProvider,
  pollinationsProvider,
  registerImageTools,
  type GeneratedImage,
  type ImageProvider,
  type ImageStore,
} from '../src/modules/creative/image.service';
import { processTelegramUpdate } from '../src/modules/communication-manager/telegram/telegram.handler';
import type { MessageStore } from '../src/core/memory/message.store';

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(52, 0x90))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();
const img = (): GeneratedImage => ({ data: PNG, mime: 'image/png' });

function memStore(): ImageStore & { saved: Array<{ img: GeneratedImage; prompt: string }> } {
  const saved: Array<{ img: GeneratedImage; prompt: string }> = [];
  return {
    saved,
    save: async (i, prompt) => (saved.push({ img: i, prompt }), `${'a'.repeat(31)}${saved.length}`),
    get: async (id) => (id.endsWith('1') ? img() : undefined),
  };
}
const provider = (name: string, fn: ImageProvider['generate']): ImageProvider => ({ name, generate: fn });

describe('providers', () => {
  it('Gemini: asks for an image in the right ratio and decodes the base64 picture', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { data: PNG.toString('base64') } }] } }] }) });
    const out = await geminiProvider('KEY', f as unknown as typeof fetch).generate('a cat', 'landscape');
    expect(out.mime).toBe('image/png');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain('gemini-2.5-flash-image');
    expect(init.headers['x-goog-api-key']).toBe('KEY');
    expect(JSON.parse(init.body).generationConfig.imageConfig.aspectRatio).toBe('16:9');
  });

  it('Hugging Face: sends the prompt and size and returns the bytes', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(PNG).buffer });
    const out = await huggingFaceProvider('TOKEN', f as unknown as typeof fetch).generate('a dog', 'portrait');
    expect(out.mime).toBe('image/png');
    expect(f.mock.calls[0]![1].headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(f.mock.calls[0]![1].body)).toMatchObject({ inputs: 'a dog', parameters: { width: 768, height: 1344 } });
  });

  it('Pollinations: reports its free-limit wait, and rejects non-pictures', async () => {
    const limited = vi.fn().mockResolvedValue({ ok: false, status: 402, text: async () => '{"error":{"message":"Free limit reached. Retry after 32s"}}' });
    await expect(pollinationsProvider(undefined, limited as unknown as typeof fetch).generate('x', 'square')).rejects.toMatchObject({ retryAfterSec: 32 });
    const junk = vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('<html>nope</html>').buffer });
    await expect(pollinationsProvider(undefined, junk as unknown as typeof fetch).generate('x', 'square')).rejects.toThrow(/did not return a picture/);
  });
});

describe('ImageService', () => {
  it('uses the best engine, falls back when it is busy, and saves what it gets', async () => {
    const store = memStore();
    const busy = vi.fn().mockRejectedValue(new ImageBusy('gemini'));
    const ok = vi.fn().mockResolvedValue(img());
    const svc = new ImageService([provider('gemini', busy), provider('pollinations', ok)], store);
    const out = await svc.generate('a red apple', 'square');
    expect(out.provider).toBe('pollinations');
    expect(store.saved[0]!.prompt).toBe('a red apple');
  });

  it('explains when everything is busy, and enforces the daily limit', async () => {
    const svc = new ImageService([provider('p', vi.fn().mockRejectedValue(new ImageBusy('p', 30)))], memStore());
    await expect(svc.generate('x')).rejects.toThrow(/try again in about 30 seconds/);
    const limited = new ImageService([provider('p', vi.fn().mockResolvedValue(img()))], memStore(), 1);
    await limited.generate('one');
    await expect(limited.generate('two')).rejects.toThrow(/daily limit/);
  });
});

describe('generate_image tool', () => {
  const ctx = (onImage?: (id: string) => void) => ({ channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date(), onImage });

  it('creates the picture and hands its id to the chat layer', async () => {
    const registry = new ToolRegistry();
    registerImageTools(registry, new ImageService([provider('p', vi.fn().mockResolvedValue(img()))], memStore()));
    const ids: string[] = [];
    const r = await registry.execute('generate_image', JSON.stringify({ prompt: 'a calm lake at dawn, watercolor', aspect: 'landscape' }), ctx((id) => ids.push(id)));
    expect(r.ok).toBe(true);
    expect(ids).toHaveLength(1);
    expect(JSON.stringify(r)).toMatch(/Do not write any link/);
  });

  it('says so on a chat that cannot show pictures, and validates the prompt', async () => {
    const registry = new ToolRegistry();
    registerImageTools(registry, new ImageService([provider('p', vi.fn().mockResolvedValue(img()))], memStore()));
    expect((await registry.execute('generate_image', JSON.stringify({ prompt: 'a calm lake' }), ctx())).ok).toBe(false);
    expect((await registry.execute('generate_image', JSON.stringify({ prompt: 'x' }), ctx(() => undefined))).ok).toBe(false);
  });
});

const TOKEN = 'web-token-1234567890';
const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] };

describe('pictures in the web app', () => {
  it('serves a picture by its unguessable id without a token, and 404s otherwise', async () => {
    const app = createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond: vi.fn(), store, ownerChatId: '1', getImage: async (id) => (id === 'a'.repeat(32) ? { data: PNG, mime: 'image/png' } : undefined) })] });
    const ok = await request(app).get(`/api/images/${'a'.repeat(32)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await request(app).get(`/api/images/${'b'.repeat(32)}`)).status).toBe(404);
    expect((await request(app).get('/api/images/not-hex')).status).toBe(404);
    expect((await request(app).get('/api/history')).status).toBe(401); // everything else still needs the token
  });

  it('appends generated pictures to the reply as markdown images', async () => {
    const respond = vi.fn(async (_t: string, c: { onImage?: (id: string) => void }) => (c.onImage?.('c'.repeat(32)), 'Here is your picture, Sir.'));
    const app = createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond: respond as never, store, ownerChatId: '1', getImage: async () => undefined })] });
    const res = await request(app).post('/api/chat').set('Authorization', `Bearer ${TOKEN}`).send({ query: 'draw a lake' });
    expect(res.body.reply).toBe(`Here is your picture, Sir.\n\n![Generated image](/api/images/${'c'.repeat(32)})`);
  });
});

describe('pictures in Telegram', () => {
  it('sends the generated picture right after the text reply', async () => {
    const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }), sendPhoto: vi.fn().mockResolvedValue({ messageId: 2 }) };
    const respond = vi.fn(async (_t: string, c: { onImage?: (id: string) => void }) => (c.onImage?.('d'.repeat(32)), 'Done, Sir.'));
    const msgStore: MessageStore = { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] };
    await processTelegramUpdate(
      { update_id: 1, message: { message_id: 1, from: { id: 555 }, chat: { id: 555, type: 'private' }, text: 'draw a lake' } },
      { ownerId: '555', store: msgStore, respond: respond as never, sender, getImage: async () => ({ data: PNG, mime: 'image/png' }) },
    );
    expect(sender.sendText).toHaveBeenCalledWith(555, 'Done, Sir.');
    expect(sender.sendPhoto).toHaveBeenCalledWith(555, PNG, 'image/png');
  });
});
