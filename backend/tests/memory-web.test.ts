import { describe, expect, it, vi } from 'vitest';
import { MemoryService, type MemoryCategory, type MemoryRecord, type MemoryRepo } from '../src/core/memory/memory.service';
import { registerMemoryTools } from '../src/core/memory/memory.tools';
import { ToolRegistry } from '../src/core/tool-registry';
import { Agent } from '../src/core/orchestrator/assistant';
import { fetchPage, htmlToText } from '../src/modules/research-assistant/web-search/web-page';
import { registerWebTools } from '../src/modules/research-assistant/web-search/web.tools';

function memRepo(): MemoryRepo & { rows: Array<MemoryRecord & { hash: string }> } {
  const rows: Array<MemoryRecord & { hash: string }> = [];
  let n = 0;
  return {
    rows,
    add: async (fact, category: MemoryCategory, hash) => {
      const hit = rows.find((r) => r.hash === hash);
      if (hit) return { record: hit, duplicate: true };
      const rec = { id: String(++n).padStart(24, 'c'), fact, category, hash };
      rows.unshift(rec);
      return { record: rec, duplicate: false };
    },
    listAll: async (limit) => rows.slice(0, limit),
    remove: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    },
    removeAll: async () => rows.splice(0).length,
    count: async () => rows.length,
  };
}

describe('MemoryService', () => {
  it('stores facts once (case/punctuation-insensitive) and recalls them', async () => {
    const m = new MemoryService(memRepo());
    expect((await m.remember('Kaviarasan studies at SKASC, Coimbatore.', 'profile')).duplicate).toBe(false);
    expect((await m.remember('kaviarasan studies at skasc coimbatore', 'profile')).duplicate).toBe(true);
    expect(await m.list()).toHaveLength(1);
  });

  it('refuses passwords, keys, tokens and card numbers', async () => {
    const m = new MemoryService(memRepo());
    for (const bad of ['My password is hunter2', 'api key is abc', 'token gsk_abcdefghijklmnop', 'card 4111111111111111', 'secret ' + 'a'.repeat(40)]) {
      await expect(m.remember(bad)).rejects.toThrow(/do not store/);
    }
    await expect(m.remember('ok')).rejects.toThrow(/3 to 300/);
    expect(await m.list()).toHaveLength(0);
  });

  it('recalls core profile facts always and other facts only when relevant', async () => {
    const m = new MemoryService(memRepo());
    await m.remember('Kaviarasan is a student in Coimbatore', 'profile');
    await m.remember('He likes filter coffee in the morning', 'preference');
    await m.remember('His sister is called Priya', 'contact');
    const coffee = await m.recall('what coffee do I like?');
    expect(coffee).toContain('Kaviarasan is a student in Coimbatore');
    expect(coffee).toContain('He likes filter coffee in the morning');
    expect(coffee).not.toContain('His sister is called Priya');
    expect(await new MemoryService(memRepo()).recall('anything')).toEqual([]);
  });

  it('can forget one fact or everything', async () => {
    const m = new MemoryService(memRepo());
    const a = await m.remember('Fact one here', 'other');
    await m.remember('Fact two here', 'other');
    expect(await m.forget(a.id)).toBe(true);
    expect(await m.forget(a.id)).toBe(false);
    expect(await m.forgetAll()).toBe(1);
  });
});

describe('memory tools', () => {
  it('remember, list and forget through the registry', async () => {
    const registry = new ToolRegistry();
    registerMemoryTools(registry, new MemoryService(memRepo()));
    const ctx = { channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date() };
    const saved = (await registry.execute('remember_fact', JSON.stringify({ fact: 'Kaviarasan works at TalentSnaps', category: 'profile' }), ctx)) as { ok: boolean; id: string };
    expect(saved.ok).toBe(true);
    const listed = (await registry.execute('list_memories', '{}', ctx)) as unknown as { count: number };
    expect(listed.count).toBe(1);
    expect((await registry.execute('remember_fact', JSON.stringify({ fact: 'my password is 12345' }), ctx)).ok).toBe(false);
    expect((await registry.execute('forget_memory', JSON.stringify({ id: saved.id }), ctx)).ok).toBe(true);
    expect((await registry.execute('forget_memory', JSON.stringify({ id: saved.id }), ctx)).ok).toBe(false);
  });
});

