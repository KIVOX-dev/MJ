import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import { ToolRegistry } from '../src/core/tool-registry';
import { registerEmailTools } from '../src/modules/communication-manager/email/email.tools';
import { processTelegramUpdate } from '../src/modules/communication-manager/telegram/telegram.handler';
import type { MessageStore } from '../src/core/memory/message.store';

type Draft = { id: string; to: string; subject: string; body: string };

function setup(opts: { dailyLimit?: number; ownerName?: string } = {}) {
  const send = vi.fn().mockResolvedValue({ messageId: 'm1' });
  const registry = new ToolRegistry();
  const controller = registerEmailTools(registry, { send } as never, 'owner@example.com', { ownerName: 'Kaviarasan M', ...opts });
  const drafts: Draft[] = [];
  const ctx = { channel: 'telegram' as const, chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date(), turnId: 't1', onDraft: (d: Draft) => void drafts.push(d) };
  const draft = async (body = 'Hi,\n\nNice meeting you.\n\nBest regards,\n[Your Name]', subject = 'Hello') =>
    registry.execute('draft_email', JSON.stringify({ to: 'Friend@Example.com', subject, body }), ctx);
  return { send, controller, drafts, draft };
}

describe('email drafts with a Send button', () => {
  it('shows a card (not the text) to the app, and signs with the owner name instead of a placeholder', async () => {
    const { drafts, draft, send } = setup();
    const r = (await draft()) as unknown as { status: string; next: string; body?: string };
    expect(r.status).toBe('draft_ready_not_sent');
    expect(r.body).toBeUndefined(); // the AI is told not to repeat it
    expect(r.next).toMatch(/Send button/);
    expect(drafts[0]).toMatchObject({ to: 'friend@example.com', subject: 'Hello' });
    expect(drafts[0]!.body).toContain('Kaviarasan M');
    expect(drafts[0]!.body).not.toContain('[Your Name]');
    expect(send).not.toHaveBeenCalled();
  });

  it('tapping Send delivers through Brevo as "<name> via MJ" with replies going to the owner, once only', async () => {
    const { drafts, draft, send, controller } = setup();
    await draft();
    const out = await controller.send(drafts[0]!.id);
    expect(out).toEqual({ sent_to: 'friend@example.com' });
    const [to, subject, , , html, opts] = send.mock.calls[0]!;
    expect([to, subject]).toEqual(['friend@example.com', 'Hello']);
    expect(opts).toEqual({ replyTo: 'owner@example.com', senderName: 'Kaviarasan M via MJ' });
    expect(html).toContain('on behalf of Kaviarasan M');
    expect(html).not.toContain('Good day, Sir');
    await expect(controller.send(drafts[0]!.id)).rejects.toThrow(/expired or was already sent/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets Sir edit the subject and text before sending, and fills any placeholder in the edit too', async () => {
    const { drafts, draft, send, controller } = setup();
    await draft();
    await controller.send(drafts[0]!.id, { subject: 'Edited subject', body: 'Edited text.\n[Your Name]' });
    expect(send.mock.calls[0]![1]).toBe('Edited subject');
    expect(send.mock.calls[0]![2]).toBe('Edited text.\nKaviarasan M');
  });

  it('discards a draft, and enforces the daily limit on button sends too', async () => {
    const { drafts, draft, controller, send } = setup({ dailyLimit: 1 });
    await draft();
    expect(controller.discard(drafts[0]!.id)).toBe(true);
    await expect(controller.send(drafts[0]!.id)).rejects.toThrow(/expired or was already sent/);
    await draft();
    await controller.send(drafts[1]!.id);
    await draft();
    await expect(controller.send(drafts[2]!.id)).rejects.toThrow(/daily limit/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('email_me also signs with the owner name', async () => {
    const { send } = setup();
    const registry = new ToolRegistry();
    registerEmailTools(registry, { send } as never, 'owner@example.com', { ownerName: 'Kaviarasan M' });
    await registry.execute('email_me', JSON.stringify({ subject: 'Notes', body: 'Regards,\n[Name]' }), { channel: 'telegram', chatId: '1', timezone: 'Asia/Kolkata', now: () => new Date() });
    expect(send.mock.calls[0]![2]).toBe('Regards,\nKaviarasan M');
  });
});

const TOKEN = 'web-token-1234567890';
const store: MessageStore = { claimInbound: async () => true, saveOutbound: async () => undefined, recent: async () => [] };

describe('draft card in the web app', () => {
  it('puts the draft in the reply as a fenced card, and the Send / Discard endpoints work', async () => {
    const { controller } = setup();
    const draftFn = vi.fn();
    const send = vi.spyOn(controller, 'send').mockResolvedValue({ sent_to: 'friend@example.com' });
    const discard = vi.spyOn(controller, 'discard').mockReturnValue(true);
    const respond = vi.fn(async (_t: string, c: { onDraft?: (d: Draft) => void }) => (c.onDraft?.({ id: 'ab12cd34', to: 'friend@example.com', subject: 'Hi `there`', body: 'Body with ``` fence' }), 'The draft is ready, Sir.'));
    const app = createApp({ isDbConnected: () => true, extraRouters: [webChatRouter({ token: TOKEN, respond: respond as never, store, ownerChatId: '1', emailDrafts: controller })] });
    void draftFn;
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const chat = await request(app).post('/api/chat').set(auth).send({ query: 'email my friend' });
    expect(chat.body.reply).toMatch(/^The draft is ready, Sir\.\n\n```mj-email\n\{.*\}\n```$/s);
    const json = JSON.parse(/```mj-email\n(.*)\n```/s.exec(chat.body.reply)![1]!) as Draft;
    expect(json).toMatchObject({ id: 'ab12cd34', subject: 'Hi `there`', body: 'Body with ``` fence' });
    expect(chat.body.reply.split('```')).toHaveLength(3); // the escaped backticks cannot break out of the fence

    expect((await request(app).post('/api/email/send').send({ draft_id: 'ab12cd34' })).status).toBe(401);
    const sent = await request(app).post('/api/email/send').set(auth).send({ draft_id: 'ab12cd34', subject: 'S', body: 'B' });
    expect(sent.body).toEqual({ sent_to: 'friend@example.com' });
    expect(send).toHaveBeenCalledWith('ab12cd34', { subject: 'S', body: 'B' });
    expect((await request(app).post('/api/email/discard').set(auth).send({ draft_id: 'ab12cd34' })).body).toEqual({ discarded: true });
    expect(discard).toHaveBeenCalledWith('ab12cd34');
    expect((await request(app).post('/api/email/send').set(auth).send({})).status).toBe(400);

    send.mockRejectedValueOnce(new Error('That draft has expired or was already sent. Ask me to draft it again.'));
    const gone = await request(app).post('/api/email/send').set(auth).send({ draft_id: 'ab12cd34' });
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/expired/);
  });
});

describe('draft buttons in Telegram', () => {
  const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, from: { id: 555 }, chat: { id: 555, type: 'private' }, text } });

  it('sends the draft with Send and Discard buttons, and Send actually delivers it', async () => {
    const { controller } = setup();
    const send = vi.spyOn(controller, 'send').mockResolvedValue({ sent_to: 'friend@example.com' });
    const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }), answerCallback: vi.fn().mockResolvedValue(undefined), clearKeyboard: vi.fn().mockResolvedValue(undefined) };
    const respond = vi.fn(async (_t: string, c: { onDraft?: (d: Draft) => void }) => (c.onDraft?.({ id: 'ab12cd34', to: 'friend@example.com', subject: 'Hello', body: 'Hi there' }), 'Draft ready, Sir.'));
    const deps = { ownerId: '555', store, respond: respond as never, sender, emailDrafts: controller };
    await processTelegramUpdate(update(1, 'email my friend'), deps);
    const card = sender.sendText.mock.calls.find((c) => String(c[1]).includes('Draft email'))!;
    expect(card[1]).toContain('To: friend@example.com');
    expect(card[2].buttons.map((b: { data: string }) => b.data)).toEqual(['mail:send:ab12cd34', 'mail:drop:ab12cd34']);

    await processTelegramUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: 555 }, data: 'mail:send:ab12cd34', message: { message_id: 9, chat: { id: 555 } } } }, deps);
    expect(send).toHaveBeenCalledWith('ab12cd34');
    expect(sender.sendText).toHaveBeenLastCalledWith(555, expect.stringContaining('friend@example.com'));
  });

  it('ignores button presses from anyone but the owner, and Discard drops the draft', async () => {
    const { controller } = setup();
    const send = vi.spyOn(controller, 'send').mockResolvedValue({ sent_to: 'x@example.com' });
    const discard = vi.spyOn(controller, 'discard').mockReturnValue(true);
    const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }), answerCallback: vi.fn(), clearKeyboard: vi.fn().mockResolvedValue(undefined) };
    const deps = { ownerId: '555', store, respond: vi.fn() as never, sender, emailDrafts: controller };
    const press = (from: number, data: string) => ({ update_id: 3, callback_query: { id: 'c', from: { id: from }, data, message: { message_id: 9, chat: { id: 555 } } } });
    await processTelegramUpdate(press(999, 'mail:send:ab12cd34'), deps);
    expect(send).not.toHaveBeenCalled();
    await processTelegramUpdate(press(555, 'mail:drop:ab12cd34'), deps);
    expect(discard).toHaveBeenCalledWith('ab12cd34');
    expect(send).not.toHaveBeenCalled();
  });
});
