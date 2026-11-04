/** `unpdf` is ESM-only and this project compiles to CommonJS, so load it with a native dynamic import. */
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

let loadUnpdf: () => Promise<any> = () => nativeImport('unpdf');
/** Lets the test runner (which cannot evaluate a native dynamic import) supply its own loader. */
export function setPdfLoader(loader: () => Promise<any>): void {
  loadUnpdf = loader;
}

export const MAX_DOC_BYTES = 10_000_000;
export const MAX_DOC_CHARS = 12_000;

export interface ExtractedDoc {
  text: string;
  pages: number;
  truncated: boolean;
}

const isPdf = (b: Buffer) => b.length > 5 && b.subarray(0, 5).toString() === '%PDF-';

/** Text of a PDF (not OCR: scanned image-only PDFs yield no text). Throws readable errors. */
export async function extractPdfText(buf: Buffer, maxChars = MAX_DOC_CHARS): Promise<ExtractedDoc> {
  if (!isPdf(buf)) throw new Error('That file is not a valid PDF');
  if (buf.length > MAX_DOC_BYTES) throw new Error('That PDF is too large (limit 10 MB)');
  let result: { totalPages: number; text: string };
  try {
    const { extractText, getDocumentProxy } = await loadUnpdf();
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    result = await extractText(pdf, { mergePages: true });
  } catch {
    throw new Error('I could not read that PDF (it may be damaged or password-protected)');
  }
  const text = result.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, maxChars), pages: result.totalPages, truncated: text.length > maxChars };
}

/** Plain-text file: decoded as UTF-8, capped. */
export function extractPlainText(buf: Buffer, maxChars = MAX_DOC_CHARS): ExtractedDoc {
  if (buf.length > MAX_DOC_BYTES) throw new Error('That file is too large (limit 10 MB)');
  const text = buf.toString('utf8').replace(/\u0000/g, '').trim();
  return { text: text.slice(0, maxChars), pages: 1, truncated: text.length > maxChars };
}
