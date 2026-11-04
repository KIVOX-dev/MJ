import { describe, expect, it, vi } from 'vitest';
import { renderEmailHtml } from '../src/modules/communication-manager/email/template';
import { BrevoClient } from '../src/modules/communication-manager/email/brevo.client';

describe('renderEmailHtml', () => {
  it('escapes everything the model wrote (no HTML or script injection)', () => {
    const h = renderEmailHtml('<b>Hi</b>', '<script>alert(1)</script> & "quoted" <img src=x onerror=y>');
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('&amp;');
  });

  it('turns paragraphs, bullets, numbered lists, bold and links into markup', () => {
    const h = renderEmailHtml('Plan', 'First paragraph with **bold**.\n\n- one\n- two\n\n1. a\n2. b\n\nSee https://example.com/page.');
    expect(h).toContain('<strong>bold</strong>');
    expect(h.match(/<li /g)).toHaveLength(4);
    expect(h).toContain('<ul ');
    expect(h).toContain('<ol ');
    expect(h).toContain('href="https://example.com/page"');
  });

  it('only renders a button for http(s) urls and ignores javascript: links', () => {
    expect(renderEmailHtml('x', 'y', { button: { label: 'Open', url: 'https://a.com' } })).toContain('href="https://a.com"');
    expect(renderEmailHtml('x', 'y', { button: { label: 'Open', url: 'javascript:alert(1)' } })).not.toContain('javascript:');
  });
});

describe('BrevoClient html', () => {
  it('sends both text and html content', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messageId: 'm1' }) });
    await new BrevoClient({ apiKey: 'k', senderEmail: 's@x.com', senderName: 'MJ' }, f as unknown as typeof fetch).send('o@x.com', 'S', 'plain', [], '<p>hi</p>');
    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body.textContent).toBe('plain');
    expect(body.htmlContent).toBe('<p>hi</p>');
  });
});

describe('assistant knows about the email tool', () => {
  it('only claims it can email when email_me is loaded', async () => {
    const { Agent } = await import('../src/core/orchestrator/assistant');
    const { ToolRegistry } = await import('../src/core/tool-registry');
    const { z } = await import('zod');
    const run = async (withEmail: boolean) => {
      const registry = new ToolRegistry();
      registry.register({ name: 'get_news', description: 'n', schema: z.object({}), run: async () => ({}) });
      if (withEmail) registry.register({ name: 'email_me', description: 'e', schema: z.object({}), run: async () => ({}) });
      let system = '';
      const ai = {
        chat: vi.fn(async (m: Array<{ role: string; content: string }>) => {
          system = m[0]!.content;
          return { content: 'Sir, ok.', toolCalls: [] };
        }),
        complete: vi.fn(),
      };
      const agent = new Agent({ ai: ai as never, store: { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [{ direction: 'in', text: 'hi' }] }, registry, timezone: 'Asia/Kolkata' });
      await agent.respond('hi', { channel: 'telegram', chatId: '1' });
      return system;
    };
    expect(await run(false)).toMatch(/can NOT yet send emails/);
    const withEmail = await run(true);
    expect(withEmail).not.toMatch(/can NOT yet send emails/);
    expect(withEmail).toMatch(/CAN email the user/);
  });
});
