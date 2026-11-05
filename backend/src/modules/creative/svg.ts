import { Resvg } from '@resvg/resvg-js';

/**
 * SVG written by the language model is untrusted: keep only what is needed to draw, and drop anything that could run code
 * or fetch something from the network. (The result is rendered to a PNG here and only the PNG is ever shown or sent.)
 */
export function cleanSvg(raw: string): string | undefined {
  const fenced = raw.replace(/```(?:svg|xml)?/gi, '');
  const start = fenced.search(/<svg[\s>]/i);
  const end = fenced.toLowerCase().lastIndexOf('</svg>');
  if (start < 0 || end < start) return undefined;
  let svg = fenced.slice(start, end + 6);
  svg = svg
    .replace(/<\s*(script|foreignObject|iframe|image|audio|video|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|image|audio|video|object|embed|style)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '') // keep only #fragment references (gradients, clips)
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');
  if (!/xmlns\s*=/.test(svg.slice(0, 300))) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg.length > 400_000 ? undefined : svg;
}

/** Renders SVG to a PNG about `width` px wide. Throws if the drawing is invalid. */
export function renderSvg(svg: string, width = 1024): Buffer {
  const withNs = /xmlns\s*=/.test(svg.slice(0, 300)) ? svg : svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const resvg = new Resvg(withNs, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(255,255,255,1)',
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  });
  return Buffer.from(resvg.render().asPng());
}
