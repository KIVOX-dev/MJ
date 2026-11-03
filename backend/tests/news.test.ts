import { describe, expect, it, vi } from 'vitest';
import { NewsDigestService, renderDigest, splitDigest } from '../src/modules/personal-secretary/briefing/news-digest.service';
import { BreakingNewsService, parseAlerts } from '../src/modules/research-assistant/web-search/breaking-news.service';
import { CompositeNewsSource, GoogleNewsSource, parseRss } from '../src/modules/research-assistant/web-search/rss';
import { NewsdataClient, type Article } from '../src/modules/research-assistant/web-search/newsdata.client';
import { MAX_JOB_ATTEMPTS, type JobRunRepo } from '../src/jobs/job-run.repo';
import type { SeenRepo } from '../src/jobs/seen.repo';
import { splitMessage } from '../src/utils/text';

// ---- helpers -------------------------------------------------------------------------------
/** IST wall-clock time on 2026-11-04 as a Date (IST = UTC+05:30). */
const ist = (hhmm: string) => new Date(`2026-11-04T${hhmm}:00+05:30`);

function fakeJobs(): JobRunRepo & { rows: Map<string, any> } {
  const rows = new Map<string, any>();
  return {
    rows,
    ensure: async (r, now) => void (rows.has(r.key) || rows.set(r.key, { ...r, status: 'new', attempts: 0, runAfter: now })),
    claim: async (key, now) => {
      const r = rows.get(key);
      if (!r) return null;
      const ok = r.status === 'new' || (r.status === 'failed' && r.attempts < MAX_JOB_ATTEMPTS && r.runAfter <= now);
      if (!ok) return null;
      r.status = 'running';
      r.attempts++;
      return { key, kind: r.kind, channel: r.channel, chatId: r.chatId, attempts: r.attempts };
    },
    markSent: async (key) => void (rows.get(key).status = 'sent'),
    markFailed: async (key, error, retryAt) => Object.assign(rows.get(key), { status: 'failed', lastError: error, runAfter: retryAt }),
    savePayload: async (key, payload) => void (rows.get(key).payload = payload),
    getPayload: async (key) => rows.get(key)?.payload ?? null,
  };
}

const article = (title: string, minsAgo: number, now: Date, source = 'The Hindu'): Article => ({
  title,
  source,
  link: `https://example.com/${encodeURIComponent(title)}`,
  pubDate: new Date(now.getTime() - minsAgo * 60_000).toISOString(),
});

