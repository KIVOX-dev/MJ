import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { jobsRouter } from '../src/routes/jobs.routes';
import { Agent, AI_FAILURE_REPLY, type ToolChat } from '../src/core/orchestrator/assistant';
import { ToolRegistry } from '../src/core/tool-registry';
import { ReminderService } from '../src/modules/personal-secretary/reminders/reminder.service';
import { registerReminderTools } from '../src/modules/personal-secretary/reminders/reminder.tools';
import type { ReminderRecord, ReminderRepo, NewReminder } from '../src/modules/personal-secretary/reminders/reminder.repo';
import type { MessageStore } from '../src/core/memory/message.store';

const NOW = new Date('2026-11-04T10:00:00Z');

function fakeRepo() {
  type Row = ReminderRecord & { status: string; key: string };
  const rows: Row[] = [];
  let n = 0;
  const repo: ReminderRepo = {
    create: async (r: NewReminder) => {
      const hit = rows.find((x) => x.key === r.idempotencyKey);
      if (hit) return hit;
      const row: Row = {
        id: String(++n).padStart(24, '0'),
        channel: r.channel,
        chatId: r.chatId,
        text: r.text,
        dueAt: r.dueAt,
        attempts: 0,
        status: 'pending',
        key: r.idempotencyKey,
      };
      rows.push(row);
      return row;
    },
    listPending: async (c, id) => rows.filter((x) => x.channel === c && x.chatId === id && x.status === 'pending'),
    cancel: async (c, id, rid) => {
      const r = rows.find((x) => x.id === rid && x.channel === c && x.chatId === id && x.status === 'pending');
      if (r) r.status = 'cancelled';
      return !!r;
    },
    claimDue: async (now) => {
      const r = rows.filter((x) => x.status === 'pending' && x.dueAt <= now).sort((a, b) => +a.dueAt - +b.dueAt)[0];
      if (!r) return null;
      r.status = 'processing';
      r.attempts++;
      return { ...r };
    },
    markSent: async (id) => void (rows.find((x) => x.id === id)!.status = 'sent'),
    reschedule: async (id, dueAt) => {
      const r = rows.find((x) => x.id === id)!;
      r.status = 'pending';
      r.dueAt = dueAt;
    },
    markFailed: async (id) => void (rows.find((x) => x.id === id)!.status = 'failed'),
  };
  return { repo, rows };
}

const emptyStore: MessageStore = { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] };

function setup(clock = { t: NOW }) {
  const { repo, rows } = fakeRepo();
  const svc = new ReminderService(repo, 'Asia/Kolkata', () => clock.t);
  const registry = new ToolRegistry();
  registerReminderTools(registry, svc);
  return { svc, registry, rows, clock };
}
const call = (name: string, args: object, id = 'c1') => ({
  content: null,
  toolCalls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
});
const ctx = { channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => NOW };

describe('ToolRegistry', () => {
  it('exposes JSON-schema specs for the reminder tools', () => {
    const { registry } = setup();
    const specs = registry.specs();
    expect(specs.map((s) => s.function.name)).toEqual(['create_reminder', 'list_reminders', 'cancel_reminder']);
    expect(specs[0]!.function.parameters).toHaveProperty('properties');
  });
  it('rejects unknown tools and bad arguments without throwing', async () => {
    const { registry } = setup();
    expect((await registry.execute('nope', '{}', ctx)).ok).toBe(false);
    expect((await registry.execute('create_reminder', '{bad', ctx)).ok).toBe(false);
    // neither in_minutes nor at
    expect((await registry.execute('create_reminder', JSON.stringify({ text: 'x' }), ctx)).ok).toBe(false);
  });
});

