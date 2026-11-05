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

describe('emailing other people needs confirmation', () => {
  async function setup(dailyLimit?: number) {
    const { ToolRegistry } = await import('../src/core/tool-registry');
    const { registerEmailTools } = await import('../src/modules/communication-manager/email/email.tools');
    const send = vi.fn().mockResolvedValue({ messageId: 'm1' });
    const registry = new ToolRegistry();
    registerEmailTools(registry, { send } as never, 'owner@example.com', { dailyLimit });
    const ctx = (turnId: string) => ({ channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date(), turnId });
    const run = (name: string, args: unknown, turn: string) => registry.execute(name, JSON.stringify(args), ctx(turn));
    return { send, run };
  }
  const draftArgs = { to: 'Friend@Example.com', subject: 'Hello', body: 'hi hello' };

  it('a draft sends nothing, and cannot be confirmed in the same turn', async () => {
    const { send, run } = await setup();
    const d = await run('draft_email', draftArgs, 'turn-1');
    expect(d).toMatchObject({ ok: true, status: 'draft_saved_not_sent', to: 'Friend@Example.com' });
    expect(send).not.toHaveBeenCalled();
    const sameTurn = await run('send_drafted_email', { draft_id: (d as unknown as { draft_id: string }).draft_id }, 'turn-1');
    expect(sameTurn.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends in a later turn with reply-to the owner and a neutral email for the recipient', async () => {
    const { send, run } = await setup();
    const d = (await run('draft_email', draftArgs, 'turn-1')) as unknown as { draft_id: string };
    const sent = await run('send_drafted_email', { draft_id: d.draft_id }, 'turn-2');
    expect(sent).toMatchObject({ ok: true, sent_to: 'friend@example.com' });
    const [to, subject, text, , html, opts] = send.mock.calls[0]!;
    expect([to, subject, text]).toEqual(['friend@example.com', 'Hello', 'hi hello']);
    expect(opts).toEqual({ replyTo: 'owner@example.com' });
    expect(html).not.toContain('Good day, Sir');
    expect(html).toContain('on behalf of its owner');
    // a draft can only be sent once
    expect((await run('send_drafted_email', { draft_id: d.draft_id }, 'turn-3')).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects bad addresses, unknown drafts, and enforces the daily limit', async () => {
    const { send, run } = await setup(1);
    expect((await run('draft_email', { ...draftArgs, to: 'not-an-email' }, 't1')).ok).toBe(false);
    expect((await run('send_drafted_email', { draft_id: 'deadbeef' }, 't2')).ok).toBe(false);
    const a = (await run('draft_email', draftArgs, 't3')) as unknown as { draft_id: string };
    expect((await run('send_drafted_email', { draft_id: a.draft_id }, 't4')).ok).toBe(true);
    const b = (await run('draft_email', draftArgs, 't5')) as unknown as { draft_id: string };
    const limited = (await run('send_drafted_email', { draft_id: b.draft_id }, 't6')) as { ok: boolean; error?: string };
    expect(limited.ok).toBe(false);
    expect(limited.error).toMatch(/daily limit/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tells the assistant it can email others only with confirmation', async () => {
    const { Agent } = await import('../src/core/orchestrator/assistant');
    const { ToolRegistry } = await import('../src/core/tool-registry');
    const { registerEmailTools } = await import('../src/modules/communication-manager/email/email.tools');
    const registry = new ToolRegistry();
    registerEmailTools(registry, { send: vi.fn() } as never, 'o@example.com');
    let system = '';
    const ai = { chat: vi.fn(async (m: Array<{ content: string }>) => ((system = m[0]!.content), { content: 'Sir, ok.', toolCalls: [] })), complete: vi.fn() };
    const agent = new Agent({ ai: ai as never, store: { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [{ direction: 'in', text: 'hi' }] }, registry, timezone: 'Asia/Kolkata' });
    await agent.respond('hi', { channel: 'telegram', chatId: '1' });
    expect(system).toMatch(/draft_email/);
    expect(system).toMatch(/NEW message/);
  });
});
