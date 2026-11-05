import crypto from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../utils/logger';
import { GeneratedImageModel } from '../../models/image.model';
import type { ToolRegistry } from '../../core/tool-registry';

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

/** Hugging Face FLUX.1: very good quality with a free monthly allowance. Needs HF_TOKEN (free access token). */
export function huggingFaceProvider(token: string, fetchFn: typeof fetch = fetch): ImageProvider {
  return {
    name: 'huggingface',
    async generate(prompt, aspect) {
      const [width, height] = SIZES[aspect];
      const res = await fetchFn('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'image/png' },
        body: JSON.stringify({ inputs: prompt, parameters: { width, height, num_inference_steps: 4 } }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429 || res.status === 402) throw new ImageBusy('huggingface');
      if (!res.ok) throw new Error(`huggingface failed (${res.status})`);
      return asImage(res, 'huggingface');
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
    const d = await GeneratedImageModel.findOne({ imageId: id }).lean();
    return d ? { data: Buffer.from(d.data as unknown as Uint8Array), mime: d.mime as GeneratedImage['mime'] } : undefined;
  }
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
  registry.register({
    name: 'generate_image',
    description:
      'Create a picture. Use when Sir asks to draw, design, generate or make an image, picture, logo, poster, wallpaper, illustration, avatar, sticker, cartoon or art. ' +
      'First turn his request into ONE rich English prompt (under 120 words): the subject, setting, art style (photorealistic, 3D render, flat vector, watercolor, anime, oil painting...), lighting, colours, camera or composition and mood. ' +
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
