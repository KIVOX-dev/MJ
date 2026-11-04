import { describe, expect, it, vi } from 'vitest';
import { MAX_REPEATS, ReminderService } from '../src/modules/personal-secretary/reminders/reminder.service';
import { registerReminderTools } from '../src/modules/personal-secretary/reminders/reminder.tools';
import type { NewReminder, ReminderRecord, ReminderRepo } from '../src/modules/personal-secretary/reminders/reminder.repo';
import { ToolRegistry } from '../src/core/tool-registry';
import { processTelegramUpdate, type TgUpdate } from '../src/modules/communication-manager/telegram/telegram.handler';
import { TelegramBotClient } from '../src/modules/communication-manager/telegram/telegram.client';
import type { MessageStore } from '../src/core/memory/message.store';

const T0 = new Date('2026-11-04T10:00:00Z');

type Row = ReminderRecord & { status: string; key: string };
function memRepo() {
  const rows: Row[] = [];
  let n = 0;
  const active = (x: Row) => x.status === 'pending' || x.status === 'processing';
  const repo: ReminderRepo = {
    create: async (r: NewReminder) => {
      const hit = rows.find((x) => x.key === r.idempotencyKey);
      if (hit) return hit;
      const row: Row = { id: String(++n).padStart(24, 'a'), channel: r.channel, chatId: r.chatId, text: r.text, dueAt: r.dueAt, attempts: 0, sentCount: 0, repeatEveryMin: r.repeatEveryMin, status: 'pending', key: r.idempotencyKey };
      rows.push(row);
      return row;
    },
    listPending: async (c, id) => rows.filter((x) => x.channel === c && x.chatId === id && active(x)),
    cancel: async (c, id, rid) => {
      const r = rows.find((x) => x.id === rid && x.channel === c && x.chatId === id && active(x));
      if (r) r.status = 'cancelled';
      return !!r;
    },
    cancelAll: async (c, id) => {
      const a = rows.filter((x) => x.channel === c && x.chatId === id && active(x));
      a.forEach((x) => (x.status = 'cancelled'));
      return a.length;
    },
    claimDue: async (now) => {
      const r = rows.filter((x) => x.status === 'pending' && x.dueAt <= now).sort((a, b) => +a.dueAt - +b.dueAt)[0];
      if (!r) return null;
      r.status = 'processing';
      r.attempts++;
      return { ...r };
    },
    markSent: async (id) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.status === 'processing') r.status = 'sent';
    },
    scheduleNext: async (id, dueAt) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== 'processing') return;
      Object.assign(r, { status: 'pending', dueAt, attempts: 0, sentCount: r.sentCount + 1 });
    },
    reschedule: async (id, dueAt) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.status === 'processing') Object.assign(r, { status: 'pending', dueAt });
    },
    markFailed: async (id) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.status === 'processing') r.status = 'failed';
    },
  };
  return { repo, rows };
}

function setup() {
  const clock = { t: T0 };
  const { repo, rows } = memRepo();
  const svc = new ReminderService(repo, 'Asia/Kolkata', () => clock.t);
  return { svc, rows, clock };
}
const advance = (clock: { t: Date }, min: number) => (clock.t = new Date(clock.t.getTime() + min * 60_000));

describe('repeating reminders', () => {
  it('repeats every 10 minutes with a Stop button until stopped', async () => {
    const { svc, rows, clock } = setup();
    const r = await svc.create('telegram', '7', 'take medicine', new Date(T0.getTime() + 60_000), 10);
    const notify = vi.fn().mockResolvedValue(undefined);

    advance(clock, 2); // first one is due
    expect((await svc.dispatchDue(notify)).sent).toBe(1);
    expect(notify.mock.calls[0]![3]).toEqual({ stopButtonFor: r.id });
    expect(notify.mock.calls[0]![2]).toContain('take medicine');
    expect(notify.mock.calls[0]![2]).toContain('again in 10 min');
    expect(rows[0]!.status).toBe('pending'); // still alive

    advance(clock, 5); // not yet due again
    expect((await svc.dispatchDue(notify)).sent).toBe(0);
    advance(clock, 6); // 11 minutes after the first
    expect((await svc.dispatchDue(notify)).sent).toBe(1);
    advance(clock, 10);
    expect((await svc.dispatchDue(notify)).sent).toBe(1);
    expect(notify).toHaveBeenCalledTimes(3);

    expect(await svc.cancel('telegram', '7', r.id)).toBe(true); // user pressed Stop
    advance(clock, 60);
    expect((await svc.dispatchDue(notify)).sent).toBe(0);
    expect(notify).toHaveBeenCalledTimes(3); // nothing more, ever
  });

  it('a Stop pressed while a delivery is in flight still wins', async () => {
    const { svc, rows, clock } = setup();
    const r = await svc.create('telegram', '7', 'x', new Date(T0.getTime() + 1000), 10);
    advance(clock, 1);
    const notify = vi.fn(async () => {
      await svc.cancel('telegram', '7', r.id); // user taps Stop at the same moment
    });
    await svc.dispatchDue(notify);
    expect(rows[0]!.status).toBe('cancelled'); // not re-armed
    advance(clock, 30);
    expect((await svc.dispatchDue(vi.fn())).sent).toBe(0);
  });

  it('stops by itself after the 24-hour safety limit, with a final notice', async () => {
    const { svc, rows, clock } = setup();
    await svc.create('telegram', '7', 'x', new Date(T0.getTime() + 1000), 10);
    const notify = vi.fn().mockResolvedValue(undefined);
    advance(clock, 1);
    for (let i = 0; i < MAX_REPEATS + 5; i++) {
      await svc.dispatchDue(notify);
      advance(clock, 10);
    }
    expect(notify).toHaveBeenCalledTimes(MAX_REPEATS);
    expect(notify.mock.calls.at(-1)![2]).toContain('last repeat');
    expect(rows[0]!.status).toBe('sent');
  });

  it('retries a failed delivery without losing the repeat schedule', async () => {
    const { svc, rows, clock } = setup();
    await svc.create('telegram', '7', 'x', new Date(T0.getTime() + 1000), 10);
    advance(clock, 1);
    await svc.dispatchDue(vi.fn().mockRejectedValue(new Error('telegram down')));
    expect(rows[0]!.status).toBe('pending');
    advance(clock, 2);
    expect((await svc.dispatchDue(vi.fn().mockResolvedValue(undefined))).sent).toBe(1);
    expect(rows[0]!.repeatEveryMin).toBe(10);
  });

  it('one-time reminders are unchanged: no button, sent once', async () => {
    const { svc, clock } = setup();
    await svc.create('telegram', '7', 'water', new Date(T0.getTime() + 1000));
    const notify = vi.fn().mockResolvedValue(undefined);
    advance(clock, 1);
    await svc.dispatchDue(notify);
    advance(clock, 30);
    await svc.dispatchDue(notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![3]).toBeUndefined();
  });

  it('rejects an invalid repeat interval', async () => {
    const { svc } = setup();
    await expect(svc.create('telegram', '7', 'x', new Date(T0.getTime() + 1000), 0)).rejects.toThrow(/repeat_every_minutes/);
    await expect(svc.create('telegram', '7', 'x', new Date(T0.getTime() + 1000), 5000)).rejects.toThrow(/repeat_every_minutes/);
  });
});

