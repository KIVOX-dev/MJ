import path from 'node:path';
import PDFDocument from 'pdfkit';
import { logger } from '../../../utils/logger';
import { fetchImage as defaultFetchImage } from '../../../utils/image';
import type { DigestPayload, Story } from './digest.types';

export interface NewspaperDeps {
  /** Downloads an image (JPEG/PNG) or returns undefined. Injected in tests. */
  fetchImage?: (url: string) => Promise<Buffer | undefined>;
  /** Folder containing AnekTamil-{400,600,700,800}.woff (Anek Tamil, SIL OFL 1.1). */
  fontDir?: string;
}

const INK = '#141414';
const MUTED = '#6b6b6b';
const ACCENT = '#8b1a1a';
const RULE = '#b9b9b9';
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const W = PAGE_W - 2 * M;
const BOTTOM = PAGE_H - 58; // keep clear of the footer
const IMG_W = 150;
const IMG_H = 98;
const GAP = 14;
const MAX_STORIES_PER_SECTION = 3;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Renders "MJ TIMES", a one-or-two page newspaper-style PDF (A4) from the digest, with photos where the
 * sources provided them. Typeface: Anek Tamil (Latin glyphs). Never throws on a missing or bad image.
 */
export async function renderNewspaperPdf(payload: DigestPayload, deps: NewspaperDeps = {}): Promise<Buffer> {
  const fetchImg = deps.fetchImage ?? ((u: string) => defaultFetchImage(u));
  const fontDir = deps.fontDir ?? path.join(process.cwd(), 'assets', 'fonts');

  // 1) download photos (bounded concurrency, each failure just means "no photo")
  const wanted = payload.sections.flatMap((s) => s.stories.slice(0, MAX_STORIES_PER_SECTION)).filter((s) => s.imageUrl);
  const urls = [...new Set(wanted.map((s) => s.imageUrl!))];
  const images = new Map<string, Buffer>();
  await mapLimit(urls, 6, async (u) => {
    const b = await fetchImg(u).catch(() => undefined);
    if (b) images.set(u, b);
  });
  logger.info({ stories: payload.sections.reduce((n, x) => n + x.stories.length, 0), withPhotoUrl: wanted.length, downloaded: images.size }, 'MJ Times photos');
  const photo = (s: Story) => (s.imageUrl ? images.get(s.imageUrl) : undefined);

  // 2) pick the lead story: the first story (in section order) that has a photo
  let hero: { story: Story; label: string } | undefined;
  const sections = payload.sections.map((sec) => ({ ...sec, stories: sec.stories.slice(0, MAX_STORIES_PER_SECTION) }));
  outer: for (const sec of sections) {
    for (const st of sec.stories) {
      if (photo(st)) {
        hero = { story: st, label: sec.label };
        sec.stories = sec.stories.filter((x) => x !== st);
        break outer;
      }
    }
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: M, bottom: M, left: M, right: M },
    bufferPages: true,
    info: { Title: `MJ TIMES - ${payload.date}`, Author: 'MJ', Subject: 'Morning news briefing' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('r', path.join(fontDir, 'AnekTamil-400.woff'));
  doc.registerFont('sb', path.join(fontDir, 'AnekTamil-600.woff'));
  doc.registerFont('b', path.join(fontDir, 'AnekTamil-700.woff'));
  doc.registerFont('xb', path.join(fontDir, 'AnekTamil-800.woff'));

  // Anek Tamil's Latin set lacks a few symbols (rupee sign, non-breaking hyphen): substitute, and drop anything
  // the font cannot draw so no "missing glyph" boxes appear.
  doc.font('r');
  const fontkitFont = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } })._font?.font;
  const has = (cp: number) => fontkitFont?.hasGlyphForCodePoint?.(cp) ?? cp < 0x250;
  const clean = (s: string) =>
    Array.from(s.replace(/₹/g, 'Rs ').replace(/[‐‑]/g, '-').replace(/[  ]/g, ' '))
      .filter((ch) => ch === '\n' || (ch >= ' ' && has(ch.codePointAt(0)!)))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

  const rule = (y: number, w = 1, color = INK) => {
    doc.save().lineWidth(w).strokeColor(color).moveTo(M, y).lineTo(PAGE_W - M, y).stroke().restore();
  };
  const cover = (buf: Buffer, x: number, y: number, w: number, h: number) => {
    try {
      doc.save();
      doc.rect(x, y, w, h).clip();
      doc.image(buf, x, y, { cover: [w, h], align: 'center', valign: 'center' });
      doc.restore();
      return true;
    } catch {
      doc.restore();
      return false; // unsupported or corrupt image: skip it
    }
  };

  let y = 34;

  // ---- masthead ----
  rule(y, 3);
  y += 6;
  doc.font('xb').fontSize(62).fillColor(INK).text('MJ TIMES', M, y, { width: W, align: 'center', characterSpacing: 3, lineBreak: false });
  y += 72;
  rule(y, 0.8);
  doc.font('sb').fontSize(8).fillColor(MUTED);
  doc.text('MORNING EDITION', M, y + 6, { width: W / 3, align: 'left', characterSpacing: 1, lineBreak: false });
  doc.font('b').fillColor(INK).text(clean(payload.date).toUpperCase(), M, y + 6, { width: W, align: 'center', characterSpacing: 1, lineBreak: false });
  doc.font('sb').fillColor(MUTED).text('YOUR PERSONAL INTELLIGENCE ASSISTANT', M + (2 * W) / 3 - 40, y + 6, { width: W / 3 + 40, align: 'right', characterSpacing: 0.6, lineBreak: false });
  y += 22;
  rule(y, 1.6);
  y += 16;

  const ensure = (need: number) => {
    if (y + need > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };

  // ---- lead story ----
  if (hero) {
    const buf = photo(hero.story)!;
    const headline = clean(hero.story.summary) + '.';
    doc.font('b').fontSize(9).fillColor(ACCENT).text(hero.label, M, y, { width: W, characterSpacing: 1.4, lineBreak: false });
    y += 15;
    const imgH = 232;
    if (cover(buf, M, y, W, imgH)) y += imgH + 10;
    doc.font('xb').fontSize(19).fillColor(INK);
    const h = doc.heightOfString(headline, { width: W, lineGap: 2 });
    doc.text(headline, M, y, { width: W, lineGap: 2 });
    y += h + 4;
    if (hero.story.source) {
      doc.font('sb').fontSize(8.5).fillColor(MUTED).text(`PHOTO & REPORT: ${clean(hero.story.source).toUpperCase()}`, M, y, { width: W, characterSpacing: 0.8, lineBreak: false });
      y += 14;
    }
    y += 6;
  }

  // ---- sections ----
  for (const sec of sections) {
    if (!sec.stories.length) continue;
    ensure(28 + IMG_H + 20); // keep the header with its first story
    doc.save().rect(M, y, W, 20).fill(ACCENT).restore();
    doc.font('b').fontSize(10).fillColor('#ffffff').text(sec.label, M + 9, y + 5.5, { width: W - 18, characterSpacing: 1.3, lineBreak: false });
    y += 30;

    sec.stories.forEach((st, idx) => {
      const buf = photo(st);
      const textX = buf ? M + IMG_W + GAP : M;
      const textW = buf ? W - IMG_W - GAP : W;
      const body = clean(st.summary) + '.';
      doc.font('sb').fontSize(11.5);
      const textH = doc.heightOfString(body, { width: textW, lineGap: 2.5 });
      const rowH = Math.max(buf ? IMG_H : 0, textH + 18);
      ensure(rowH + 12);

      let drewImage = false;
      if (buf) drewImage = cover(buf, M, y, IMG_W, IMG_H);
      const tx = drewImage ? textX : M;
      const tw = drewImage ? textW : W;
      doc.font('sb').fontSize(11.5).fillColor(INK).text(body, tx, y, { width: tw, lineGap: 2.5 });
      if (st.source) {
        doc.font('r').fontSize(8).fillColor(MUTED).text(clean(st.source).toUpperCase(), tx, y + textH + 4, { width: tw, characterSpacing: 0.9, lineBreak: false });
      }
      y += rowH + 10;
      if (idx < sec.stories.length - 1) {
        rule(y - 4, 0.4, RULE);
        y += 6;
      }
    });
    y += 8;
  }

  // ---- footers ----
  const { start, count } = doc.bufferedPageRange();
  for (let i = 0; i < count; i++) {
    doc.switchToPage(start + i);
    doc.page.margins.bottom = 0; // otherwise writing near the page bottom would add a page
    rule(PAGE_H - 44, 0.6, RULE);
    doc.font('r').fontSize(7.5).fillColor(MUTED);
    doc.text('MJ TIMES  ·  Compiled by MJ for personal reading. Headlines and photographs belong to their publishers.', M, PAGE_H - 37, { width: W - 60, lineBreak: false });
    doc.text(`Page ${i + 1} of ${count}`, PAGE_W - M - 60, PAGE_H - 37, { width: 60, align: 'right', lineBreak: false });
  }

  doc.end();
  return finished;
}
