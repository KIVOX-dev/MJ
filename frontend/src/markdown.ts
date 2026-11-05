import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Where the backend lives ("" = this site's own /api). Generated pictures are loaded from there. */
let imageBase = '';
export function setImageBase(url: string): void {
  imageBase = url.replace(/\/+$/, '');
}

const GENERATED = /^\/api\/images\/[a-f0-9]{32}$/;

// Replies come from an LLM that can be steered by web pages it read, so Markdown output is always sanitised.
// Links open safely, and the ONLY images allowed are MJ's own generated pictures (never a remote image that could track you).
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (n.tagName === 'IMG') {
    const src = n.getAttribute('src') ?? '';
    if (!GENERATED.test(src)) {
      n.remove();
      return;
    }
    n.setAttribute('src', imageBase + src);
    n.setAttribute('loading', 'lazy');
    n.setAttribute('decoding', 'async');
    n.setAttribute('class', 'gen-img');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'], FORBID_ATTR: ['style', 'srcset'] });
}