describe('reminder tools: repeat and stop all', () => {
  it('creates a repeating reminder and cancels everything on request', async () => {
    const { svc } = setup();
    const registry = new ToolRegistry();
    registerReminderTools(registry, svc);
    const ctx = { channel: 'telegram' as const, chatId: '7', timezone: 'Asia/Kolkata', now: () => T0 };
    const created = await registry.execute('create_reminder', JSON.stringify({ text: 'check in', in_minutes: 1, repeat_every_minutes: 10 }), ctx);
    expect(created).toMatchObject({ ok: true, repeats_every_min: 10 });
    await registry.execute('create_reminder', JSON.stringify({ text: 'other', in_minutes: 30 }), ctx);
    const listed = (await registry.execute('list_reminders', '{}', ctx)) as unknown as { count: number };
    expect(listed.count).toBe(2);
    const stopped = await registry.execute('cancel_all_reminders', '{}', ctx);
    expect(stopped).toMatchObject({ ok: true, cancelled_count: 2 });
    expect(((await registry.execute('list_reminders', '{}', ctx)) as unknown as { count: number }).count).toBe(0);
  });
});

describe('Telegram Stop button', () => {
  const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => {}, recent: async () => [] };
  const press = (fromId: number, data: string): TgUpdate => ({
    update_id: 1,
    callback_query: { id: 'cb1', from: { id: fromId }, data, message: { message_id: 55, chat: { id: fromId } } },
  });
  const deps = (stopped: boolean) => {
    const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }), answerCallback: vi.fn().mockResolvedValue(undefined), clearKeyboard: vi.fn().mockResolvedValue(undefined) };
    const stopReminder = vi.fn().mockResolvedValue(stopped);
    return { sender, stopReminder, d: { ownerId: '7', store, respond: vi.fn(), sender, stopReminder } };
  };

  it('stops the reminder, clears the button and confirms', async () => {
    const { sender, stopReminder, d } = deps(true);
    await processTelegramUpdate(press(7, 'stop:' + 'a'.repeat(24)), d);
    expect(stopReminder).toHaveBeenCalledWith('7', 'a'.repeat(24));
    expect(sender.answerCallback).toHaveBeenCalledWith('cb1', 'Reminder stopped');
    expect(sender.clearKeyboard).toHaveBeenCalledWith(7, 55);
    expect(sender.sendText).toHaveBeenCalledWith(7, expect.stringContaining('stopped'));
  });

  it('ignores presses from anyone but the owner', async () => {
    const { sender, stopReminder, d } = deps(true);
    await processTelegramUpdate(press(999, 'stop:' + 'a'.repeat(24)), d);
    expect(stopReminder).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('ignores malformed button data and handles an already-stopped reminder', async () => {
    const bad = deps(true);
    await processTelegramUpdate(press(7, 'stop:not-an-id'), bad.d);
    expect(bad.stopReminder).not.toHaveBeenCalled();
    const gone = deps(false);
    await processTelegramUpdate(press(7, 'stop:' + 'b'.repeat(24)), gone.d);
    expect(gone.sender.answerCallback).toHaveBeenCalledWith('cb1', 'Already stopped');
    expect(gone.sender.sendText).not.toHaveBeenCalled();
  });

  it('sendText attaches the inline Stop button and registers for callback_query updates', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 3 } }) });
    const c = new TelegramBotClient('T', f as unknown as typeof fetch);
    await c.sendText(7, 'x', { stopReminderId: 'a'.repeat(24) });
    const body = JSON.parse(f.mock.calls[0]![1].body);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('stop:' + 'a'.repeat(24));
    await c.setWebhook('https://x.test/webhook/telegram', 's');
    expect(JSON.parse(f.mock.calls[1]![1].body).allowed_updates).toEqual(['message', 'callback_query']);
  });
});