// ---- digest: prepare at 05:00, send at 08:00 -----------------------------------------------
describe('NewsDigestService', () => {
  function setup() {
    const clock = { t: ist('04:59') };
    const news = { search: vi.fn().mockResolvedValue([article('Cabinet approves new scheme', 30, clock.t)]) };
    const ai = { complete: vi.fn().mockResolvedValue('## Tamil Nadu - Politics\n• Scheme approved (The Hindu)') };
    const notify = vi.fn().mockResolvedValue(undefined);
    const repo = fakeJobs();
    const svc = new NewsDigestService({
      repo, news, ai, notify,
      recipients: [{ channel: 'telegram', chatId: '7' }],
      timezone: 'Asia/Kolkata', prepareTime: '05:00', sendTime: '08:00',
      now: () => clock.t,
    });
    return { svc, clock, news, ai, notify, repo };
  }

  it('does nothing before 05:00', async () => {
    const { svc, news, notify } = setup();
    expect(await svc.runDue()).toEqual({ prepared: false, sent: 0, failed: 0 });
    expect(news.search).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('prepares at 05:00 (once) but only sends at 08:00 (once)', async () => {
    const { svc, clock, ai, notify } = setup();
    clock.t = ist('05:00');
    expect((await svc.runDue()).prepared).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    clock.t = ist('06:30');
    await svc.runDue();
    expect(ai.complete).toHaveBeenCalledTimes(1); // not rebuilt

    clock.t = ist('08:00');
    expect((await svc.runDue()).sent).toBe(1);
    expect(ai.complete).toHaveBeenCalledTimes(1); // sent the prepared text
    expect(notify.mock.calls[0]![2]).toContain('Good morning, Sir');
    expect(notify.mock.calls[0]![2]).toContain('• Scheme approved (The Hindu)');
    expect(notify.mock.calls[0]![2]).not.toMatch(/https?:/); // messages only, no links

    clock.t = ist('08:05');
    expect((await svc.runDue()).sent).toBe(0); // never twice
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retries a failed preparation and still delivers at 08:00', async () => {
    const { svc, clock, news, notify } = setup();
    news.search.mockRejectedValue(new Error('429 rate limit'));
    clock.t = ist('05:00');
    expect((await svc.runDue()).prepared).toBe(false);
    clock.t = ist('05:11'); // after the 10-minute back-off
    await svc.runDue();
    news.search.mockResolvedValue([article('Late story', 10, clock.t)]);
    clock.t = ist('08:00'); // preparation never succeeded: builds inline as a last resort
    expect((await svc.runDue()).sent).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('skips the day entirely if the instance only wakes up long after the window', async () => {
    const { svc, clock, notify } = setup();
    clock.t = ist('15:00');
    expect((await svc.runDue()).sent).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('retries sending after a delivery failure', async () => {
    const { svc, clock, notify } = setup();
    clock.t = ist('05:00');
    await svc.runDue();
    notify.mockRejectedValueOnce(new Error('telegram down'));
    clock.t = ist('08:00');
    expect((await svc.runDue()).failed).toBe(1);
    clock.t = ist('08:06');
    expect((await svc.runDue()).sent).toBe(1);
  });
});

describe('renderDigest', () => {
  it('lays out every section in order with clean bullets, filling gaps and stripping markdown', () => {
    const out = renderDigest(
      '## India - Sports\n- **Team wins** (ESPN)\n* Second line (BBC)\n## Tamil Nadu - Politics\n• Budget tabled (The Hindu)',
      'Wednesday, 4 November 2026',
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('📰  Good morning, Sir');
    expect(out.indexOf('TAMIL NADU · POLITICS')).toBeLessThan(out.indexOf('INDIA · SPORTS'));
    expect(out).toContain('• Budget tabled (The Hindu)');
    expect(out).toContain('• Team wins (ESPN)');
    expect(out).not.toContain('**');
    expect(out).not.toContain('WORLD · SPORTS'); // topic with nothing new is omitted entirely
    expect(out).not.toMatch(/no fresh updates|no updates/i);
    expect(out).toContain('• Team wins (ESPN)\n\n• Second line (BBC)'); // blank line between bullets
    expect(out).toContain('──────────────'); // section dividers
  });
  it('includes the entertainment sections: Kollywood, Hollywood, box office, reviews', () => {
    const out = renderDigest(
      '## Kollywood\n• Big Tamil release opens strongly (DT Next)\n## Box Office and Trending Movies\n• Film X collects a reported figure (Sacnilk)\n## Reviews and Public Response\n• Audience praises the second half (Times of India)',
      'x',
    );
    for (const h of ['🎬  KOLLYWOOD', '💰  BOX OFFICE & TRENDING MOVIES', '⭐  REVIEWS & PUBLIC RESPONSE']) expect(out).toContain(h);
    expect(out).toContain('• Big Tamil release opens strongly (DT Next)');
    expect(out).not.toContain('HOLLYWOOD');
  });
  it('drops filler bullets the model writes for empty topics, and omits those sections', () => {
    const out = renderDigest('## Hollywood\n• No fresh updates found.\n## Kollywood\n• Real story (DT Next)', 'x');
    expect(out).not.toContain('HOLLYWOOD');
    expect(out).toContain('KOLLYWOOD');
  });
  it('says so once, plainly, if there is nothing at all', () => {
    const out = renderDigest('random prose', 'x');
    expect(out).toContain('No major updates on your topics this morning.');
    expect(out).not.toContain('·');
  });
  it('splits long digests between sections, never inside one, each part under the limit', () => {
    const bullets = Array.from({ length: 3 }, (_, i) => `• ${'Long bullet text '.repeat(8).trim()} ${i} (Src)`).join('\n');
    const body = ['Tamil Nadu - Politics', 'Tamil Nadu - Sports', 'India - Politics', 'India - Sports', 'World - Politics', 'World - Sports', 'Kollywood', 'Hollywood', 'Box Office and Trending Movies', 'Reviews and Public Response']
      .map((t) => `## ${t}\n${bullets}`)
      .join('\n');
    const full = renderDigest(body, 'x');
    const parts = splitDigest(full, 1500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1500)).toBe(true);
    // every section header appears exactly once across the parts, i.e. nothing was cut in half
    expect(parts.join('\n').match(/·|KOLLYWOOD|HOLLYWOOD|BOX OFFICE|REVIEWS/g)!.length).toBe(full.match(/·|KOLLYWOOD|HOLLYWOOD|BOX OFFICE|REVIEWS/g)!.length);
  });
});

// ---- breaking alerts -----------------------------------------------------------------------
describe('BreakingNewsService', () => {
  function setup(items: (now: Date) => Article[], aiReply = '{"alerts":[{"n":1,"headline":"CM announces cyclone relief"}]}') {
    const clock = { t: ist('10:00') };
    const seenSet = new Set<string>();
    const alertedAt: Date[] = [];
    const seen: SeenRepo = {
      unseen: async (_k, keys) => keys.filter((k) => !seenSet.has(k)),
      mark: async (_k, keys, alerted) => keys.forEach((k) => (seenSet.add(k), alerted && alertedAt.push(clock.t))),
      alertedCountSince: async () => alertedAt.length,
    };
    const ai = { complete: vi.fn().mockResolvedValue(aiReply) };
    const notify = vi.fn().mockResolvedValue(undefined);
    const jobs = fakeJobs();
    const svc = new BreakingNewsService({
      feeds: [{ fetch: async () => items(clock.t) }],
      ai, seen, jobs, notify,
      recipients: [{ channel: 'telegram', chatId: '7' }],
      timezone: 'Asia/Kolkata', intervalMin: 10, now: () => clock.t,
    });
    return { svc, clock, ai, notify, jobs, seenSet };
  }

  it('alerts on a fresh important headline, with the source link, exactly once', async () => {
    const { svc, clock, notify, ai } = setup((n) => [article('Cyclone warning for coastal TN', 20, n)]);
    expect(await svc.runDue()).toEqual({ alerts: 1 });
    expect(notify.mock.calls[0]![2]).toContain('CM announces cyclone relief');
    expect(notify.mock.calls[0]![2]).toContain('TAMIL NADU ALERT');
    expect(notify.mock.calls[0]![2]).not.toMatch(/https?:/); // messages only, no links
    // next interval slot: same headline is not repeated and the model is not even asked again
    clock.t = ist('10:10');
    await svc.runDue();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('ignores stale headlines and at most one check runs per interval slot', async () => {
    const { svc, notify, ai } = setup((n) => [article('Old story', 600, n)]);
    await svc.runDue();
    expect(ai.complete).not.toHaveBeenCalled();
    expect(await svc.runDue()).toBe('skipped'); // same slot
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not mark headlines as seen when the classifier fails, so the next slot retries', async () => {
    const { svc, clock, ai, notify, seenSet } = setup((n) => [article('Cyclone warning', 5, n)], 'not json at all');
    await svc.runDue();
    expect(seenSet.size).toBe(0);
    ai.complete.mockResolvedValue('{"alerts":[{"n":1,"headline":"Cyclone warning issued"}]}');
    clock.t = ist('10:20'); // past the retry back-off and in a new slot
    await svc.runDue();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('respects the daily cap', async () => {
    const clock = { t: ist('10:00') };
    const seen: SeenRepo = { unseen: async (_k, k) => k, mark: async () => {}, alertedCountSince: async () => 15 };
    const ai = { complete: vi.fn() };
    const notify = vi.fn();
    const svc = new BreakingNewsService({
      feeds: [{ fetch: async () => [article('Big news', 5, clock.t)] }], ai, seen, jobs: fakeJobs(), notify,
      recipients: [{ channel: 'telegram', chatId: '7' }], timezone: 'Asia/Kolkata', intervalMin: 10, now: () => clock.t,
    });
    await svc.runDue();
    expect(ai.complete).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('parses classifier output defensively', () => {
    expect(parseAlerts('```json\n{"alerts":[{"n":2,"headline":" X "},{"n":9,"headline":"out of range"},{"n":2,"headline":"dup"}]}\n```', 3)).toEqual([{ n: 2, headline: 'X' }]);
    expect(parseAlerts('{"alerts":[]}', 3)).toEqual([]);
    expect(() => parseAlerts('nothing', 3)).toThrow();
  });
});

// ---- RSS / sources -------------------------------------------------------------------------
describe('parseRss', () => {
  it('parses CDATA, entities, source and Google-style titles', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Cabinet clears new scheme - The Hindu]]></title><link>https://x.test/a</link>
        <pubDate>Tue, 03 Nov 2026 23:00:00 GMT</pubDate><source url="https://thehindu.com">The Hindu</source></item>
      <item><title>Jammu &amp; Kashmir vs Tamil Nadu</title><link>https://x.test/b</link><pubDate>garbage</pubDate></item>
      <item><title>No link</title></item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'Cabinet clears new scheme', source: 'The Hindu', pubDate: '2026-11-03T23:00:00.000Z' });
    expect(items[1]).toMatchObject({ title: 'Jammu & Kashmir vs Tamil Nadu', pubDate: '' });
  });
});

describe('news sources', () => {
  const n = new Date();
  it('Composite merges, de-duplicates, sorts newest first and survives one failing source', async () => {
    const a = { search: async () => [article('Same story', 60, n), article('Older', 300, n)] };
    const b = { search: async () => [article('same  story!', 10, n)] };
    const bad = { search: async () => { throw new Error('boom'); } };
    const out = await new CompositeNewsSource([a, bad, b]).search({});
    expect(out.map((x) => x.title)).toEqual(['same  story!', 'Older']);
    await expect(new CompositeNewsSource([bad]).search({})).rejects.toThrow(/All news sources failed/);
  });

  it('GoogleNewsSource builds a 1-day query and caches', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<rss><channel></channel></rss>' });
    const g = new GoogleNewsSource(f as unknown as typeof fetch);
    await g.search({ q: 'Tamil Nadu OR Chennai', category: 'politics' });
    await g.search({ q: 'Tamil Nadu OR Chennai', category: 'politics' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(f.mock.calls[0]![0])).toContain('(Tamil Nadu OR Chennai) politics when:1d');
  });

  it('NewsdataClient sends the key in a header (not the URL), drops paid placeholders and caches', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: 'success', results: [
        { title: 'A', link: 'https://a', description: 'ONLY AVAILABLE IN PAID PLANS', source_id: 's', pubDate: '2026-11-04 01:00:00' },
        { title: 'a', link: 'https://dup', source_id: 's' },
      ] }),
    });
    const c = new NewsdataClient('SECRETKEY', f as unknown as typeof fetch);
    const out = await c.search({ q: 'x' });
    await c.search({ q: 'x' });
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).not.toContain('SECRETKEY');
    expect(f.mock.calls[0]![1].headers['X-ACCESS-KEY']).toBe('SECRETKEY');
  });
});

describe('splitMessage', () => {
  it('splits on paragraph boundaries under the limit', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(480)).join('\n\n');
    const parts = splitMessage(text, 1200);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1200)).toBe(true);
    expect(parts.join('\n\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
});
