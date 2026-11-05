import { logger } from '../../../utils/logger';
import type { Completer } from '../../../core/orchestrator/assistant';
import type { Channel } from '../../../core/memory/message.store';
import { MAX_JOB_ATTEMPTS, type JobRunRepo } from '../../../jobs/job-run.repo';
import { localClock, zonedToUtc } from '../../../utils/time';
import { splitMessage } from '../../../utils/text';
import { regionQuery, type Article, type NewsQuery, type NewsSource } from '../../research-assistant/web-search/newsdata.client';
import { mergeArticles } from '../../research-assistant/web-search/rss';
import type { DigestPayload, DigestSection, Story } from './digest.types';

export interface DigestRecipient {
  channel: Channel;
  chatId: string;
}

export interface SectionFeed {
  fetch(): Promise<Article[]>;
}

export interface DigestFile {
  name: string;
  data: Buffer;
  caption?: string;
}

export interface DigestDeps {
  repo: JobRunRepo;
  news: NewsSource;
  ai: Completer;
  notify: (channel: Channel, chatId: string, text: string) => Promise<void>;
  recipients: DigestRecipient[];
  timezone: string;
  /** "HH:mm" local time to start preparing (fetch + summarise), e.g. "05:00". */
  prepareTime: string;
  /** "HH:mm" local time to deliver, e.g. "08:00". */
  sendTime: string;
  /** If the instance was asleep at send time, still send late, but only within this many hours. */
  catchUpHours?: number;
  /** Real-time publisher feeds (with photos) merged into each section, keyed by section title. */
  feeds?: Record<string, SectionFeed[]>;
  /** Renders the "MJ TIMES" PDF; optional. A failure here never blocks the text digest. */
  makePdf?: (payload: DigestPayload) => Promise<Buffer>;
  /** Delivers the PDF on a channel that supports files; channels without it just get the text. */
  sendFile?: (channel: Channel, chatId: string, file: DigestFile) => Promise<void>;
  /**
   * Extra morning deliveries besides the Telegram message: for example a phone notification and an email with the PDF attached.
   * Each one is attempted once per day (and retried a few times if it fails) without ever re-sending the others.
   */
  extras?: Array<{ name: string; deliver: (digest: DigestPayload, pdf: () => Promise<DigestFile | undefined>) => Promise<void> }>;
  now?: () => Date;
}

const ENT = { language: 'en', size: 8 } as const;

const SECTIONS: Array<{ title: string; emoji: string; label: string; query: NewsQuery }> = [
  { title: 'Tamil Nadu - Politics', emoji: '🏛', label: 'TAMIL NADU · POLITICS', query: regionQuery('tamil_nadu', 'politics') },
  { title: 'Tamil Nadu - Sports', emoji: '🏅', label: 'TAMIL NADU · SPORTS', query: regionQuery('tamil_nadu', 'sports') },
  { title: 'India - Politics', emoji: '🇮🇳', label: 'INDIA · POLITICS', query: regionQuery('india', 'politics') },
  { title: 'India - Sports', emoji: '🏏', label: 'INDIA · SPORTS', query: regionQuery('india', 'sports') },
  { title: 'World - Politics', emoji: '🌍', label: 'WORLD · POLITICS', query: regionQuery('world', 'politics') },
  { title: 'World - Sports', emoji: '⚽', label: 'WORLD · SPORTS', query: regionQuery('world', 'sports') },
  {
    title: 'Kollywood',
    emoji: '🎬',
    label: 'KOLLYWOOD',
    query: { ...ENT, country: 'in', category: 'entertainment', q: 'Kollywood OR "Tamil cinema" OR "Tamil film" OR "Tamil movie"' },
  },
  { title: 'Hollywood', emoji: '🎥', label: 'HOLLYWOOD', query: { ...ENT, category: 'entertainment', q: 'Hollywood' } },
  {
    title: 'Box Office and Trending Movies',
    emoji: '💰',
    label: 'BOX OFFICE & TRENDING MOVIES',
    query: { ...ENT, q: '"box office" OR "box office collection"' },
  },
  {
    title: 'Reviews and Public Response',
    emoji: '⭐',
    label: 'REVIEWS & PUBLIC RESPONSE',
    query: { ...ENT, q: '"movie review" OR "audience response" OR "public review" OR "first day first show"' },
  },
];

