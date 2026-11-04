import { isPublicHttpUrl } from '../../../utils/image';
import { assertReadableUrl, blockedHost } from './web-page';

/**
 * Client for Crawlit (https://labs.arufian.dev/crawlit/), a self-hosted crawler: JS-capable page scraping to Markdown,
 * search, site maps and crawls over a small HTTP API (MIT licensed, no API key). Crawlit has NO authentication, so it
 * must only be reachable from MJ (localhost or a private network), never from the public internet.
 *
 * MJ keeps its own safety rules in front of it: public http(s) URLs only, and never the sites that forbid scraping
 * (LinkedIn, Facebook, Instagram, X), regardless of what Crawlit could technically fetch.
 */
export interface CrawlitPage {
  url: string;
  title?: string;
  description?: string;
  markdown: string;
  links: string[];
}

export interface CrawlitSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

const clean = (md: string) => md.replace(/\n{3,}/g, '\n\n').trim();

export class CrawlitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 45_000): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('The web reader (Crawlit) is not reachable or took too long');
    }
    const json = (await res.json().catch(() => ({}))) as T & { success?: boolean; error?: string };
    if (res.status >= 400 || json.success === false) {
      throw new Error(`Crawlit could not complete that request (${json.error ?? `HTTP ${res.status}`})`);
    }
    return { status: res.status, json };
  }

  async health(): Promise<boolean> {
    try {
      return (await this.call<{ status?: string }>('GET', '/health', undefined, 5000)).json.status === 'ok';
    } catch {
      return false;
    }
  }

  /** One page as clean Markdown (uses a real browser automatically when the page needs JavaScript). */
  async scrape(url: string): Promise<CrawlitPage> {
    assertReadableUrl(url);
    const { json } = await this.call<{ data?: { markdown?: string; links?: string[]; metadata?: { title?: string; description?: string; sourceURL?: string } } }>(
      'POST',
      '/v1/scrape',
      { url, formats: ['markdown', 'links'], onlyMainContent: true, mode: 'auto', timeout: 30_000 },
    );
    const d = json.data;
    if (!d?.markdown) throw new Error('Crawlit returned no readable content for that page');
    // a redirect must not smuggle us onto a blocked or private host
    const finalUrl = d.metadata?.sourceURL ?? url;
    if (!isPublicHttpUrl(finalUrl) || blockedHost(new URL(finalUrl).hostname.toLowerCase())) throw new Error('That link redirects to a site I am not allowed to read');
    return {
      url: finalUrl,
      title: d.metadata?.title || undefined,
      description: d.metadata?.description || undefined,
      markdown: clean(d.markdown),
      links: (d.links ?? []).filter((l) => isPublicHttpUrl(l)).slice(0, 25),
    };
  }

  /** Web search through Crawlit (Google, falling back to DuckDuckGo). Results are search-engine snippets, not full pages. */
  async search(query: string, limit = 8): Promise<{ engine?: string; results: CrawlitSearchResult[]; warning?: string }> {
    const { json } = await this.call<{ data?: { engine?: string; results?: CrawlitSearchResult[]; blocked?: boolean; warning?: string } }>(
      'POST',
      '/v1/search',
      { query: query.slice(0, 500), limit: Math.min(Math.max(limit, 1), 20), timeout: 20_000 },
      40_000,
    );
    const d = json.data;
    const results = (d?.results ?? []).filter((r) => r.url && isPublicHttpUrl(r.url));
    return { engine: d?.engine, results, warning: d?.blocked ? (d.warning ?? 'The search engines asked for a bot check; try again later') : undefined };
  }

  /**
   * Bounded breadth-first crawl of one site (Crawlit respects robots.txt and skips binary files). Stays on the
   * starting domain. Returns the pages finished within `maxWaitMs`; a crawl still running after that is cancelled.
   */
  async crawl(
    url: string,
    opts: { maxPages?: number; maxDepth?: number; includePathPrefix?: string } = {},
    maxWaitMs = 60_000,
  ): Promise<{ pages: CrawlitPage[]; complete: boolean }> {
    const seed = assertReadableUrl(url);
    const limit = Math.min(Math.max(opts.maxPages ?? 8, 1), 15);
    const prefix = opts.includePathPrefix?.startsWith('/') ? opts.includePathPrefix : undefined;
    const start = await this.call<{ id?: string }>('POST', '/v1/crawl', {
      url: seed.href,
      limit,
      maxDepth: Math.min(Math.max(opts.maxDepth ?? 1, 1), 2),
      allowedDomains: [seed.hostname],
      ...(prefix ? { includePaths: [`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`] } : {}),
      mode: 'auto',
      formats: ['markdown'],
      onlyMainContent: true,
    });
    const id = start.json.id;
    if (!id || !/^[\w-]{4,80}$/.test(id)) throw new Error('Crawlit did not start the crawl');

    type Poll = { status?: string; data?: Array<{ url?: string; markdown?: string; metadata?: { title?: string; description?: string } }> };
    const deadline = Date.now() + maxWaitMs;
    let last: Poll = {};
    for (;;) {
      last = (await this.call<Poll>('GET', `/v1/crawl/${id}?offset=0&limit=${limit}`, undefined, 15_000)).json;
      if (last.status === 'completed' || last.status === 'failed' || last.status === 'cancelled') break;
      if (Date.now() >= deadline) {
        await this.call('DELETE', `/v1/crawl/${id}`, undefined, 10_000).catch(() => undefined);
        break;
      }
      await this.sleep(3000);
    }
    const pages = (last.data ?? [])
      .filter((p) => p.url && p.markdown && isPublicHttpUrl(p.url) && !blockedHost(new URL(p.url).hostname.toLowerCase()))
      .map((p) => ({ url: p.url!, title: p.metadata?.title || undefined, description: p.metadata?.description || undefined, markdown: clean(p.markdown!), links: [] as string[] }));
    return { pages, complete: last.status === 'completed' };
  }
}
