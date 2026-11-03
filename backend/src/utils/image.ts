const MAX_BYTES = 700_000;
const TIMEOUT_MS = 6000;

/** Only public http(s) URLs: blocks localhost / private-range IP literals so feeds cannot point us at internal services. */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\[/.test(h) || h.includes(':')) return false; // IPv6 literals
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** BBC thumbnails in RSS are 240px wide; the same asset is served at larger widths. */
function candidates(url: string): string[] {
  const upgraded = url.replace(/\/standard\/\d+\//, '/standard/800/').replace(/\/news\/\d+\//, '/news/800/');
  return upgraded !== url ? [upgraded, url] : [url];
}

/**
 * Downloads a news image for the PDF. Returns undefined (never throws) when the image is unsafe, too large,
 * slow, or not a JPEG/PNG (the formats the PDF library can embed).
 */
export async function fetchImage(url: string, fetchFn: typeof fetch = fetch): Promise<Buffer | undefined> {
  for (const candidate of candidates(url)) {
    if (!isPublicHttpUrl(candidate)) continue;
    try {
      const res = await fetchFn(candidate, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MJ-Assistant/0.1)', Accept: 'image/jpeg,image/png,*/*;q=0.5' },
      });
      if (!res.ok) continue;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES || (!isJpeg(buf) && !isPng(buf))) continue;
      return buf;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}
