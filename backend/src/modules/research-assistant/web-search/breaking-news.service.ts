import crypto from 'node:crypto';
import { logger } from '../../../utils/logger';
import type { Completer } from '../../../core/orchestrator/assistant';
import type { Channel } from '../../../core/memory/message.store';
import { MAX_JOB_ATTEMPTS, type JobRunRepo } from '../../../jobs/job-run.repo';
import type { SeenRepo } from '../../../jobs/seen.repo';
import { localClock, zonedToUtc } from '../../../utils/time';
import type { Article } from './newsdata.client';

export interface AlertFeed {
  fetch(): Promise<Article[]>;
}

export interface BreakingDeps {
  feeds: AlertFeed[];
  ai: Completer;
  seen: SeenRepo;
  jobs: JobRunRepo;
  notify: (channel: Channel, chatId: string, text: string) => Promise<void>;
  recipients: Array<{ channel: Channel; chatId: string }>;
  timezone: string;
  /** How often to check, in minutes. */
  intervalMin: number;
  /** Ignore headlines older than this many minutes. */
  freshnessMin?: number;
  maxPerRun?: number;
  maxPerDay?: number;
  now?: () => Date;
}

const KIND = 'tn-alert';

const CLASSIFY_PROMPT =
  'You screen Tamil Nadu news for one reader who wants to be kept well informed through the day. From the numbered ' +
  'headlines pick the items that are genuinely newsworthy for people in Tamil Nadu: government or Chief Minister decisions ' +
  'and announcements, politics (party moves, alliances, elections, statements by leaders), arrests, cases and investigations ' +
  'involving notable people, court verdicts and important orders, accidents, crimes, disasters, deaths of notable people, ' +
  'weather and rain/cyclone/flood warnings, transport or power disruptions, major local incidents, important business or ' +
  'jobs news, and big Tamil cinema or sports news. ' +
  'Skip only content that is clearly low value: opinion pieces, explainers, trackers, study-material or coaching sites, ' +
  'lifestyle features, promotions, astrology, listicles and routine procedural notices. ' +
  'When several headlines cover the same event choose only the best one. When real news is flowing, picking 2 to 5 items is normal; ' +
  'pick none only if everything is clearly low value. ' +
  'For each chosen item write a one-line plain-English headline (max 180 characters) using ONLY facts in that item. ' +
  'Reply with JSON only, no other text: {"alerts":[{"n":1,"headline":"..."}]}';

const titleKey = (t: string) => crypto.createHash('sha1').update(t.toLowerCase().replace(/\W+/g, ' ').trim()).digest('hex');

export class BreakingNewsService {
  constructor(private readonly d: BreakingDeps) {}

  private get now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  /** At most one check per interval slot across all instances (claimed through the job-run record). */
  async runDue(): Promise<{ alerts: number } | 'skipped'> {
    const now = this.now;
    const slotMs = this.d.intervalMin * 60_000;
    const slot = Math.floor(now.getTime() / slotMs);
    const key = `tn-alerts:${slot}`;
    await this.d.jobs.ensure(
      { key, kind: KIND, channel: 'all', chatId: 'all', timezone: this.d.timezone, scheduledFor: new Date(slot * slotMs) },
      now,
    );
    const claim = await this.d.jobs.claim(key, now);
    if (!claim) return 'skipped';
    try {
      const alerts = await this.check(now);
      await this.d.jobs.markSent(key, this.now);
      return { alerts };
    } catch (err) {
      const msg = (err as Error).message;
      await this.d.jobs.markFailed(key, msg, new Date(this.now.getTime() + 2 * 60_000 * claim.attempts));
      logger.warn({ attempts: claim.attempts, max: MAX_JOB_ATTEMPTS, err: { message: msg } }, 'Breaking-news check failed');
      return { alerts: 0 };
    }
  }

  async check(now: Date): Promise<number> {
    const settled = await Promise.allSettled(this.d.feeds.map((f) => f.fetch()));
    const ok = settled.filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled');
    if (!ok.length) throw new Error('All alert feeds failed');

    // fresh, de-duplicated candidates, newest first
    const freshMs = (this.d.freshnessMin ?? 180) * 60_000;
    const byKey = new Map<string, Article>();
    for (const a of ok.flatMap((r) => r.value)) {
      const t = Date.parse(a.pubDate);
      if (!t || now.getTime() - t > freshMs || t - now.getTime() > 10 * 60_000) continue;
      byKey.set(titleKey(a.title), a);
    }
    const fresh = [...byKey.entries()].sort((a, b) => Date.parse(b[1].pubDate) - Date.parse(a[1].pubDate));
    const newKeys = new Set(await this.d.seen.unseen(KIND, fresh.map(([k]) => k)));
    const items = fresh.filter(([k]) => newKeys.has(k)).slice(0, 20);
    if (!items.length) return 0;

    // daily cap so a busy news day cannot flood the chat
    const clock = localClock(now, this.d.timezone);
    const dayStart = zonedToUtc(clock.y, clock.m, clock.d, 0, 0, this.d.timezone);
    const remaining = (this.d.maxPerDay ?? 30) - (await this.d.seen.alertedCountSince(KIND, dayStart));
    if (remaining <= 0) {
      await this.d.seen.mark(KIND, items.map(([k]) => k), false);
      return 0;
    }

    const listing = items
      .map(([, a], i) => `${i + 1}. ${a.title} [${a.source}, ${Math.max(0, Math.round((now.getTime() - Date.parse(a.pubDate)) / 60_000))} min ago]${a.description ? ` - ${a.description.slice(0, 200)}` : ''}`)
      .join('\n');
    const raw = await this.d.ai.complete(
      [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: listing },
      ],
      { temperature: 0, maxTokens: 3000 },
    );
    const picked = parseAlerts(raw, items.length).slice(0, Math.min(this.d.maxPerRun ?? 5, remaining));

    // If classification failed to parse we threw above, so nothing was marked seen and the next slot retries.
    const alertedKeys = new Set<string>();
    for (const p of picked) {
      const [k, a] = items[p.n - 1]!;
      const text = `🚨  TAMIL NADU ALERT\n\n${p.headline}\n\n— ${a.source}`;
      for (const r of this.d.recipients) await this.d.notify(r.channel, r.chatId, text);
      await this.d.seen.mark(KIND, [k], true); // mark right after delivery so a later failure cannot cause a repeat
      alertedKeys.add(k);
    }
    await this.d.seen.mark(KIND, items.map(([k]) => k).filter((k) => !alertedKeys.has(k)), false);
    if (picked.length) logger.info({ count: picked.length }, 'Tamil Nadu alerts sent');
    return picked.length;
  }
}

/** Defensive JSON extraction: the model may wrap the JSON in prose or code fences. */
export function parseAlerts(raw: string, max: number): Array<{ n: number; headline: string }> {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) throw new Error('Alert classifier returned no JSON');
  let parsed: { alerts?: Array<{ n?: unknown; headline?: unknown }> };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    throw new Error('Alert classifier returned invalid JSON');
  }
  const out: Array<{ n: number; headline: string }> = [];
  const used = new Set<number>();
  for (const a of parsed.alerts ?? []) {
    const n = Number(a.n);
    if (!Number.isInteger(n) || n < 1 || n > max || used.has(n) || typeof a.headline !== 'string' || !a.headline.trim()) continue;
    used.add(n);
    out.push({ n, headline: a.headline.trim().slice(0, 220) });
  }
  return out;
}
