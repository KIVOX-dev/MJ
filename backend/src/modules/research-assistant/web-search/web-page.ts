import { isPublicHttpUrl } from '../../../utils/image';

export interface PageLink {
  text: string;
  url: string;
}

export interface PageContent {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** Main image of the page (Open Graph), if any. */
  image?: string;
  /** Compact summary of schema.org JSON-LD data (articles, people, products...), if present. */
  structured?: string;
  /** Links found on the page, so a follow-up read_url call can open one of them. */
  links: PageLink[];
  text: string;
  truncated: boolean;
}

/** Sites that refuse automated access and forbid scraping in their terms: we do not try to read them. */
const BLOCKED = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com'];
const MAX_TEXT = 6000;
const MAX_BYTES = 2_000_000;

export const blockedHost = (host: string) => BLOCKED.find((b) => host === b || host.endsWith(`.${b}`));

/** The single gate every web reader/crawler must pass: public http(s) only, and never the sites that forbid scraping. */
export function assertReadableUrl(url: string): URL {
  if (!isPublicHttpUrl(url)) throw new Error('That is not a public http(s) link');
  const u = new URL(url);
  const blocked = blockedHost(u.hostname.toLowerCase());
  if (blocked) {
    throw new Error(`${blocked} does not allow automated access and its terms forbid scraping, so I cannot read that link. Please paste the text you want me to use.`);
  }
  return u;
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  const c = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return c ? decode(c).trim() || undefined : undefined;
}

/** Plain-text view of an HTML page: no scripts, styles or navigation. Dependency-free and intentionally simple. */
export function htmlToText(html: string): { title?: string; description?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description = meta(html, 'og:description') ?? meta(html, 'description');
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l)) // drop empty lines and stray punctuation, keep short real content
    .join('\n');
  return { title: title ? decode(title).replace(/\s+/g, ' ').trim() : undefined, description, text };
}

/** Absolute http(s) links on the page with their visible text (max 25, de-duplicated). */
export function extractLinks(html: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decode(m[1]!), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    url.hash = '';
    const text = decode(m[2]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 90);
    if (text.length < 2 || seen.has(url.href) || url.href === base) continue;
    seen.add(url.href);
    out.push({ text, url: url.href });
    if (out.length >= 25) break;
  }
  return out;
}

const LD_KEYS = ['@type', 'name', 'headline', 'description', 'jobTitle', 'worksFor', 'alumniOf', 'address', 'datePublished', 'author', 'url', 'sameAs', 'knowsAbout', 'organization'];

/** Short summary of JSON-LD (schema.org) blocks: often the cleanest facts on a page (articles, people, companies). */
export function extractStructured(html: string): string | undefined {
  const parts: string[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : ((data as { '@graph'?: unknown[] })?.['@graph'] ?? [data]);
    for (const n of nodes as Array<Record<string, unknown>>) {
      if (!n || typeof n !== 'object') continue;
      const picked: Record<string, unknown> = {};
      for (const k of LD_KEYS) if (n[k] !== undefined) picked[k] = n[k];
      if (Object.keys(picked).length > 1) parts.push(JSON.stringify(picked, (_k, v) => (typeof v === 'string' ? v.slice(0, 200) : v)));
    }
  }
  return parts.length ? parts.join('\n').slice(0, 1800) : undefined;
}

/** Reads one public web page (read-only GET). Never throws anything but readable, user-safe messages. */
export async function fetchPage(url: string, fetchFn: typeof fetch = fetch): Promise<PageContent> {
  if (!isPublicHttpUrl(url)) throw new Error('That is not a public http(s) link');
  const host = new URL(url).hostname.toLowerCase();
  const blocked = blockedHost(host);
  if (blocked) {
    throw new Error(`${blocked} does not allow automated access and its terms forbid scraping, so I cannot read that link. Please paste the text you want me to use.`);
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MJ-Assistant/0.1)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
    });
  } catch {
    throw new Error('The page did not respond in time');
  }
  if (res.url && !isPublicHttpUrl(res.url)) throw new Error('The link redirected somewhere I cannot open');
  if (res.url && blockedHost(new URL(res.url).hostname.toLowerCase())) throw new Error('That link redirects to a site that does not allow automated access');
  if (!res.ok) {
    const hint = [401, 403, 429, 999].includes(res.status) ? ' (the site blocks automated access)' : '';
    throw new Error(`The site returned HTTP ${res.status}${hint}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text\/plain/i.test(type)) throw new Error('That link is not a readable web page');
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('That page is too large to read');
  const raw = (await res.text()).slice(0, 600_000);
  const finalUrl = res.url || url;
  const isHtml = /html/i.test(type);
  const { title, description, text } = isHtml ? htmlToText(raw) : { title: undefined, description: undefined, text: raw };
  const clipped = text.slice(0, MAX_TEXT);
  return {
    url: finalUrl,
    title,
    description,
    siteName: isHtml ? meta(raw, 'og:site_name') : undefined,
    image: isHtml ? meta(raw, 'og:image') : undefined,
    structured: isHtml ? extractStructured(raw) : undefined,
    links: isHtml ? extractLinks(raw, finalUrl) : [],
    text: clipped,
    truncated: text.length > MAX_TEXT,
  };
}
