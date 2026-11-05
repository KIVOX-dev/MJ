import type { Attachment } from './api';

export interface Pending extends Attachment {
  id: string;
  /** A small preview of a photo, for the chip above the message box. */
  preview?: string;
  size: number;
}

export const MAX_FILES = 4;
const MAX_PDF = 6_000_000;
const MAX_TEXT = 2_000_000;
const MAX_PHOTO_BYTES = 3_000_000;
let n = 0;

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('I could not read that file.'));
    r.readAsDataURL(blob);
  });

/** Shrinks a photo to at most 1600 px and re-encodes it as JPEG so it uploads fast and fits the AI model's limits. */
async function preparePhoto(file: File): Promise<Pending> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`"${file.name}": I can read JPEG and PNG photos only.`);
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process photos.');
  ctx.fillStyle = '#ffffff'; // PNGs with transparency
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  let blob: Blob | null = null;
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX_PHOTO_BYTES) break;
  }
  if (!blob || blob.size > MAX_PHOTO_BYTES) throw new Error(`"${file.name}" is too large. Please choose a smaller photo.`);
  const thumb = document.createElement('canvas');
  const ts = 96 / Math.max(w, h);
  thumb.width = Math.max(1, Math.round(w * ts));
  thumb.height = Math.max(1, Math.round(h * ts));
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const name = /\.(jpe?g|png)$/i.test(file.name) ? file.name.replace(/\.png$/i, '.jpg') : `${file.name || 'photo'}.jpg`;
  return { id: `f${Date.now()}-${n++}`, name, mime: 'image/jpeg', data: await toBase64(blob), preview: thumb.toDataURL('image/jpeg', 0.7), size: blob.size };
}

/** Turns a chosen file into something the server accepts, or throws a message to show to the user. */
export async function prepareFile(file: File): Promise<Pending> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isText = file.type === 'text/plain' || /\.txt$/i.test(file.name);
  if (file.type.startsWith('image/')) return preparePhoto(file);
  if (isPdf) {
    if (file.size > MAX_PDF) throw new Error(`"${file.name}" is over 6 MB. Please choose a smaller PDF.`);
  } else if (isText) {
    if (file.size > MAX_TEXT) throw new Error(`"${file.name}" is over 2 MB. Please choose a smaller file.`);
  } else {
    throw new Error(`"${file.name}": I can read photos, PDFs and text files.`);
  }
  return { id: `f${Date.now()}-${n++}`, name: file.name, mime: isPdf ? 'application/pdf' : 'text/plain', data: await toBase64(file), size: file.size };
}

export const kb = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
