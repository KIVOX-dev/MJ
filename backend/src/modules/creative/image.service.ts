import crypto from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../utils/logger';
import { GeneratedImageModel } from '../../models/image.model';
import type { ToolRegistry } from '../../core/tool-registry';
import { cleanSvg, renderSvg } from './svg';

export type Aspect = 'square' | 'landscape' | 'portrait';
const SIZES: Record<Aspect, [number, number]> = { square: [1024, 1024], landscape: [1344, 768], portrait: [768, 1344] };
const RATIOS: Record<Aspect, string> = { square: '1:1', landscape: '16:9', portrait: '9:16' };
const MAX_BYTES = 8_000_000;

export interface GeneratedImage {
  data: Buffer;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ImageProvider {
  name: string;
  generate(prompt: string, aspect: Aspect): Promise<GeneratedImage>;
}

/** The provider is busy or its free allowance is used up. `retryAfterSec` is a hint for the message to the user. */
export class ImageBusy extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterSec?: number,
  ) {
    super(`${provider} is busy${retryAfterSec ? ` (retry in ${retryAfterSec}s)` : ''}`);
  }
}

function sniff(b: Buffer): GeneratedImage['mime'] | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}

async function asImage(res: Response, provider: string): Promise<GeneratedImage> {
  const data = Buffer.from(await res.arrayBuffer());
  const mime = sniff(data);
  if (!mime) throw new Error(`${provider} did not return a picture`);
  return { data, mime };
}

/** Google Gemini image model: best quality and good at text inside pictures. Needs GEMINI_API_KEY (free key from Google AI Studio). */
export function geminiProvider(apiKey: string, fetchFn: typeof fetch = fetch): ImageProvider {
  return {
    name: 'gemini',
    async generate(prompt, aspect) {
      const res = await fetchFn('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: RATIOS[aspect] } } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) throw new ImageBusy('gemini');
      if (!res.ok) throw new Error(`gemini failed (${res.status})`);
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
      const b64 = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (!b64) throw new Error('gemini returned no picture');
      const data = Buffer.from(b64, 'base64');
      const mime = sniff(data);
      if (!mime) throw new Error('gemini did not return a picture');
      return { data, mime };
    },
  };
}

/**
 * FLUX.1-schnell on the official Black Forest Labs Hugging Face Space: a real FLUX picture for free (the Space runs on shared GPUs).
 * With HF_TOKEN the pictures count against your own free daily GPU allowance; when that is used up, or the Space is asleep or busy,
 * this engine reports "busy" and the next engine takes over.
 */
const FLUX_SPACE = 'https://black-forest-labs-flux-1-schnell.hf.space';

export function huggingFaceSpaceProvider(token: string, fetchFn: typeof fetch = fetch, space = FLUX_SPACE): ImageProvider {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    name: 'huggingface-flux',
    async generate(prompt, aspect) {
      const [width, height] = SIZES[aspect];
      const start = await fetchFn(`${space}/gradio_api/call/infer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: [prompt.slice(0, 900), 0, true, width, height, 4] }), // prompt, seed, random seed, size, steps
        signal: AbortSignal.timeout(30_000),
      });
      if (start.status === 429 || start.status === 503) throw new ImageBusy('huggingface-flux');
      if (!start.ok) throw new Error(`huggingface-flux failed (${start.status})`);
      const id = ((await start.json()) as { event_id?: string }).event_id;
      if (!id) throw new Error('huggingface-flux gave no job id');
      // the result arrives as a stream of events that ends when the picture is ready
      const done = await fetchFn(`${space}/gradio_api/call/infer/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      if (!done.ok) throw new Error(`huggingface-flux failed (${done.status})`);
      const events = [...(await done.text()).matchAll(/event: (\w+)\r?\ndata: (.*)/g)];
      const last = events[events.length - 1];
      if (!last || last[1] !== 'complete') {
        // "error" events carry the reason; a used-up GPU allowance or a full queue both mean "try again later"
        throw /quota|limit|queue|busy|exceeded/i.test(last?.[2] ?? '') || last?.[2] === 'null' ? new ImageBusy('huggingface-flux') : new Error('huggingface-flux could not make the picture');
      }
      let url: string | undefined;
      try {
        url = (JSON.parse(last[2] ?? '[]') as Array<{ url?: string }>)[0]?.url;
      } catch {
        /* handled below */
      }
      // only ever download from the Space itself
      if (!url || !url.startsWith(`${space}/gradio_api/file=`)) throw new Error('huggingface-flux returned no picture');
      const img = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error(`huggingface-flux picture download failed (${img.status})`);
      return asImage(img, 'huggingface-flux');
    },
  };
}

/** Pollinations: works with no key but adds a watermark and allows about one picture every 45 seconds. A (free) key removes the limits. */
export function pollinationsProvider(apiKey?: string, fetchFn: typeof fetch = fetch): ImageProvider {
  return {
    name: 'pollinations',
    async generate(prompt, aspect) {
      const [width, height] = SIZES[aspect];
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?width=${width}&height=${height}&model=flux&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
      const res = await fetchFn(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(90_000) });
      if (res.status === 402 || res.status === 429) {
        const body = await res.text().catch(() => '');
        const m = /retry after (\d+)s/i.exec(body);
        throw new ImageBusy('pollinations', m ? Number(m[1]) : 45);
      }
      if (!res.ok) throw new Error(`pollinations failed (${res.status})`);
      return asImage(res, 'pollinations');
    },
  };
}

