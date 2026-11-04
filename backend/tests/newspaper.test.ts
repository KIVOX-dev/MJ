import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { renderNewspaperPdf } from '../src/modules/personal-secretary/briefing/newspaper';
import type { DigestPayload } from '../src/modules/personal-secretary/briefing/digest.types';
import { NewsDigestService, parseBody, SECTION_TITLES } from '../src/modules/personal-secretary/briefing/news-digest.service';
import { fetchImage, isPublicHttpUrl } from '../src/utils/image';
import { mergeArticles, parseRss } from '../src/modules/research-assistant/web-search/rss';
import type { Article } from '../src/modules/research-assistant/web-search/newsdata.client';
import { Agent, addressSir, toPlainChat } from '../src/core/orchestrator/assistant';
import { ToolRegistry } from '../src/core/tool-registry';
import { TelegramBotClient } from '../src/modules/communication-manager/telegram/telegram.client';
import type { JobRunRepo } from '../src/jobs/job-run.repo';

/** Builds a small valid PNG in memory (no binary fixtures needed). */
function png(w = 16, h = 10): Buffer {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h, 0x90);
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

const payload = (withImages: boolean, extraText = ''): DigestPayload => ({
  date: 'Wednesday, 4 November 2026',
  text: 'x',
  sections: [
    {
      title: 'Tamil Nadu - Politics', label: 'TAMIL NADU · POLITICS', header: 'h',
      stories: [
        { summary: `Court orders state to explain appointments ${extraText}`, source: 'The Hindu', imageUrl: withImages ? 'https://img.test/a.png' : undefined },
        { summary: 'Second story with a photo', source: 'BBC News', imageUrl: withImages ? 'https://img.test/b.png' : undefined },
      ],
    },
    { title: 'Kollywood', label: 'KOLLYWOOD', header: 'h', stories: [{ summary: 'Film release policy announced', source: 'DT Next' }] },
  ],
});