export const SECTION_TITLES = SECTIONS.map((s) => s.title);

const SUMMARY_PROMPT =
  'You write the morning news briefing for "Sir", a busy professional in Tamil Nadu, India. ' +
  'Use ONLY the articles provided. Do not add facts, names, numbers or background that are not in them. ' +
  'Some articles may be in Tamil or off-topic: use Tamil ones (write in English) and silently skip any article ' +
  'that is not clearly about its section. Output format, exactly: for each section a line "## <section title exactly ' +
  'as given>" followed by 2 or 3 bullet lines. Each bullet starts with "• " then the article number in square ' +
  'brackets, e.g. "• [3] ...", then ONE short sentence of at most 140 characters, then the source name in brackets, ' +
  'e.g. (The Hindu). Use the number of the article the bullet is based on. When several articles are equally relevant, ' +
  'prefer ones marked [photo]. If a section has no usable article write nothing: omit that section completely ' +
  '(do not write a heading or any "no updates" line). For "Box Office and Trending Movies" give film names and ' +
  'collection figures ONLY when the articles state them; for "Reviews and Public Response" report only critic or ' +
  'audience reactions that the articles state. No links, no markdown, no asterisks, no intro or closing text.';

/** Visual separator between sections (also the point where long digests are split across messages). */
const DIVIDER = '──────────────';
const isFiller = (b: string) => /^no (fresh |usable |new |major )?(updates?|news|articles?)\b/i.test(b);

/** Feed description cleaned for print: no HTML, no repeat of the headline, at most ~260 chars ending on a word. */
function articleDetail(desc: string | undefined, headline: string): string | undefined {
  const t = (desc ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 50) return undefined;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm(t).startsWith(norm(headline).slice(0, 40)) && t.length < headline.length + 40) return undefined;
  if (t.length <= 260) return t;
  const cut = t.slice(0, 260);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 200)).replace(/[,;:\s]+$/, '') + '...';
}

/** Parses the model's "## title" + "• [n] sentence (Source)" output into structured sections. */
export function parseBody(body: string, articles: Map<string, Article[]> = new Map()): DigestSection[] {
  const bySection = new Map<string, Story[]>();
  let current: string | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const h = /^#{1,3}\s*(.+)$/.exec(line);
    if (h) {
      current = h[1]!.replace(/\*+/g, '').trim().toLowerCase();
      bySection.set(current, []);
      continue;
    }
    const m = /^[•\-*]\s*(?:\[(\d+)\]\s*)?(.+)$/.exec(line);
    if (!current || !m) continue;
    const text = m[2]!.replace(/\*+/g, '').trim();
    if (!text || isFiller(text)) continue;
    const sm = /\s*\(([^()]{2,50})\)\s*\.?\s*$/.exec(text);
    const summary = (sm ? text.slice(0, sm.index) : text).replace(/[.\s]+$/, '').trim();
    if (!summary) continue;
    const article = m[1] ? articles.get(current)?.[Number(m[1]) - 1] : undefined;
    bySection.get(current)!.push({ summary, source: sm?.[1]?.trim() ?? article?.source, imageUrl: article?.imageUrl, detail: articleDetail(article?.description, summary) });
  }
  return SECTIONS.map((s) => ({
    title: s.title,
    label: s.label,
    header: `${s.emoji}  ${s.label}`,
    stories: (bySection.get(s.title.toLowerCase()) ?? []).slice(0, 3),
  }));
}