const SVG_SYSTEM = (w: number, h: number) =>
  'You are a senior vector graphic designer. Reply with ONE complete SVG document and nothing else: no markdown, no explanation. ' +
  `Use viewBox="0 0 ${w} ${h}" width="${w}" height="${h}". Fill the whole canvas with a deliberate background (a gradient or a scene). ` +
  'Use only shapes, paths, groups, linearGradient/radialGradient, clipPath, opacity, transforms and simple filters (feGaussianBlur, feDropShadow). ' +
  'Never use <script>, <image>, <foreignObject>, external links or external fonts. ' +
  'Style: modern, polished, professional illustration: rich harmonious colours, depth with gradients, soft shadows and highlights, clear focal point, balanced composition, smooth curves, consistent stroke widths. ' +
  'Build recognisable subjects from several well-shaped layers (not a few plain circles). ' +
  'Any text must be spelled exactly as requested, short, large and readable, with font-family="DejaVu Sans, Arial, sans-serif" and text-anchor set so it stays inside the canvas.';

/**
 * Pictures drawn as vector graphics by a Groq language model, then rendered to PNG. Needs no extra account or key.
 * Great for logos, icons, posters, stickers, diagrams and illustrated scenes; it is not a photograph generator.
 */
export function groqSvgProvider(chat: (system: string, user: string) => Promise<string>, render: (svg: string) => Buffer = (v) => renderSvg(v)): ImageProvider {
  return {
    name: 'groq-vector',
    async generate(prompt, aspect) {
      const [w, h] = aspect === 'square' ? [1024, 1024] : aspect === 'landscape' ? [1344, 768] : [768, 1344];
      let lastErr = 'no drawing';
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await chat(SVG_SYSTEM(w, h), attempt ? `${prompt}\n\n(The previous attempt was not valid SVG: ${lastErr}. Return a complete, valid, well-formed SVG.)` : prompt);
        const svg = cleanSvg(reply);
        if (!svg) {
          lastErr = 'no <svg> document found';
          continue;
        }
        try {
          const data = render(svg);
          const mime = sniff(data);
          if (mime) return { data, mime };
          lastErr = 'could not render';
        } catch (err) {
          lastErr = (err as Error).message.slice(0, 120);
        }
      }
      throw new Error(`vector drawing failed (${lastErr})`);
    },
  };
}

export interface ImageStore {
  save(img: GeneratedImage, prompt: string): Promise<string>;
  get(id: string): Promise<GeneratedImage | undefined>;
}

export class MongoImageStore implements ImageStore {
  async save(img: GeneratedImage, prompt: string): Promise<string> {
    const imageId = crypto.randomBytes(16).toString('hex');
    await GeneratedImageModel.create({ imageId, mime: img.mime, data: img.data, prompt: prompt.slice(0, 1000) });
    return imageId;
  }
  async get(id: string): Promise<GeneratedImage | undefined> {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
    const d = await GeneratedImageModel.findOne({ imageId: id });
    if (!d) return undefined;
    const data = binaryToBuffer(d.data);
    return data.length ? { data, mime: d.mime as GeneratedImage['mime'] } : undefined;
  }
}