describe('renderNewspaperPdf', () => {
  it('renders a valid PDF in Anek Tamil with photos', async () => {
    const fetchImage = vi.fn().mockResolvedValue(png());
    const pdf = await renderNewspaperPdf(payload(true), { fetchImage });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
    expect(pdf.includes('AnekTamil')).toBe(true);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('still renders when images are missing, fail to download, or throw', async () => {
    for (const f of [async () => undefined, async () => { throw new Error('timeout'); }]) {
      const pdf = await renderNewspaperPdf(payload(true), { fetchImage: f });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await renderNewspaperPdf(payload(false), { fetchImage: async () => png() })).length).toBeGreaterThan(5000);
  });

  it('survives corrupt image bytes and characters the font cannot draw (rupee sign, Tamil, emoji)', async () => {
    const corrupt = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('not really a png')]);
    const pdf = await renderNewspaperPdf(payload(true, 'costs ₹500 crore தமிழ்நாடு 🎬'), { fetchImage: async () => corrupt });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('image safety (fetchImage / isPublicHttpUrl)', () => {
  it('only allows public http(s) URLs', () => {
    expect(isPublicHttpUrl('https://img.thehindu.com/a.jpg')).toBe(true);
    for (const u of ['http://localhost/a.jpg', 'http://127.0.0.1/a', 'http://10.0.0.5/a', 'http://192.168.1.1/a', 'http://169.254.169.254/latest/meta-data', 'http://172.20.0.1/a', 'ftp://x.test/a', 'file:///etc/passwd', 'http://[::1]/a', 'not a url'])
      expect(isPublicHttpUrl(u), u).toBe(false);
  });
  const ok = (body: Buffer, headers: Record<string, string> = {}) =>
    vi.fn().mockResolvedValue({ ok: true, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
  it('accepts PNG/JPEG, rejects webp, oversize and private hosts without fetching them', async () => {
    expect(await fetchImage('https://x.test/a.png', ok(png()) as unknown as typeof fetch)).toBeInstanceOf(Buffer);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(await fetchImage('https://x.test/a.jpg', ok(jpeg) as unknown as typeof fetch)).toBeInstanceOf(Buffer);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    expect(await fetchImage('https://x.test/a.webp', ok(webp) as unknown as typeof fetch)).toBeUndefined();
    expect(await fetchImage('https://x.test/big.png', ok(png(), { 'content-length': '5000000' }) as unknown as typeof fetch)).toBeUndefined();
    const spy = ok(png());
    expect(await fetchImage('http://169.254.169.254/x.png', spy as unknown as typeof fetch)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
  it('tries a larger BBC rendition first and falls back to the original', async () => {
    const f = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(png()).buffer });
    expect(await fetchImage('https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/x.jpg', f as unknown as typeof fetch)).toBeInstanceOf(Buffer);
    expect(f.mock.calls[0]![0]).toContain('/standard/800/');
    expect(f.mock.calls[1]![0]).toContain('/standard/240/');
  });
});

describe('RSS images and merging', () => {
  it('finds images in media:content, media:thumbnail, enclosure and description <img>', () => {
    const xml = `<rss><channel>
      <item><title>A</title><link>https://a</link><media:content url="https://i.test/a.jpg" medium="image" /></item>
      <item><title>B</title><link>https://b</link><media:thumbnail url="https://i.test/b.jpg" /></item>
      <item><title>C</title><link>https://c</link><enclosure url="https://i.test/c.png" type="image/png" length="1" /></item>
      <item><title>D</title><link>https://d</link><description><![CDATA[<p><img src="https://i.test/d.jpg"/>text</p>]]></description></item>
      <item><title>E</title><link>https://e</link><media:content url="https://i.test/v.mp4" medium="video" /></item>
    </channel></rss>`;
    expect(parseRss(xml).map((a) => a.imageUrl)).toEqual(['https://i.test/a.jpg', 'https://i.test/b.jpg', 'https://i.test/c.png', 'https://i.test/d.jpg', undefined]);
  });
  it('keeps an image from a duplicate even when the fresher copy has none', () => {
    const a: Article = { title: 'Same story', source: 's1', link: 'l1', pubDate: '2026-11-04T01:00:00Z', imageUrl: 'https://i.test/x.jpg' };
    const b: Article = { title: 'same story!', source: 's2', link: 'l2', pubDate: '2026-11-04T02:00:00Z' };
    const [m] = mergeArticles([[a], [b]], 5);
    expect(m!.source).toBe('s2');
    expect(m!.imageUrl).toBe('https://i.test/x.jpg');
  });
});

describe('parseBody maps bullets to articles (for photos)', () => {
  it('uses the [n] marker to attach the right photo and source', () => {
    const arts = new Map([['tamil nadu - politics', [
      { title: 'One', source: 'S1', link: 'l', pubDate: '', imageUrl: 'https://i.test/1.jpg' },
      { title: 'Two', source: 'S2', link: 'l', pubDate: '', imageUrl: 'https://i.test/2.jpg' },
    ]]]);
    const s = parseBody('## Tamil Nadu - Politics\n• [2] Second article summary. (The Hindu)\n• [1] First one', arts)[0]!;
    expect(s.stories[0]).toEqual({ summary: 'Second article summary', source: 'The Hindu', imageUrl: 'https://i.test/2.jpg' });
    expect(s.stories[1]).toEqual({ summary: 'First one', source: 'S1', imageUrl: 'https://i.test/1.jpg' });
    expect(SECTION_TITLES).toContain('Kollywood');
  });
});

describe('digest delivers the MJ Times PDF after the text', () => {
  function setup(makePdf?: () => Promise<Buffer>) {
    const clock = { t: new Date('2026-11-04T08:00:00+05:30') };
    const rows = new Map<string, any>();
    const repo: JobRunRepo = {
      ensure: async (r, now) => void (rows.has(r.key) || rows.set(r.key, { ...r, status: 'new', attempts: 0, runAfter: now })),
      claim: async (k) => { const r = rows.get(k); if (!r || r.status !== 'new') return null; r.status = 'running'; r.attempts++; return { key: k, kind: r.kind, channel: r.channel, chatId: r.chatId, attempts: r.attempts }; },
      markSent: async (k) => void (rows.get(k).status = 'sent'),
      markFailed: async (k) => void (rows.get(k).status = 'failed'),
      savePayload: async (k, p) => void (rows.get(k).payload = p),
      getPayload: async (k) => rows.get(k)?.payload ?? null,
    };
    const order: string[] = [];
    const notify = vi.fn(async (_c: string, _i: string, _t: string) => void order.push('text'));
    const sendFile = vi.fn(async (_c: string, _i: string, _f: { name: string; caption?: string }) => void order.push('pdf'));
    const svc = new NewsDigestService({
      repo, ai: { complete: async () => '## Tamil Nadu - Politics\n• [1] Court acts (The Hindu)' },
      news: { search: async () => [{ title: 'Court acts', source: 'The Hindu', link: 'l', pubDate: clock.t.toISOString(), imageUrl: 'https://i.test/1.png' }] },
      notify, recipients: [{ channel: 'telegram', chatId: '7' }], timezone: 'Asia/Kolkata', prepareTime: '05:00', sendTime: '08:00',
      makePdf: makePdf ?? (async () => Buffer.from('%PDF-fake')), sendFile, now: () => clock.t,
    });
    return { svc, notify, sendFile, order, rows };
  }

  it('sends the text first, then the PDF named by date, once', async () => {
    const { svc, order, sendFile } = setup();
    await svc.runDue();
    await svc.runDue();
    expect(order).toEqual(['text', 'pdf']);
    expect(sendFile.mock.calls[0]![2]).toMatchObject({ name: 'MJ-Times-2026-11-04.pdf', caption: expect.stringContaining('MJ TIMES') });
  });

  it('a PDF failure never blocks or repeats the text digest', async () => {
    const { svc, notify, rows } = setup(async () => { throw new Error('render failed'); });
    expect((await svc.runDue()).sent).toBe(1);
    await svc.runDue();
    expect(notify).toHaveBeenCalledTimes(1);
    expect([...rows.values()].find((r) => r.kind === 'news-digest').status).toBe('sent');
  });

  it('keeps the photo URLs in the stored payload so the 08:00 PDF can use them', async () => {
    const { svc, rows } = setup();
    await svc.runDue();
    const prep = [...rows.values()].find((r) => r.kind === 'news-digest-prep');
    const stored = JSON.parse(prep.payload);
    expect(stored.sections[0].stories[0].imageUrl).toBe('https://i.test/1.png');
  });
});

describe('plain chat replies and automation awareness', () => {
  it('strips markdown the model adds', () => {
    expect(toPlainChat('Here:\n\n- **Women-led startups** – text\n- `code` item\n## Heading')).toBe('Here:\n\n• Women-led startups – text\n\n• code item\nHeading');
  });
  it('tells the model about automatic features and returns plain text', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '**You will get alerts automatically.**', toolCalls: [] });
    const agent = new Agent({
      ai: { chat }, registry: new ToolRegistry(), timezone: 'Asia/Kolkata',
      store: { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] },
      extraInstructions: 'AUTOMATIC FEATURES: Tamil Nadu alerts every 10 minutes.',
    });
    const out = await agent.reply('When will I get breaking news?', { channel: 'telegram', chatId: '1' });
    expect(out).toBe('Sir, you will get alerts automatically.');
    expect(chat.mock.calls[0]![0][0].content).toContain('AUTOMATIC FEATURES: Tamil Nadu alerts every 10 minutes.');
  });
});

describe('addressSir', () => {
  it('adds "Sir" when missing, keeps proper nouns capitalised, leaves replies that already have it', () => {
    expect(addressSir('Here are the latest headlines:\n\n• One')).toBe('Sir, here are the latest headlines:\n\n• One');
    expect(addressSir('Tamil Nadu has issued a cyclone warning.')).toBe('Sir, Tamil Nadu has issued a cyclone warning.');
    expect(addressSir('I could not find that.')).toBe('Sir, I could not find that.');
    expect(addressSir('Certainly, Sir. Done.')).toBe('Certainly, Sir. Done.');
    expect(addressSir('Hello Sir!')).toBe('Hello Sir!');
  });
  it('is applied to every final agent reply', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'Here are the latest headlines:\n- One\n- Two', toolCalls: [] });
    const agent = new Agent({ ai: { chat }, registry: new ToolRegistry(), timezone: 'Asia/Kolkata', store: { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] } });
    expect(await agent.reply('news', { channel: 'telegram', chatId: '1' })).toBe('Sir, here are the latest headlines:\n\n• One\n\n• Two');
  });
});

describe('TelegramBotClient.sendDocument', () => {
  it('uploads multipart form data and verifies the response', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) });
    const out = await new TelegramBotClient('TOKEN123', f as unknown as typeof fetch).sendDocument(7, Buffer.from('%PDF-x'), 'MJ-Times.pdf', 'MJ TIMES');
    expect(out.messageId).toBe(9);
    const init = f.mock.calls[0]![1];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('chat_id')).toBe('7');
    expect(((init.body as FormData).get('document') as File).name).toBe('MJ-Times.pdf');
    expect(init.headers).toBeUndefined(); // fetch must set the multipart boundary itself
  });
});