describe('Agent (multi-step tool use)', () => {
  const mk = (chat: unknown, registry: ToolRegistry) =>
    new Agent({ ai: { chat } as ToolChat, store: emptyStore, registry, timezone: 'Asia/Kolkata', now: () => NOW });

  it('runs create_reminder then answers from the verified tool result', async () => {
    const { registry, rows } = setup();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(call('create_reminder', { text: 'drink water', in_minutes: 2 }))
      .mockResolvedValueOnce({ content: 'Reminder set, Sir.', toolCalls: [] });
    const out = await mk(chat, registry).reply('remind me in 2 minutes to drink water', { channel: 'telegram', chatId: '42' });
    expect(out).toBe('Reminder set, Sir.');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dueAt.toISOString()).toBe('2026-11-04T10:02:00.000Z');
    // the model saw the real tool result (ok:true), not its own claim
    const toolMsg = chat.mock.calls[1]![0].find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content).ok).toBe(true);
  });

  it('feeds tool errors back so the model can report them honestly', async () => {
    const { registry } = setup();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(call('create_reminder', { text: 'x', day: '2020-01-01', time: '09:00' }))
      .mockResolvedValueOnce({ content: 'That time has passed, Sir.', toolCalls: [] });
    await mk(chat, registry).reply('remind me in 2020', { channel: 'telegram', chatId: '42' });
    const toolMsg = chat.mock.calls[1]![0].find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: false, error: expect.stringContaining('past') });
  });

  it('returns a polite failure message when the AI is unavailable', async () => {
    const { registry } = setup();
    const chat = vi.fn().mockRejectedValue(new Error('down'));
    expect(await mk(chat, registry).reply('hi', { channel: 'telegram', chatId: '1' })).toBe(AI_FAILURE_REPLY);
  });

  it('stops after a bounded number of tool steps', async () => {
    const { registry } = setup();
    const chat = vi.fn().mockResolvedValue(call('list_reminders', {}));
    const out = await mk(chat, registry).reply('loop', { channel: 'telegram', chatId: '1' });
    expect(chat.mock.calls.length).toBe(5);
    expect(out).toMatch(/could not complete/);
  });
});

describe('ReminderService', () => {
  it('is idempotent for duplicate creates', async () => {
    const { svc, rows } = setup();
    const due = new Date(NOW.getTime() + 120_000);
    await svc.create('telegram', '1', 'water', due);
    await svc.create('telegram', '1', 'water', due);
    expect(rows).toHaveLength(1);
  });
  it('rejects past times', async () => {
    const { svc } = setup();
    await expect(svc.create('telegram', '1', 'x', new Date(NOW.getTime() - 3600_000))).rejects.toThrow(/past/);
  });
  it('sends due reminders exactly once and ignores future ones', async () => {
    const { svc, clock } = setup();
    await svc.create('telegram', '1', 'water', new Date(NOW.getTime() + 120_000));
    const notify = vi.fn().mockResolvedValue(undefined);
    expect(await svc.dispatchDue(notify)).toEqual({ sent: 0, retried: 0, failed: 0 });
    clock.t = new Date(NOW.getTime() + 130_000);
    expect(await svc.dispatchDue(notify)).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(await svc.dispatchDue(notify)).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(notify).toHaveBeenCalledWith('telegram', '1', expect.stringContaining('water'));
  });
  it('retries failed deliveries then gives up after 3 attempts', async () => {
    const { svc, clock, rows } = setup();
    await svc.create('telegram', '1', 'water', new Date(NOW.getTime() + 1000));
    const notify = vi.fn().mockRejectedValue(new Error('blocked'));
    for (let i = 0; i < 3; i++) {
      clock.t = new Date(clock.t.getTime() + 3600_000);
      await svc.dispatchDue(notify);
    }
    expect(notify).toHaveBeenCalledTimes(3);
    expect(rows[0]!.status).toBe('failed');
  });
  it('cancels a pending reminder only for its own chat', async () => {
    const { svc } = setup();
    const r = await svc.create('telegram', '1', 'x', new Date(NOW.getTime() + 120_000));
    expect(await svc.cancel('telegram', '2', r.id)).toBe(false);
    expect(await svc.cancel('telegram', '1', r.id)).toBe(true);
  });
});

describe('POST /jobs/tick', () => {
  it('requires the secret and runs the job', async () => {
    const run = vi.fn().mockResolvedValue({ sent: 1 });
    const app = createApp({ isDbConnected: () => true, extraRouters: [jobsRouter({ secret: 's3', run })] });
    expect((await request(app).post('/jobs/tick')).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const ok = await request(app).post('/jobs/tick').set('x-job-secret', 's3');
    expect(ok.status).toBe(200);
    expect(ok.body.result).toEqual({ sent: 1 });
  });
});
