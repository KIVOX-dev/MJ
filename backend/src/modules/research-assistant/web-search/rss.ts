import type { Article, NewsQuery, NewsSource } from './newsdata.client';

const unwrap = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1]!.trim() : undefined;
}

/** Best image for an item: media:content / media:thumbnail / image enclosure / first <img> in the description. */
function findImage(item: string, descHtml: string): string | undefined {
  const urlOf = (tagText: string) => /\burl\s*=\s*["']([^"']+)["']/i.exec(tagText)?.[1];
  const looksImage = (tagText: string, url: string) =>
    /medium\s*=\s*["']image["']/i.test(tagText) || /type\s*=\s*["']image\//i.test(tagText) || /\.(jpe?g|png|webp)(\?|$)/i.test(url);
  for (const m of item.matchAll(/<media:content\b[^>]*>/gi)) {
    const u = urlOf(m[0]);
    if (u && looksImage(m[0], u)) return decode(u);
  }
  const thumb = /<media:thumbnail\b[^>]*>/i.exec(item);
  if (thumb && urlOf(thumb[0])) return decode(urlOf(thumb[0])!);
  for (const m of item.matchAll(/<enclosure\b[^>]*>/gi)) {
    const u = urlOf(m[0]);
    if (u && looksImage(m[0], u)) return decode(u);
  }
  const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(descHtml);
  return img ? decode(img[1]!) : undefined;
}

/** Minimal RSS 2.0 parser (title, link, pubDate, source, description, image). */
export function parseRss(xml: string): Article[] {
  const out: Article[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1]!;
    const rawTitle = tag(item, 'title');
    const link = tag(item, 'link');
    if (!rawTitle || !link) continue;
    let title = decode(stripHtml(unwrap(rawTitle)));
    const rawSource = tag(item, 'source');
    const source = rawSource ? decode(stripHtml(unwrap(rawSource))) : undefined;
    // Google News titles look like "Headline - Source"
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const pub = tag(item, 'pubDate');
    const when = pub ? new Date(decode(unwrap(pub)).trim()) : null;
    const rawDesc = tag(item, 'description');
    const desc = rawDesc ? decode(stripHtml(decode(unwrap(rawDesc)))) : undefined;
    const imageUrl = findImage(item, rawDesc ? decode(unwrap(rawDesc)) : '');
    out.push({
      imageUrl,
      title,
      description: desc && desc.length > 40 && !desc.startsWith(title) ? desc.slice(0, 400) : undefined,
      source: source ?? 'unknown',
      link: decode(unwrap(link)).trim(),
      pubDate: when && !Number.isNaN(when.getTime()) ? when.toISOString() : '',
    });
  }
  return out;
}

/** A single real-time RSS feed. */
export class RssFeed {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetch(): Promise<Article[]> {
    const res = await this.fetchFn(this.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MJ-Assistant/0.1)' } });
    if (!res.ok) throw new Error(`Feed ${this.name} failed (HTTP ${res.status})`);
    const items = parseRss(await res.text());
    return items.map((a) => (a.source === 'unknown' ? { ...a, source: this.name } : a));
  }
}

export const THE_HINDU_TN = (f?: typeof fetch) =>
  new RssFeed('The Hindu', 'https://www.thehindu.com/news/national/tamil-nadu/feeder/default.rss', f);

export const googleNewsFeed = (search: string, f?: typeof fetch) =>
  new RssFeed(
    'Google News',
    `https://news.google.com/rss/search?q=${encodeURIComponent(search)}&hl=en-IN&gl=IN&ceid=IN:en`,
    f,
  );

/** Fresh headlines (last 24h) from Google News RSS, free and real-time, shaped like a NewsSource. */
export class GoogleNewsSource implements NewsSource {
  private readonly cache = new Map<string, { at: number; data: Article[] }>();

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async search(q: NewsQuery): Promise<Article[]> {
    const subject = q.q ? `(${q.q})` : q.country === 'in' ? 'India' : 'world';
    const search = `${subject} ${q.category ?? ''} when:1d`.replace(/\s+/g, ' ').trim();
    const hit = this.cache.get(search);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.data;
    const data = await googleNewsFeed(search, this.fetchFn).fetch();
    this.cache.set(search, { at: this.now(), data });
    return data;
  }
}

/**
 * Merges article lists: de-duplicates by title (keeping the freshest copy, but an image from any copy), newest first.
 */
export function mergeArticles(lists: Article[][], cap: number): Article[] {
  const byTitle = new Map<string, Article>();
  for (const a of lists.flat()) {
    const k = a.title.toLowerCase().replace(/\W+/g, ' ').trim();
    const prev = byTitle.get(k);
    if (!prev) byTitle.set(k, a);
    else {
      const fresher = (Date.parse(a.pubDate) || 0) > (Date.parse(prev.pubDate) || 0) ? a : prev;
      byTitle.set(k, { ...fresher, imageUrl: fresher.imageUrl ?? a.imageUrl ?? prev.imageUrl });
    }
  }
  return [...byTitle.values()].sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)).slice(0, cap);
}

/** Merges several sources: tolerates individual failures, de-duplicates by title, newest first. */
export class CompositeNewsSource implements NewsSource {
  constructor(private readonly sources: NewsSource[]) {}

  async search(q: NewsQuery): Promise<Article[]> {
    const settled = await Promise.allSettled(this.sources.map((s) => s.search(q)));
    const ok = settled.filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled');
    if (!ok.length) throw new Error(`All news sources failed: ${String((settled[0] as PromiseRejectedResult).reason?.message)}`);
    return mergeArticles(ok.map((r) => r.value), 12);
  }
}
