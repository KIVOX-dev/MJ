import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import type { MessageStore } from '../src/core/memory/message.store';

const TOKEN = 'web-token-1234567890';

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
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

function setup() {
  const log: Array<{ direction: 'in' | 'out'; text: string }> = [];
  const store: MessageStore = {
    claimInbound: async (_i, _f, t) => (log.push({ direction: 'in', text: t }), true),
    saveOutbound: async (_i, _t, t) => void log.push({ direction: 'out', text: t }),
    recent: async () => log,
  };
  const respond = vi.fn().mockResolvedValue('I can see it, Sir.');
  const app = createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond, store, ownerChatId: '555' })] });
  const post = (body: unknown) => request(app).post('/api/chat').set('Authorization', `Bearer ${TOKEN}`).send(body as object);
  return { post, respond, log };
}

describe('web chat attachments', () => {
  it('sends a photo to the vision path with the question', async () => {
    const { post, respond, log } = setup();
    const res = await post({ query: 'What is this?', attachments: [{ name: 'pic.png', mime: 'image/png', data: b64(png()) }] });
    expect(res.status).toBe(200);
    const [text, ctx, images, docs] = respond.mock.calls[0]!;
    expect(text).toBe('What is this?');
    expect(ctx).toEqual({ channel: 'telegram', chatId: '555' });
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe('image/png');
    expect(Buffer.isBuffer(images[0].data)).toBe(true);
    expect(docs).toBeUndefined();
    expect(log[0]!.text).toContain('📎 photo pic.png');
  });

  it('reads a text file into the document path, and a file alone is enough', async () => {
    const { post, respond } = setup();
    const res = await post({ attachments: [{ name: 'notes.txt', mime: 'text/plain', data: b64('Meeting at 4 pm with Ravi.') }] });
    expect(res.status).toBe(200);
    const [text, , images, docs] = respond.mock.calls[0]!;
    expect(text).toMatch(/look at what I attached/i);
    expect(images).toBeUndefined();
    expect(docs).toEqual([{ name: 'notes.txt', text: 'Meeting at 4 pm with Ravi.' }]);
  });

  it('rejects things it cannot read, with a clear message and without calling the assistant', async () => {
    const { post, respond } = setup();
    const cases: Array<[object, RegExp]> = [
      [{ query: 'x', attachments: [{ name: 'a.zip', mime: 'application/zip', data: b64('PK...') }] }, /photos \(JPEG\/PNG\), PDFs and text files/],
      [{ query: 'x', attachments: [{ name: 'fake.png', mime: 'image/png', data: b64('not an image at all') }] }, /JPEG and PNG/],
      [{ query: 'x', attachments: [{ name: 'broken.pdf', mime: 'application/pdf', data: b64('not a pdf') }] }, /not a valid PDF/],
      [{ query: 'x', attachments: [{ name: 'empty.txt', mime: 'text/plain', data: b64('   ') }] }, /no text/],
    ];
    for (const [body, msg] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(msg);
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it('limits the number of files and still needs either words or a file', async () => {
    const { post, respond } = setup();
    const one = { name: 'n.txt', mime: 'text/plain', data: b64('hello there') };
    expect((await post({ query: 'x', attachments: [one, one, one, one, one] })).status).toBe(400);
    expect((await post({ query: '', attachments: [] })).status).toBe(400);
    expect((await post({ query: 'ok', attachments: [one, one, one, one] })).status).toBe(200);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});