/** Chat layout: emoji headers, one bullet per item with a blank line between, dividers between sections. */
export function renderText(sections: DigestSection[], date: string): string {
  const head = `📰  Good morning, Sir\n${date}`;
  // Topics with nothing new are left out entirely (no "no updates" filler).
  const parts = sections
    .filter((s) => s.stories.length)
    .map((s) => `${s.header}\n\n${s.stories.map((st) => `• ${st.summary}${st.source ? ` (${st.source})` : ''}`).join('\n\n')}`);
  if (!parts.length) return `${head}\n\nNo major updates on your topics this morning.`;
  return `${head}\n\n${DIVIDER}\n\n${parts.join(`\n\n${DIVIDER}\n\n`)}`;
}

/** Convenience used by tests: model output straight to chat text. */
export function renderDigest(body: string, date: string): string {
  return renderText(parseBody(body), date);
}

/** Splits a digest into messages (under Telegram's 4096-char limit) at section boundaries, never mid-section. */
export function splitDigest(text: string, max = 3800): string[] {
  const sep = `\n\n${DIVIDER}\n\n`;
  const chunks: string[] = [];
  let cur = '';
  for (const block of text.split(sep)) {
    if (cur && cur.length + sep.length + block.length > max) {
      chunks.push(cur);
      cur = block;
    } else {
      cur = cur ? cur + sep + block : block;
    }
  }
  if (cur) chunks.push(cur);
  // a single oversized block (should not happen) still gets split safely
  return chunks.flatMap((c) => (c.length > max ? splitMessage(c, max) : [c]));
}

function parsePayload(raw: string): DigestPayload {
  try {
    const j = JSON.parse(raw) as Partial<DigestPayload>;
    if (j && typeof j.text === 'string' && Array.isArray(j.sections)) return j as DigestPayload;
  } catch {
    /* plain text from an older version */
  }
  return { date: '', text: raw, sections: [] };
}

const hm = (t: string) => t.split(':').map(Number) as [number, number];

export class NewsDigestService {
  private readonly sent = new Set<string>();
  private prepared?: { key: string; payload: DigestPayload };
  private pdf?: { key: string; data: Buffer };

  constructor(private readonly d: DigestDeps) {}

  private get now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  /**
   * Called every few seconds by the dispatcher and by /jobs/tick.
   * 1) From prepareTime: build the digest once (fetch + summarise) and store it, so a slow or rate-limited
   *    API has hours to succeed.
   * 2) From sendTime: deliver the prepared text (and the PDF edition) once per recipient (builds inline as a last resort).
   */
  async runDue(): Promise<{ prepared: boolean; sent: number; failed: number }> {
    const now = this.now;
    const out = { prepared: false, sent: 0, failed: 0 };
    const tz = this.d.timezone;
    const clock = localClock(now, tz);
    const at = (t: string) => zonedToUtc(clock.y, clock.m, clock.d, ...hm(t), tz);
    const prepareAt = at(this.d.prepareTime);
    const sendAt = at(this.d.sendTime);
    const windowEnd = new Date(sendAt.getTime() + (this.d.catchUpHours ?? 6) * 3600_000);
    if (now < prepareAt || now > windowEnd) return out;

    const dateKey = `${clock.y}-${String(clock.m).padStart(2, '0')}-${String(clock.d).padStart(2, '0')}`;
    const prepKey = `news-digest-prep:${dateKey}`;

    // ---- phase 1: prepare ----
    let payload: DigestPayload | undefined;
    if (this.prepared?.key === prepKey) payload = this.prepared.payload;
    else {
      const stored = await this.d.repo.getPayload(prepKey);
      if (stored) payload = parsePayload(stored);
    }
    if (!payload) {
      await this.d.repo.ensure({ key: prepKey, kind: 'news-digest-prep', channel: 'all', chatId: 'all', timezone: tz, scheduledFor: prepareAt }, now);
      const claim = await this.d.repo.claim(prepKey, now);
      if (claim) {
        try {
          payload = await this.buildDigest(now);
          await this.d.repo.savePayload(prepKey, JSON.stringify(payload));
          await this.d.repo.markSent(prepKey, this.now);
          out.prepared = true;
          logger.info({ key: prepKey }, 'News digest prepared');
        } catch (err) {
          const msg = (err as Error).message;
          await this.d.repo.markFailed(prepKey, msg, new Date(this.now.getTime() + 10 * 60_000));
          logger.warn({ key: prepKey, attempts: claim.attempts, err: { message: msg } }, 'News digest preparation failed, will retry');
        }
      }
    }
    if (payload) this.prepared = { key: prepKey, payload };

    // ---- phase 2: send ----
    if (now < sendAt) return out;
    for (const rcpt of this.d.recipients) {
      const key = `news-digest:${dateKey}:${rcpt.channel}:${rcpt.chatId}`;
      if (this.sent.has(key)) continue;
      await this.d.repo.ensure({ key, kind: 'news-digest', channel: rcpt.channel, chatId: rcpt.chatId, timezone: tz, scheduledFor: sendAt }, now);
      const claim = await this.d.repo.claim(key, now);
      if (!claim) continue; // already sent, being sent elsewhere, or waiting to retry
      try {
        const digest = payload ?? (await this.buildDigest(now)); // last resort if preparation never succeeded
        payload = digest;
        for (const part of splitDigest(digest.text)) await this.d.notify(rcpt.channel, rcpt.chatId, part);
        await this.d.repo.markSent(key, this.now);
        this.sent.add(key);
        out.sent++;
        logger.info({ key }, 'News digest sent');
        await this.sendPdf(rcpt, digest, dateKey); // after markSent: a PDF problem must never cause the text to be resent
      } catch (err) {
        const msg = (err as Error).message;
        // back off 5, 10, 15 minutes; gives up after MAX_JOB_ATTEMPTS
        await this.d.repo.markFailed(key, msg, new Date(this.now.getTime() + 5 * 60_000 * claim.attempts));
        out.failed++;
        logger.error({ key, attempts: claim.attempts, max: MAX_JOB_ATTEMPTS, err: { message: msg } }, 'News digest failed');
      }
    }
    await this.runExtras(payload, now, dateKey, sendAt, tz);
    return out;
  }