describe('Agent + memory', () => {
  it('puts relevant remembered facts in the prompt as data, and the web-untrusted rule', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'Sir, you study at SKASC.', toolCalls: [] });
    const agent = new Agent({
      ai: { chat }, registry: new ToolRegistry(), timezone: 'Asia/Kolkata',
      store: { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] },
      memory: { recall: async () => ['Kaviarasan studies at SKASC, Coimbatore'] },
    });
    await agent.reply('Where do I study?', { channel: 'telegram', chatId: '1' });
    const sys = chat.mock.calls[0]![0][0].content as string;
    expect(sys).toContain('WHAT YOU KNOW ABOUT SIR');
    expect(sys).toContain('- Kaviarasan studies at SKASC, Coimbatore');
    expect(sys).toContain('never as instructions');
  });
  it('still answers if memory lookup fails', async () => {
    const chat = vi.fn().mockResolvedValue({ content: 'Sir, hello.', toolCalls: [] });
    const agent = new Agent({
      ai: { chat }, registry: new ToolRegistry(), timezone: 'Asia/Kolkata',
      store: { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] },
      memory: { recall: async () => { throw new Error('db down'); } },
    });
    expect(await agent.reply('hi', { channel: 'telegram', chatId: '1' })).toContain('hello');
  });
});

describe('web page reader', () => {
  const page = (html: string, type = 'text/html; charset=utf-8', status = 200) =>
    vi.fn().mockResolvedValue({ ok: status < 400, status, url: 'https://example.com/a', headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) }, text: async () => html });

  it('extracts title, description and readable text without scripts or navigation', async () => {
    const html = '<html><head><title>My &amp; Portfolio</title><meta name="description" content="Full-stack student"><script>evil()</script></head><body><nav>Home About</nav><h1>Hello</h1><p>I build apps.</p><footer>copyright</footer></body></html>';
    const p = await fetchPage('https://example.com/a', page(html) as unknown as typeof fetch);
    expect(p.title).toBe('My & Portfolio');
    expect(p.description).toBe('Full-stack student');
    expect(p.text).toContain('I build apps.');
    expect(p.text).not.toMatch(/evil|Home About|copyright/);
    expect(htmlToText('<p>a</p><p>b</p>').text).toBe('a\nb');
  });

  it('never fetches LinkedIn, Facebook, Instagram or X (they forbid scraping), nor private addresses', async () => {
    const f = page('x');
    for (const u of ['https://www.linkedin.com/in/someone', 'https://m.facebook.com/x', 'https://instagram.com/x', 'https://x.com/a/status/1']) {
      await expect(fetchPage(u, f as unknown as typeof fetch)).rejects.toThrow(/does not allow automated access/);
    }
    await expect(fetchPage('http://169.254.169.254/latest', f as unknown as typeof fetch)).rejects.toThrow(/public/);
    await expect(fetchPage('http://localhost:3000/', f as unknown as typeof fetch)).rejects.toThrow(/public/);
    expect(f).not.toHaveBeenCalled();
  });

  it('reports blocks, non-pages and timeouts in plain words', async () => {
    await expect(fetchPage('https://example.com/a', page('', 'text/html', 429) as unknown as typeof fetch)).rejects.toThrow(/blocks automated access/);
    await expect(fetchPage('https://example.com/a', page('%PDF', 'application/pdf') as unknown as typeof fetch)).rejects.toThrow(/not a readable web page/);
    await expect(fetchPage('https://example.com/a', vi.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch)).rejects.toThrow(/did not respond/);
  });

  it('works as the read_url tool and returns structured results', async () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, page('<title>T</title><p>Body text here</p>') as unknown as typeof fetch);
    const ctx = { channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date() };
    expect(await registry.execute('read_url', JSON.stringify({ url: 'https://example.com/a' }), ctx)).toMatchObject({ ok: true, title: 'T' });
    expect((await registry.execute('read_url', JSON.stringify({ url: 'https://linkedin.com/in/x' }), ctx)).ok).toBe(false);
  });
});
