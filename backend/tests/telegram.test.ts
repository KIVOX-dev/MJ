import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { telegramRouter } from '../src/routes/telegram.routes';
import { processTelegramUpdate } from '../src/modules/communication-manager/telegram/telegram.handler';
import { TelegramBotClient } from '../src/modules/communication-manager/telegram/telegram.client';
import type { MessageStore } from '../src/core/memory/message.store';

const OWNER = '555';
const SECRET = 'tg-secret';

function memoryStore(): MessageStore {
  const seen = new Set<string>();
  const log: Array<{ direction: 'in' | 'out'; text: string }> = [];
  return {
    claimInbound: async (id, _f, text) => {
      if (seen.has(id)) return false;
      seen.add(id);
      log.push({ direction: 'in', text });
      return true;
    },
    saveOutbound: async (_i, _t, text) => void log.push({ direction: 'out', text }),
    recent: async () => log.slice(-8),
  };
}
const update = (fromId: number, id: number, text: string) => ({
  update_id: id,
  message: { message_id: id, from: { id: fromId }, chat: { id: fromId, type: 'private' }, text },
});
function setup(ownerId = OWNER) {
  const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }) };
  const ai = { complete: vi.fn().mockResolvedValue('Certainly, Sir.') };
  const deps = { webhookSecret: SECRET, ownerId, store: memoryStore(), ai, sender };
  return { deps, sender, ai, app: createApp({ isDbConnected: () => true, extraRouters: [telegramRouter(deps)] }) };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('telegram webhook', () => {
  it('rejects a wrong or missing secret header', async () => {
    const { app, sender } = setup();
    const bad = await request(app).post('/webhook/telegram').set('X-Telegram-Bot-Api-Secret-Token', 'nope').send(update(555, 1, 'hi'));
    const none = await request(app).post('/webhook/telegram').send(update(555, 1, 'hi'));
    expect([bad.status, none.status]).toEqual([401, 401]);
    await tick();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('replies to the owner', async () => {
    const { app, sender, ai } = setup();
    const res = await request(app).post('/webhook/telegram').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update(555, 2, 'plan my day'));
    expect(res.status).toBe(200);
    await tick();
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledWith(555, 'Certainly, Sir.');
  });
});

describe('processTelegramUpdate', () => {
  it('ignores non-owners but answers /myid with their own id', async () => {
    const { deps, sender, ai } = setup();
    await processTelegramUpdate(update(999, 3, 'hello'), deps);
    expect(sender.sendText).not.toHaveBeenCalled();
    await processTelegramUpdate(update(999, 4, '/myid'), deps);
    expect(sender.sendText).toHaveBeenCalledWith(999, 'Your Telegram user id is 999');
    expect(ai.complete).not.toHaveBeenCalled();
  });
  it('fails closed when owner is not configured', async () => {
    const { deps, sender } = setup('');
    await processTelegramUpdate(update(555, 5, 'hello'), deps);
    expect(sender.sendText).not.toHaveBeenCalled();
  });
  it('skips duplicate update ids', async () => {
    const { deps, sender } = setup();
    await processTelegramUpdate(update(555, 6, 'hi'), deps);
    await processTelegramUpdate(update(555, 6, 'hi'), deps);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });
  it('falls back politely when the AI fails', async () => {
    const { deps, sender, ai } = setup();
    ai.complete.mockRejectedValueOnce(new Error('down'));
    await processTelegramUpdate(update(555, 7, 'hi'), deps);
    expect(sender.sendText).toHaveBeenCalledWith(555, expect.stringContaining('Apologies'));
  });
});

describe('TelegramBotClient', () => {
  it('throws on API failure without leaking the token', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
    const err = await new TelegramBotClient('SECRETTOKEN', f as unknown as typeof fetch).sendText(1, 'x').then(() => new Error('did not throw'), (e: Error) => e);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain('SECRETTOKEN');
  });
});