  /** The phone notification and the email: each claimed on its own, so one failing never repeats or blocks the others. */
  private async runExtras(payload: DigestPayload | undefined, now: Date, dateKey: string, sendAt: Date, tz: string): Promise<void> {
    for (const x of this.d.extras ?? []) {
      const key = `news-digest:${dateKey}:extra:${x.name}`;
      if (this.sent.has(key)) continue;
      await this.d.repo.ensure({ key, kind: 'news-digest-extra', channel: 'all', chatId: x.name, timezone: tz, scheduledFor: sendAt }, now);
      const claim = await this.d.repo.claim(key, now);
      if (!claim) continue;
      try {
        const digest = payload ?? (await this.buildDigest(now));
        payload = digest;
        if (digest.sections.some((s) => s.stories.length)) await x.deliver(digest, () => this.pdfFile(digest, dateKey));
        await this.d.repo.markSent(key, this.now);
        this.sent.add(key);
        logger.info({ key }, 'Morning briefing extra delivered');
      } catch (err) {
        const msg = (err as Error).message;
        await this.d.repo.markFailed(key, msg, new Date(this.now.getTime() + 5 * 60_000 * claim.attempts));
        logger.warn({ key, attempts: claim.attempts, err: { message: msg } }, 'Morning briefing extra failed, will retry');
      }
    }
  }

  /** Today's newspaper as a file, shared by every delivery (built once). Undefined if it cannot be made. */
  private async pdfFile(digest: DigestPayload, dateKey: string): Promise<DigestFile | undefined> {
    if (!this.d.makePdf || !digest.sections.some((s) => s.stories.length)) return undefined;
    try {
      if (this.pdf?.key !== dateKey) this.pdf = { key: dateKey, data: await this.d.makePdf(digest) };
      return { name: `MJ-Times-${dateKey}.pdf`, data: this.pdf.data, caption: `MJ TIMES · ${digest.date}` };
    } catch (err) {
      logger.warn({ err: { message: (err as Error).message } }, 'MJ Times PDF could not be built');
      return undefined;
    }
  }

