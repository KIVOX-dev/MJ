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

const SECTIONS: Array<{ title: string; region: Region; category: 'politics' | 'sports' }> = [
  { title: 'Tamil Nadu - Politics', region: 'tamil_nadu', category: 'politics' },
  { title: 'Tamil Nadu - Sports', region: 'tamil_nadu', category: 'sports' },
  { title: 'India - Politics', region: 'india', category: 'politics' },
  { title: 'India - Sports', region: 'india', category: 'sports' },
  { title: 'World - Politics', region: 'world', category: 'politics' },
  { title: 'World - Sports', region: 'world', category: 'sports' },
];

const SUMMARY_PROMPT =
  'You write the morning news briefing for "Sir", a busy professional in Tamil Nadu, India. ' +
  'Use ONLY the articles provided. Do not add facts, names, numbers or background that are not in them. ' +
  'Some articles may be in Tamil or off-topic: use Tamil ones (write the summary in English) and silently skip ' +
  'any article that is not clearly about its section. For each section write 2 to 3 short bullet lines starting ' +
  'with "• ", each ending with the source name in brackets, e.g. (The Hindu). If a section has no usable article, ' +
  'write "• No fresh updates found." Keep the section titles exactly as given, each on its own line, with a blank ' +
  'line between sections. Plain text only: no markdown, no asterisks. Keep the whole briefing under 2600 characters.';

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
      { temperature: 0.2, maxTokens: 1500 },
    );

    const date = now.toLocaleDateString('en-IN', { timeZone: this.d.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    // Links come straight from the sources, never from the model. Google News redirect links are ~500
    // characters each, so only short direct links are listed (every bullet already names its source).
    const links = sections
      .map((s) => ({ title: s.title, items: s.articles.filter((a) => a.link.length <= 200).slice(0, 2) }))
      .filter((s) => s.items.length)
      .map((s) => `${s.title}\n` + s.items.map((a) => `- ${a.title.slice(0, 70)}\n  ${a.link}`).join('\n'))
      .join('\n\n');
    const sourcesBlock = links ? `\n\nLinks:\n\n${links}` : '';

    return `Good morning, Sir. Your news briefing for ${date}\n\n${body}${sourcesBlock}`;
  }
}
