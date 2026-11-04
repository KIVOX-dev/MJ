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
const ACCENT = '#1f3a8a'; // blue (the paper uses only blue and black)
const RULE = '#b9b9b9';
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const W = PAGE_W - 2 * M;
const BOTTOM = PAGE_H - 58; // keep clear of the footer
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
  const rule2 = (x: number, yy: number, w: number, lw: number, color: string) => {
    doc.save().lineWidth(lw).strokeColor(color).moveTo(x, yy).lineTo(x + w, yy).stroke().restore();
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

  // Serif text uses the built-in Times (WinAnsi): keep only characters it can draw.
  const WIN = '‘’“”–—•…€™';
  const serif = (t: string) =>
    Array.from(t.replace(/₹/g, 'Rs ').replace(/[‐‑]/g, '-').replace(/[  ]/g, ' '))
      .filter((ch) => (ch >= ' ' && ch <= '~') || (ch >= '\u00a1' && ch <= '\u00ff') || WIN.includes(ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

  const HEAD = { font: 'Times-Bold', size: 13, gap: 1.5 };

  // ---- masthead ----
  const NAVY = '#1f3a8a';
  let y = 26;
  doc.font('xb').fontSize(78).fillColor(NAVY).text('MJ TIMES', M, y, { width: W, align: 'center', characterSpacing: 3, lineBreak: false });
  y += 84;
  doc.save().rect(M, y, W, 8).fill(INK).restore();
  y += 17;
  doc.font('xb').fontSize(11.5).fillColor(INK).text("YOUR MORNING NEWS BRIEFING  ·  TAMIL NADU  ·  INDIA  ·  WORLD  ·  CINEMA", M, y, { width: W, align: 'center', characterSpacing: 1.6, lineBreak: false });
  y += 18;
  doc.font('sb').fontSize(8).fillColor(INK).text(`${clean(payload.date).toUpperCase()} ·  MORNING EDITION ·  COMPILED BY MJ`, M, y, { width: W, align: 'center', characterSpacing: 0.9, lineBreak: false });
  y += 15;
  rule(y, 1.2);
  y += 12;

  const flat = sections.flatMap((sec) => sec.stories.map((story) => ({ story, label: sec.label })));
  const lead = hero ?? (flat.length ? { story: flat[0]!.story, label: flat[0]!.label } : undefined);
  const GUT = 16;
  const CW = (W - 2 * GUT) / 3;
  const colX = (i: number) => M + i * (CW + GUT);
  const LW = 2 * CW + GUT;
  const PHOTO_H = 92;
  const BODY = { font: 'Times-Roman', size: 9, gap: 1.4 };

  // ---- banner: the lead story as a full-width headline with a red sub-head bar ----
  if (lead) {
    if (!hero) sections.forEach((sec) => (sec.stories = sec.stories.filter((x) => x !== lead.story)));
    const head = clean(lead.story.summary).toUpperCase();
    let size = 44;
    doc.font('xb');
    while (size > 18) {
      doc.fontSize(size);
      if (doc.heightOfString(head, { width: W }) <= doc.currentLineHeight() * 2 + 1) break;
      size -= 1;
    }
    doc.fontSize(size).fillColor(INK);
    const hh = doc.heightOfString(head, { width: W, lineGap: 0 });
    doc.text(head, M, y, { width: W, align: 'center', lineGap: 0 });
    y += hh + 8;
    const sub = clean(lead.story.detail ?? '').replace(/^(.{20,95}?[.!?])\s.*$/, '$1');
    const subtitle = sub && sub.length <= 110 ? sub : lead.label;
    doc.save().rect(M, y, W, 24).fill(ACCENT).restore();
    doc.font('b').fontSize(12).fillColor('#ffffff').text(`•  ${subtitle}`, M + 10, y + 6, { width: W - 20, align: 'center', lineBreak: false });
    y += 36;

    // photo (two columns) beside the lead story's text (one column)
    const buf = hero ? photo(hero.story) : undefined;
    if (buf) {
      const imgH = 175;
      const ok = cover(buf, M, y, LW, imgH);
      const tx = colX(2);
      let ty = y;
      doc.font('b').fontSize(8).fillColor(ACCENT).text(lead.label, tx, ty, { width: CW, characterSpacing: 1.2, lineBreak: false });
      ty += 16;
      if (lead.story.detail) {
        doc.font(BODY.font).fontSize(10.5).fillColor(INK).text(serif(lead.story.detail), tx, ty, { width: CW, align: 'justify', lineGap: 1.8, height: imgH - 40, ellipsis: true });
      }
      if (lead.story.source) doc.font('Times-Italic').fontSize(9).fillColor(MUTED).text(`By ${serif(lead.story.source)}`, tx, y + imgH - 12, { width: CW, lineBreak: false });
      if (ok) y += imgH + 6;
      doc.font('Times-Italic').fontSize(7.5).fillColor(MUTED).text(`Photo: ${serif(lead.story.source ?? 'MJ TIMES')}`, M, y, { width: LW, align: 'right', lineBreak: false });
      y += 18;
    }
    rule(y - 4, 1.2);
    y += 8;
  }

  // ---- everything else: three-column grid, each item goes into the shortest column that has room ----
  interface Item {
    story: Story;
    label?: string;
    section: number;
  }
  const items: Item[] = sections.flatMap((sec, si) => sec.stories.map((story, k) => ({ story, label: k === 0 ? sec.label : undefined, section: si })));

  const columnTop = (page1: boolean): number[] => (page1 ? [y, y, y] : [M, M, M]);
  let cols = columnTop(true);
  let ruleTop = [y, y]; // where the vertical rules start on this page
  const lastCol = new Map<number, number>();

  const measure = (it: Item) => {
    const buf = photo(it.story);
    const first = !!it.label;
    const hs = first ? 16 : 13;
    doc.font(HEAD.font).fontSize(hs);
    const text = serif(it.story.summary) + '.';
    const th = doc.heightOfString(text, { width: CW, lineGap: HEAD.gap, align: 'center' });
    const body = it.story.detail ? serif(it.story.detail) : '';
    doc.font(BODY.font).fontSize(BODY.size);
    const bh = body ? Math.min(doc.heightOfString(body, { width: CW, lineGap: BODY.gap, align: 'justify' }), 9 * 11.4 * 1) : 0;
    const label = first ? 24 : 0;
    return { buf, text, hs, th, body, bh, h: label + th + 6 + (buf ? PHOTO_H + 7 : 0) + (bh ? bh + 6 : 0) + (it.story.source ? 14 : 2) + 12 };
  };

  const verticals = () => {
    const bottom = Math.max(...cols) - 8;
    for (let i = 0; i < 2; i++) {
      const top = ruleTop[i]!;
      if (bottom > top) doc.save().lineWidth(0.4).strokeColor(RULE).moveTo(colX(i) + CW + GUT / 2, top).lineTo(colX(i) + CW + GUT / 2, bottom).stroke().restore();
    }
  };

  const queue = [...items];
  while (queue.length) {
    const fitsAt = (m: ReturnType<typeof measure>, c: number) => cols[c]! + m.h <= BOTTOM;
    let pick = 0;
    let m = measure(queue[0]!);
    if (![0, 1, 2].some((c) => fitsAt(m, c))) {
      // the next story is too tall for what is left of this page: use a later, shorter one to fill the gap
      const k = queue.slice(1, 8).findIndex((q) => [0, 1, 2].some((c) => fitsAt(measure(q), c)));
      if (k >= 0) {
        pick = k + 1;
        m = measure(queue[pick]!);
      }
    }
    const it = queue.splice(pick, 1)[0]!;
    const fits = (c: number) => fitsAt(m, c);
    const prev = lastCol.get(it.section);
    let c = prev !== undefined && !it.label && fits(prev) ? prev : -1;
    if (c < 0) {
      const open = [0, 1, 2].filter(fits);
      if (!open.length) {
        verticals();
        doc.addPage();
        cols = columnTop(false);
        ruleTop = [M, M];
        c = 0;
      } else c = open.reduce((a, b) => (cols[b]! < cols[a]! ? b : a));
    }
    lastCol.set(it.section, c);

    const x = colX(c);
    let cy = cols[c]!;
    if (it.label) {
      rule2(x, cy, CW, 1.4, INK);
      doc.font('b').fontSize(7.5).fillColor(ACCENT).text(it.label, x, cy + 5, { width: CW, characterSpacing: 1.1, lineBreak: false });
      rule2(x, cy + 17, CW, 0.4, RULE);
      cy += 24;
    } else {
      rule2(x, cy - 5, CW, 0.4, RULE);
    }
    doc.font(HEAD.font).fontSize(m.hs).fillColor(INK).text(m.text, x, cy, { width: CW, lineGap: HEAD.gap, align: 'center' });
    cy += m.th + 6;
    if (m.buf && cover(m.buf, x, cy, CW, PHOTO_H)) cy += PHOTO_H + 7;
    if (m.body) {
      doc.font(BODY.font).fontSize(BODY.size).fillColor('#222222').text(m.body, x, cy, { width: CW, lineGap: BODY.gap, align: 'justify', height: m.bh, ellipsis: true });
      cy += m.bh + 6;
    }
    if (it.story.source) {
      doc.font('Times-Italic').fontSize(8.5).fillColor(MUTED).text(`By ${serif(it.story.source)}`, x, cy, { width: CW, lineBreak: false });
      cy += 12;
    }
    cols[c] = cy + 12;
  }
  verticals();

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
