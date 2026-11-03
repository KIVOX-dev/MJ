export interface Article {
  title: string;
  description?: string;
  source: string;
  link: string;
  pubDate: string;
}

export interface NewsQuery {
  q?: string;
  country?: string;
  category?: string;
  language?: string;
  size?: number;
}

export interface NewsSource {
  search(q: NewsQuery): Promise<Article[]>;
}

export type Region = 'tamil_nadu' | 'india' | 'world';

/** Shared by the get_news tool and the daily digest so both query the same way. */
export function regionQuery(region: Region, category?: string, topic?: string): NewsQuery {
  const base: NewsQuery = { category, language: 'en', size: 8 };
  if (region === 'tamil_nadu') {
    return { ...base, country: 'in', q: topic ? `Tamil Nadu ${topic}` : 'Tamil Nadu OR Chennai' };
  }
  if (region === 'india') return { ...base, country: 'in', q: topic };
  return { ...base, q: topic };
}

interface RawArticle {
  title?: string;
  description?: string | null;
  source_name?: string;
  source_id?: string;
  link?: string;
  pubDate?: string;
}

/** Newsdata.io "latest news" client (https://newsdata.io/documentation) with a small TTL cache to save credits. */
export class NewsdataClient implements NewsSource {
  private readonly cache = new Map<string, { at: number; data: Article[] }>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async search(q: NewsQuery): Promise<Article[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    const key = params.toString();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.data;

    // API key goes in a header so it never appears in URLs or logs.
    const res = await this.fetchFn(`https://newsdata.io/api/1/latest?${key}`, {
      headers: { 'X-ACCESS-KEY': this.apiKey },
    });
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      results?: RawArticle[] | { message?: string; code?: string };
    };
    if (!res.ok || json.status !== 'success' || !Array.isArray(json.results)) {
      const detail = !Array.isArray(json.results) ? json.results?.message : undefined;
      throw new Error(`Newsdata request failed (HTTP ${res.status}): ${detail ?? 'unexpected response'}`);
    }

    const seen = new Set<string>();
    const data: Article[] = [];
    for (const r of json.results) {
      const title = r.title?.trim();
      if (!title || !r.link || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      const desc = r.description?.trim();
      data.push({
        title,
        // free plans can return a "only available in paid plans" placeholder instead of text
        description: desc && !/only available/i.test(desc) ? desc.slice(0, 400) : undefined,
        source: r.source_name ?? r.source_id ?? 'unknown',
        link: r.link,
        pubDate: r.pubDate ?? '',
      });
    }
    this.cache.set(key, { at: this.now(), data });
    return data;
  }
}