  private async sendPdf(rcpt: DigestRecipient, digest: DigestPayload, dateKey: string): Promise<void> {
    const { makePdf, sendFile } = this.d;
    if (!makePdf || !sendFile || !digest.sections.some((s) => s.stories.length)) return;
    try {
      if (this.pdf?.key !== dateKey) this.pdf = { key: dateKey, data: await makePdf(digest) };
      await sendFile(rcpt.channel, rcpt.chatId, {
        name: `MJ-Times-${dateKey}.pdf`,
        data: this.pdf.data,
        caption: `MJ TIMES · ${digest.date}`,
      });
    } catch (err) {
      logger.warn({ err: { message: (err as Error).message } }, 'MJ Times PDF could not be sent (text digest was delivered)');
    }
  }

  /** Today's MJ TIMES PDF on demand (reuses the prepared digest, builds one if none exists yet). Throws on failure. */
  async newspaperNow(): Promise<DigestFile> {
    if (!this.d.makePdf) throw new Error('The newspaper is not enabled');
    const now = this.now;
    const c = localClock(now, this.d.timezone);
    const dateKey = `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
    const prepKey = `news-digest-prep:${dateKey}`;
    let payload = this.prepared?.key === prepKey ? this.prepared.payload : undefined;
    if (!payload) {
      const stored = await this.d.repo.getPayload(prepKey);
      if (stored) payload = parsePayload(stored);
    }
    if (!payload?.sections.some((s) => s.stories.length)) {
      payload = await this.buildDigest(now);
      this.prepared = { key: prepKey, payload };
    }
    if (!payload.sections.some((s) => s.stories.length)) throw new Error('There are no stories to print yet');
    if (this.pdf?.key !== dateKey) this.pdf = { key: dateKey, data: await this.d.makePdf(payload) };
    return { name: `MJ-Times-${dateKey}.pdf`, data: this.pdf.data, caption: `MJ TIMES · ${payload.date}` };
  }

  /** Text-only convenience (used by previews and scripts). */
  async build(now: Date = this.now): Promise<string> {
    return (await this.buildDigest(now)).text;
  }

  /** Fetches each section (search APIs + publisher feeds), has the model summarise only what was returned. */
  async buildDigest(now: Date = this.now): Promise<DigestPayload> {
    const perSection = await Promise.all(
      SECTIONS.map(async (s) => {
        const sources: Array<Promise<Article[]>> = [this.d.news.search(s.query), ...(this.d.feeds?.[s.title] ?? []).map((f) => f.fetch())];
        const settled = await Promise.allSettled(sources);
        const ok = settled.filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled');
        settled.forEach((r) => {
          if (r.status === 'rejected') logger.warn({ section: s.title, err: { message: String(r.reason?.message ?? r.reason) } }, 'News source failed');
        });
        // latest 15 from each source, then merged: de-duplicated, newest first, at most 14
        return { s, ok: ok.length > 0, articles: mergeArticles(ok.map((r) => r.value.slice(0, 15)), 14) };
      }),
    );
    if (perSection.every((x) => !x.ok)) throw new Error('All news requests failed');

    const material = perSection
      .map(
        ({ s, articles }) =>
          `## ${s.title}\n` +
          (articles.length
            ? articles
                .map((a, n) => `${n + 1}. ${a.title} [${a.source}]${a.imageUrl ? ' [photo]' : ''}${a.description ? ` - ${a.description}` : ''}`)
                .join('\n')
            : '(no articles)'),
      )
      .join('\n\n');

    const body = await this.d.ai.complete(
      [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: material },
      ],
      { temperature: 0.2, maxTokens: 5000 },
    );

    const date = now.toLocaleDateString('en-IN', { timeZone: this.d.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const byTitle = new Map(perSection.map(({ s, articles }) => [s.title.toLowerCase(), articles]));
    const sections = parseBody(body, byTitle);
    return { date, text: renderText(sections, date), sections };
  }
}
