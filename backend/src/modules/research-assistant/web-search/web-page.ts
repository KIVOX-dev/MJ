import { isPublicHttpUrl } from '../../../utils/image';

export interface PageContent {
  url: string;
  title?: string;
  description?: string;
  text: string;
  truncated: boolean;
}

/** Sites that refuse automated access and forbid scraping in their terms: we do not try to read them. */
const BLOCKED = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com'];
const MAX_TEXT = 6000;
const MAX_BYTES = 2_000_000;

const blockedHost = (host: string) => BLOCKED.find((b) => host === b || host.endsWith(`.${b}`));

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
  if (!res.ok) {
    const hint = [401, 403, 429, 999].includes(res.status) ? ' (the site blocks automated access)' : '';
    throw new Error(`The site returned HTTP ${res.status}${hint}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text\/plain/i.test(type)) throw new Error('That link is not a readable web page');
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('That page is too large to read');
  const raw = (await res.text()).slice(0, 600_000);
  const { title, description, text } = /html/i.test(type) ? htmlToText(raw) : { title: undefined, description: undefined, text: raw };
  const clipped = text.slice(0, MAX_TEXT);
  return { url: res.url || url, title, description, text: clipped, truncated: text.length > MAX_TEXT };
}
