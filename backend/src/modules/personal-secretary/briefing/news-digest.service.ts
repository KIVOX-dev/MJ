import { logger } from '../../../utils/logger';
import type { Completer } from '../../../core/orchestrator/assistant';
import type { Channel } from '../../../core/memory/message.store';
import { MAX_JOB_ATTEMPTS, type JobRunRepo } from '../../../jobs/job-run.repo';
import { localClock, zonedToUtc } from '../../../utils/time';
import { splitMessage } from '../../../utils/text';
import { regionQuery, type Article, type NewsSource, type Region } from '../../research-assistant/web-search/newsdata.client';

export interface DigestRecipient {
  channel: Channel;
  chatId: string;
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
  now?: () => Date;
}

const SECTIONS: Array<{ title: string; header: string; region: Region; category: 'politics' | 'sports' }> = [
  { title: 'Tamil Nadu - Politics', header: '🏛  TAMIL NADU · POLITICS', region: 'tamil_nadu', category: 'politics' },
  { title: 'Tamil Nadu - Sports', header: '🏅  TAMIL NADU · SPORTS', region: 'tamil_nadu', category: 'sports' },
  { title: 'India - Politics', header: '🇮🇳  INDIA · POLITICS', region: 'india', category: 'politics' },
  { title: 'India - Sports', header: '🏏  INDIA · SPORTS', region: 'india', category: 'sports' },
  { title: 'World - Politics', header: '🌍  WORLD · POLITICS', region: 'world', category: 'politics' },
  { title: 'World - Sports', header: '⚽  WORLD · SPORTS', region: 'world', category: 'sports' },
];

const SUMMARY_PROMPT =
  'You write the morning news briefing for "Sir", a busy professional in Tamil Nadu, India. ' +
  'Use ONLY the articles provided. Do not add facts, names, numbers or background that are not in them. ' +
  'Some articles may be in Tamil or off-topic: use Tamil ones (write in English) and silently skip any article ' +
  'that is not clearly about its section. Output format, exactly: for each section a line "## <section title exactly ' +
  'as given>" followed by 2 or 3 bullet lines. Each bullet starts with "• ", is ONE short sentence of at most 140 ' +
  'characters, and ends with the source name in brackets, e.g. (The Hindu). If a section has no usable article write ' +
  'a single bullet "• No fresh updates found." No links, no markdown, no asterisks, no intro or closing text.';

/** Turns the model's "## title" + bullets output into a clean, consistently formatted message. */
export function renderDigest(body: string, date: string): string {
  const bySection = new Map<string, string[]>();
  let current: string | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const h = /^#{1,3}\s*(.+)$/.exec(line);
    if (h) {
      current = h[1]!.replace(/\*+/g, '').trim().toLowerCase();
      bySection.set(current, []);
      continue;
    }
    const bullet = /^[•\-*]\s*(.+)$/.exec(line);
    if (current && bullet) bySection.get(current)!.push(bullet[1]!.replace(/\*+/g, '').trim());
  }
  const parts = SECTIONS.map((s) => {
    const bullets = (bySection.get(s.title.toLowerCase()) ?? []).filter(Boolean).slice(0, 3);
    return `${s.header}\n${(bullets.length ? bullets : ['No fresh updates found.']).map((b) => `• ${b}`).join('\n')}`;
  });
  return `📰  Good morning, Sir\n${date}\n\n${parts.join('\n\n')}`;
}

const hm = (t: string) => t.split(':').map(Number) as [number, number];

export class NewsDigestService {
  private readonly sent = new Set<string>();
  private prepared?: { key: string; text: string };

  constructor(private readonly d: DigestDeps) {}

  private get now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  /**
   * Called every few seconds by the dispatcher and by /jobs/tick.
   * 1) From prepareTime: build the digest once (fetch + summarise) and store it, so a slow or rate-limited
   *    API has hours to succeed.
   * 2) From sendTime: deliver the prepared text once per recipient (builds inline as a last resort).
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
    let text = this.prepared?.key === prepKey ? this.prepared.text : (await this.d.repo.getPayload(prepKey)) ?? undefined;
    if (!text) {
      await this.d.repo.ensure({ key: prepKey, kind: 'news-digest-prep', channel: 'all', chatId: 'all', timezone: tz, scheduledFor: prepareAt }, now);
      const claim = await this.d.repo.claim(prepKey, now);
      if (claim) {
        try {
          text = await this.build(now);
          await this.d.repo.savePayload(prepKey, text);
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
    if (text) this.prepared = { key: prepKey, text };

    // ---- phase 2: send ----
    if (now < sendAt) return out;
    for (const rcpt of this.d.recipients) {
      const key = `news-digest:${dateKey}:${rcpt.channel}:${rcpt.chatId}`;
      if (this.sent.has(key)) continue;
      await this.d.repo.ensure({ key, kind: 'news-digest', channel: rcpt.channel, chatId: rcpt.chatId, timezone: tz, scheduledFor: sendAt }, now);
      const claim = await this.d.repo.claim(key, now);
      if (!claim) continue; // already sent, being sent elsewhere, or waiting to retry
      try {
        const body = text ?? (await this.build(now)); // last resort if preparation never succeeded
        for (const part of splitMessage(body)) await this.d.notify(rcpt.channel, rcpt.chatId, part);
        await this.d.repo.markSent(key, this.now);
        this.sent.add(key);
        out.sent++;
        logger.info({ key }, 'News digest sent');
      } catch (err) {
        const msg = (err as Error).message;
        // back off 5, 10, 15 minutes; gives up after MAX_JOB_ATTEMPTS
        await this.d.repo.markFailed(key, msg, new Date(this.now.getTime() + 5 * 60_000 * claim.attempts));
        out.failed++;
        logger.error({ key, attempts: claim.attempts, max: MAX_JOB_ATTEMPTS, err: { message: msg } }, 'News digest failed');
      }
    }
    return out;
  }

  /** Fetches each section and has the model summarise only what was returned. Throws if nothing could be fetched. */
  async build(now: Date = this.now): Promise<string> {
    const results = await Promise.allSettled(SECTIONS.map((s) => this.d.news.search(regionQuery(s.region, s.category))));
    const sections: Array<{ title: string; articles: Article[] }> = [];
    let okCount = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') okCount++;
      else logger.warn({ section: SECTIONS[i]!.title, err: { message: String(r.reason?.message ?? r.reason) } }, 'News section fetch failed');
      sections.push({ title: SECTIONS[i]!.title, articles: r.status === 'fulfilled' ? r.value : [] });
    });
    if (okCount === 0) throw new Error('All news requests failed');

    const material = sections
      .map(
        (s) =>
          `## ${s.title}\n` +
          (s.articles.length
            ? s.articles.map((a, n) => `${n + 1}. ${a.title} [${a.source}]${a.description ? ` - ${a.description}` : ''}`).join('\n')
            : '(no articles)'),
      )
      .join('\n\n');

    const body = await this.d.ai.complete(
      [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: material },
      ],
      { temperature: 0.2, maxTokens: 4500 },
    );

    const date = now.toLocaleDateString('en-IN', { timeZone: this.d.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    // Messages only, no links (by request). The layout is built in code so it is always clean.
    return renderDigest(body, date);
  }
}
