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
  const respond = vi.fn().mockResolvedValue('Certainly, Sir.');
  const deps = { webhookSecret: SECRET, ownerId, store: memoryStore(), respond, sender };
  return { deps, sender, respond, app: createApp({ isDbConnected: () => true, extraRouters: [telegramRouter(deps)] }) };
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
    const { app, sender, respond } = setup();
    const res = await request(app).post('/webhook/telegram').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update(555, 2, 'plan my day'));
    expect(res.status).toBe(200);
    await tick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledWith(555, 'Certainly, Sir.');
  });
});

describe('processTelegramUpdate', () => {
  it('ignores non-owners but answers /myid with their own id', async () => {
    const { deps, sender, respond } = setup();
    await processTelegramUpdate(update(999, 3, 'hello'), deps);
    expect(sender.sendText).not.toHaveBeenCalled();
    await processTelegramUpdate(update(999, 4, '/myid'), deps);
    expect(sender.sendText).toHaveBeenCalledWith(999, 'Your Telegram user id is 999');
    expect(respond).not.toHaveBeenCalled();
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
});

describe('TelegramBotClient', () => {
  it('throws on API failure without leaking the token', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) });
    const err = await new TelegramBotClient('SECRETTOKEN', f as unknown as typeof fetch).sendText(1, 'x').then(() => new Error('did not throw'), (e: Error) => e);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain('SECRETTOKEN');
  });
});

describe('MongoMessageStore duplicate detection', () => {
  it('does not treat unrelated unique-index clashes as duplicates', async () => {
    const { MessageModel } = await import('../src/models/message.model');
    const { MongoMessageStore } = await import('../src/core/memory/message.store');
    const spy = vi.spyOn(MessageModel, 'create');
    spy.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000, keyPattern: { waMessageId: 1 } }));
    await expect(new MongoMessageStore('telegram').claimInbound('1', 'u', 't', 'text')).rejects.toThrow();
    spy.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000, keyPattern: { channel: 1, externalId: 1 } }));
    expect(await new MongoMessageStore('telegram').claimInbound('1', 'u', 't', 'text')).toBe(false);
    spy.mockRestore();
  });
});

describe('telegram voice notes', () => {
  const voiceUpdate = (id: number) => ({
    update_id: id,
    message: { message_id: id, from: { id: 555 }, chat: { id: 555, type: 'private' }, voice: { file_id: 'v1', duration: 4, mime_type: 'audio/ogg', file_size: 20000 } },
  });
  function voiceSetup(transcribe?: (a: Buffer, m: string) => Promise<string>) {
    const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 1 }), downloadFile: vi.fn().mockResolvedValue(Buffer.alloc(500, 1)) };
    const respond = vi.fn().mockResolvedValue('Certainly, Sir.');
    const deps = { webhookSecret: SECRET, ownerId: OWNER, store: memoryStore(), respond, sender, transcribe };
    return { deps, sender, respond };
  }

  it('transcribes a voice note, shows the words, and answers as if typed', async () => {
    const tr = vi.fn().mockResolvedValue('remind me at six');
    const { deps, sender, respond } = voiceSetup(tr);
    await processTelegramUpdate(voiceUpdate(10), deps);
    expect(tr).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg');
    expect(sender.sendText.mock.calls.map((c) => c[1])).toEqual(['🎤 remind me at six', 'Certainly, Sir.']);
    expect(respond).toHaveBeenCalledWith('remind me at six', { channel: 'telegram', chatId: '555' });
  });

  it('ignores voice notes from anyone but the owner', async () => {
    const tr = vi.fn();
    const { deps, sender } = voiceSetup(tr);
    const u = voiceUpdate(11);
    await processTelegramUpdate({ ...u, message: { ...u.message, from: { id: 999 } } }, deps);
    expect(tr).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('handles failures, silence, and a missing transcriber politely', async () => {
    const failing = voiceSetup(vi.fn().mockRejectedValue(new Error('x')));
    await processTelegramUpdate(voiceUpdate(12), failing.deps);
    expect(failing.sender.sendText.mock.calls[0]![1]).toMatch(/could not understand/);
    expect(failing.respond).not.toHaveBeenCalled();

    const silent = voiceSetup(vi.fn().mockResolvedValue('  '));
    await processTelegramUpdate(voiceUpdate(13), silent.deps);
    expect(silent.sender.sendText.mock.calls[0]![1]).toMatch(/could not hear/);

    const off = voiceSetup(undefined);
    await processTelegramUpdate(voiceUpdate(14), off.deps);
    expect(off.sender.sendText.mock.calls[0]![1]).toMatch(/not switched on/);
  });

  it('rejects very long voice notes without downloading them', async () => {
    const tr = vi.fn();
    const { deps, sender } = voiceSetup(tr);
    const u = voiceUpdate(15);
    u.message.voice.duration = 900;
    await processTelegramUpdate(u, deps);
    expect(sender.downloadFile).not.toHaveBeenCalled();
    expect(sender.sendText.mock.calls[0]![1]).toMatch(/too long/);
  });

  it('transcribes the sound of round video notes and videos', async () => {
    const tr = vi.fn().mockResolvedValue('hello MJ');
    const { deps, sender, respond } = voiceSetup(tr);
    await processTelegramUpdate({ update_id: 20, message: { message_id: 20, from: { id: 555 }, chat: { id: 555, type: 'private' }, video_note: { file_id: 'vn', duration: 3, file_size: 90000 } } }, deps);
    expect(tr).toHaveBeenCalledWith(expect.any(Buffer), 'video/mp4');
    expect(sender.sendText.mock.calls[0]![1]).toBe('🎤 hello MJ');
    expect(respond).toHaveBeenCalledWith('hello MJ', { channel: 'telegram', chatId: '555' });
    await processTelegramUpdate({ update_id: 21, message: { message_id: 21, from: { id: 555 }, chat: { id: 555, type: 'private' }, video: { file_id: 'vv', duration: 5, mime_type: 'video/mp4', file_size: 200000 } } }, deps);
    expect(tr).toHaveBeenCalledTimes(2);
  });
});
