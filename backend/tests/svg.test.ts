import { describe, expect, it, vi } from 'vitest';
import { cleanSvg, renderSvg } from '../src/modules/creative/svg';
import { ImageService, groqSvgProvider, registerImageTools, type ImageStore } from '../src/modules/creative/image.service';
import { ToolRegistry } from '../src/core/tool-registry';

const GOOD =
  '<svg viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f0c"/><stop offset="1" stop-color="#06f"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="30" fill="#fff"/></svg>';

describe('cleanSvg', () => {
  it('extracts the drawing from markdown fences and chatter, and adds the namespace', () => {
    const svg = cleanSvg('Here you go:\n```svg\n' + GOOD + '\n```\nEnjoy!');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('<circle');
    expect(cleanSvg('no drawing here')).toBeUndefined();
  });

  it('removes scripts, event handlers, embedded content and every external reference', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><image href="http://evil.example/a.png"/>' +
      '<rect width="10" height="10" onclick="steal()" fill="url(http://evil.example/p)"/><a xlink:href="https://evil.example"><circle r="3"/></a><use href="#ok"/><style>@import url(http://evil.example/x.css)</style></svg>';
    const svg = cleanSvg(dirty)!;
    for (const bad of ['script', 'foreignObject', '<image', 'onclick', 'evil.example', '<style', 'alert']) expect(svg).not.toContain(bad);
    expect(svg).toContain('<use href="#ok"'); // references to the drawing's own parts stay
  });
});

describe('renderSvg', () => {
  it('renders a drawing to a PNG of the requested width', () => {
    const png = renderSvg(GOOD, 512);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(500);
  });
  it('throws on a broken drawing', () => {
    expect(() => renderSvg('<svg><rect')).toThrow();
  });
});

describe('groqSvgProvider', () => {
  it('asks the model for SVG sized to the aspect and returns the rendered picture', async () => {
    const chat = vi.fn().mockResolvedValue('```svg\n' + GOOD + '\n```');
    const out = await groqSvgProvider(chat).generate('a purple circle', 'landscape');
    expect(out.mime).toBe('image/png');
    const [system, user] = chat.mock.calls[0]!;
    expect(system).toContain('viewBox="0 0 1344 768"');
    expect(user).toBe('a purple circle');
  });

  it('tries once more when the first answer is not a valid drawing, then gives up clearly', async () => {
    const chat = vi.fn().mockResolvedValueOnce('Sorry, I cannot draw.').mockResolvedValueOnce(GOOD);
    expect((await groqSvgProvider(chat).generate('x', 'square')).mime).toBe('image/png');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]![1]).toMatch(/not valid SVG/);
    await expect(groqSvgProvider(vi.fn().mockResolvedValue('nothing')).generate('x', 'square')).rejects.toThrow(/vector drawing failed/);
  });
});

describe('generate_image tool with only the Groq drawing engine', () => {
  const store: ImageStore = { save: async () => 'e'.repeat(32), get: async () => undefined };
  it('tells the assistant these are illustrations, not photographs', () => {
    const registry = new ToolRegistry();
    registerImageTools(registry, new ImageService([groqSvgProvider(vi.fn())], store));
    const spec = registry.specs().find((s) => s.function.name === 'generate_image')!;
    expect(spec.function.description).toMatch(/vector illustrations \(not photographs\)/);
  });
  it('asks for photo-style prompts when a photo-capable engine is configured', () => {
    const registry = new ToolRegistry();
    registerImageTools(registry, new ImageService([{ name: 'gemini', generate: vi.fn() }, groqSvgProvider(vi.fn())], store));
    expect(registry.specs().find((s) => s.function.name === 'generate_image')!.function.description).toMatch(/photorealistic/);
  });
});
