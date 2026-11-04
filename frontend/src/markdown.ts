import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Replies come from an LLM that can be steered by web pages it read, so Markdown output is always sanitised.
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'img'], FORBID_ATTR: ['style'] });
}