/** MongoDB hands binary data back as a Buffer (normal documents) or a BSON Binary (lean queries). Both must become real bytes. */
export function binaryToBuffer(x: unknown): Buffer {
  if (Buffer.isBuffer(x)) return x;
  const bin = x as { buffer?: Uint8Array; position?: number } | null;
  if (bin?.buffer instanceof Uint8Array) return Buffer.from(bin.buffer.subarray(0, bin.position ?? bin.buffer.length));
  return x instanceof Uint8Array ? Buffer.from(x) : Buffer.alloc(0);
}

export class ImageService {
  private count = { day: '', n: 0 };

  constructor(
    /** Tried in order: best quality first. */
    private readonly providers: ImageProvider[],
    private readonly store: ImageStore,
    private readonly dailyLimit = 40,
    private readonly now: () => number = Date.now,
  ) {}

  get providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  async generate(prompt: string, aspect: Aspect = 'square'): Promise<{ id: string; provider: string }> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.count.day !== day) this.count = { day, n: 0 };
    if (this.count.n >= this.dailyLimit) throw new Error(`The daily limit of ${this.dailyLimit} pictures has been reached. Please try again tomorrow.`);
    let busy: ImageBusy | undefined;
    for (const p of this.providers) {
      try {
        const img = await p.generate(prompt, aspect);
        if (img.data.length > MAX_BYTES) throw new Error('picture too large');
        const id = await this.store.save(img, prompt);
        this.count.n++;
        return { id, provider: p.name };
      } catch (err) {
        if (err instanceof ImageBusy) busy = busy ?? err;
        logger.warn({ provider: p.name, err: { message: (err as Error).message } }, 'Image provider failed');
      }
    }
    throw new Error(
      busy
        ? `The picture service is busy${busy.retryAfterSec ? `, please try again in about ${busy.retryAfterSec} seconds` : ', please try again in a minute'}.`
        : 'I could not create that picture right now. Please try again in a moment.',
    );
  }
}

/** The tool the assistant calls. It must be given a rich English prompt, which is what makes the pictures look good. */
export function registerImageTools(registry: ToolRegistry, svc: ImageService): void {
  const vectorOnly = svc.providerNames.every((n) => n === 'groq-vector');
  registry.register({
    name: 'generate_image',
    description:
      'Create a picture. Use when Sir asks to draw, design, generate or make an image, picture, logo, poster, wallpaper, illustration, avatar, sticker, cartoon or art. ' +
      (vectorOnly
        ? 'Pictures are clean vector illustrations (not photographs): describe a logo, icon, poster, sticker, diagram, cartoon or illustrated scene, with the subject, its parts, a colour palette, mood and composition. If Sir wants a real photograph, say honestly that you draw illustrations and offer that instead. '
        : 'First turn his request into ONE rich English prompt (under 120 words): the subject, setting, art style (photorealistic, 3D render, flat vector, watercolor, anime, oil painting...), lighting, colours, camera or composition and mood. ') +
      'Put any words that must appear inside the picture in double quotes. Choose aspect: square (default, logos, avatars), landscape (wallpapers, scenes) or portrait (posters, phone wallpapers).',
    schema: z.object({
      prompt: z.string().trim().min(3).max(1200).describe('Detailed English description of the picture'),
      aspect: z.enum(['square', 'landscape', 'portrait']).default('square'),
    }),
    async run(args, ctx) {
      if (!ctx.onImage) throw new Error('This chat cannot show pictures. Pictures work in the MJ app and in Telegram.');
      const { id, provider } = await svc.generate(args.prompt, args.aspect);
      ctx.onImage(id);
      return {
        image_id: id,
        provider,
        note: 'The finished picture is shown to Sir automatically under your reply. Reply in one or two short sentences describing what you made and offer to adjust it. Do not write any link or markdown image.',
      };
    },
  });
}
