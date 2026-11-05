import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { webChatRouter } from '../src/routes/web.routes';
import { PushService, type NotificationRecord, type Prefs, type PushRepo, type StoredSub } from '../src/modules/communication-manager/push/push.service';
import type { SessionRepo } from '../src/core/memory/session.repo';
import type { MessageStore } from '../src/core/memory/message.store';

function fakeRepo(): PushRepo & { subs: StoredSub[]; notes: NotificationRecord[] } {
  const subs: StoredSub[] = [];
  const notes: NotificationRecord[] = [];
  let prefs: Prefs = { reminder: true, alert: true, news: true, system: true };
  let n = 0;
  return {
    subs,
    notes,
    saveSub: async (s) => {
      const i = subs.findIndex((x) => x.endpoint === s.endpoint);
      if (i >= 0) subs[i] = s;
      else subs.push(s);
    },
    removeSub: async (e) => {
      const i = subs.findIndex((x) => x.endpoint === e);
      if (i >= 0) subs.splice(i, 1);
    },
    listSubs: async () => [...subs],
    touchSub: async () => undefined,
    addNotification: async (x) => {
      const id = String(++n).padStart(24, '0');
      notes.unshift({ id, ...x, read: false, createdAt: new Date().toISOString() });
      return id;
    },
    listNotifications: async (limit) => notes.slice(0, limit),
    markRead: async (ids) => {
      let c = 0;
      for (const x of notes) if (!x.read && (!ids || ids.includes(x.id))) ((x.read = true), c++);
      return c;
    },
    unreadCount: async () => notes.filter((x) => !x.read).length,
    getPrefs: async () => ({ ...prefs }),
    setPrefs: async (p) => ((prefs = { ...prefs, ...p }), { ...prefs }),
  };
}
const sub = (host: string): StoredSub => ({ endpoint: `https://${host}/push/abc`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(12) } });

describe('PushService', () => {
  it('records history and pushes an encrypted-payload message to every device', async () => {
    const repo = fakeRepo();
    await repo.saveSub(sub('a.example'));
    await repo.saveSub(sub('b.example'));
    const sender = vi.fn().mockResolvedValue(undefined);
    const svc = new PushService(repo, sender, 'PUBLIC');
    const out = await svc.send({ title: 'Reminder', body: 'Call Ravi', category: 'reminder', reminderId: 'r1', tag: 'reminder-r1', url: '/' });
    expect(out.delivered).toBe(2);
    expect(sender).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(sender.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({ title: 'Reminder', body: 'Call Ravi', category: 'reminder', reminderId: 'r1', tag: 'reminder-r1', url: '/' });
    expect(repo.notes).toHaveLength(1);
  });

  it('removes subscriptions the push service says are gone, but keeps them on temporary errors', async () => {
    const repo = fakeRepo();
    await repo.saveSub(sub('gone.example'));
    await repo.saveSub(sub('flaky.example'));
    await repo.saveSub(sub('ok.example'));
    const sender = vi.fn(async (s: StoredSub) => {
      if (s.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (s.endpoint.includes('flaky')) throw Object.assign(new Error('busy'), { statusCode: 503 });
    });
    const out = await new PushService(repo, sender, 'P').send({ title: 't', body: 'b' });
    expect(out).toMatchObject({ delivered: 1, removed: 1 });
    expect(repo.subs.map((s) => s.endpoint.split('/')[2]).sort()).toEqual(['flaky.example', 'ok.example']);
  });

  it('still saves history but sends nothing when a category is switched off', async () => {
    const repo = fakeRepo();
    await repo.saveSub(sub('a.example'));
    const sender = vi.fn().mockResolvedValue(undefined);
    const svc = new PushService(repo, sender, 'P');
    await svc.setPrefs({ news: false });
    const out = await svc.send({ title: 'News', body: 'x', category: 'news' });
    expect(out.delivered).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect(repo.notes).toHaveLength(1);
  });

  it('never throws, and only allows in-app relative links', async () => {
    const repo = fakeRepo();
    repo.addNotification = async () => {
      throw new Error('db down');
    };
    await expect(new PushService(repo, vi.fn(), 'P').send({ title: 't', body: 'b' })).resolves.toMatchObject({ delivered: 0 });
    const repo2 = fakeRepo();
    await repo2.saveSub(sub('a.example'));
    const sender = vi.fn().mockResolvedValue(undefined);
    await new PushService(repo2, sender, 'P').send({ title: 't', body: 'b', url: 'https://evil.example/x' });
    expect(JSON.parse(sender.mock.calls[0]![1] as string).url).toBe('/');
  });

  it('is disabled without a sender or public key', () => {
    expect(new PushService(fakeRepo(), undefined, undefined).enabled).toBe(false);
    expect(new PushService(fakeRepo(), vi.fn(), 'K').enabled).toBe(true);
  });
});

const TOKEN = 'web-token-1234567890';
function memStore(): MessageStore & { log: Array<{ direction: 'in' | 'out'; text: string }> } {
  const log: Array<{ direction: 'in' | 'out'; text: string }> = [];
  return {
    log,
    claimInbound: async (_i, _f, t) => (log.push({ direction: 'in', text: t }), true),
    saveOutbound: async (_i, _t, t) => void log.push({ direction: 'out', text: t }),
    recent: async () => log,
  };
}
function fakeSessions(): SessionRepo & { titles: Map<string, string> } {
  const titles = new Map<string, string>();
  let n = 0;
  return {
    titles,
    list: async () => [...titles].map(([id, title]) => ({ id, title, updatedAt: new Date().toISOString() })),
    create: async () => {
      const id = `s${++n}`;
      titles.set(id, 'New chat');
      return { id, title: 'New chat', updatedAt: new Date().toISOString() };
    },
    exists: async (id) => titles.has(id),
    rename: async (id, t) => (titles.has(id) ? (titles.set(id, t), true) : false),
    autoTitle: async (id, m) => void (titles.get(id) === 'New chat' && titles.set(id, m.slice(0, 48))),
    touch: async () => undefined,
    remove: async (id) => titles.delete(id),
  };
}

function setup(pushEnabled = true) {
  const repo = fakeRepo();
  const sender = vi.fn().mockResolvedValue(undefined);
  const push = new PushService(repo, pushEnabled ? sender : undefined, pushEnabled ? 'PUBKEY' : undefined);
  const mainStore = memStore();
  const sessionStores = new Map<string, ReturnType<typeof memStore>>();
  const sessions = fakeSessions();
  const mainRespond = vi.fn().mockResolvedValue('main reply');
  const sessionRespond = vi.fn().mockResolvedValue('session reply');
  const stopReminder = vi.fn().mockResolvedValue(true);
  const app = createApp({
    isDbConnected: () => true,
    extraRouters: [
      webChatRouter({
        token: TOKEN,
        respond: mainRespond,
        store: mainStore,
        ownerChatId: '555',
        sessions,
        storeFor: (id) => (sessionStores.get(id) ?? sessionStores.set(id, memStore()).get(id)!),
        respondFor: () => sessionRespond,
        push,
        stopReminder,
      }),
    ],
  });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  return { app, auth, repo, sender, sessions, sessionStores, mainRespond, sessionRespond, stopReminder, mainStore };
}

describe('web push routes', () => {
  it('require the token', async () => {
    const { app } = setup();
    for (const [m, p] of [['get', '/api/push/status'], ['post', '/api/push/subscribe'], ['post', '/api/push/test'], ['get', '/api/notifications'], ['post', '/api/reminders/' + 'a'.repeat(24) + '/stop']] as const) {
      expect((await request(app)[m](p)).status).toBe(401);
    }
  });

  it('reports status with the public key and rejects bad subscriptions', async () => {
    const { app, auth } = setup();
    const st = await request(app).get('/api/push/status').set(auth);
    expect(st.body).toMatchObject({ enabled: true, publicKey: 'PUBKEY', subscriptions: 0 });
    const bad = [
      { subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(12) } } },
      { subscription: { endpoint: 'https://ok.example/x', keys: { p256dh: 'x', auth: 'y' } } },
      {},
    ];
    for (const b of bad) expect((await request(app).post('/api/push/subscribe').set(auth).send(b)).status).toBe(400);
  });

  it('subscribes a device, sends a test notification, lists history and marks it read', async () => {
    const { app, auth, sender } = setup();
    const s = sub('fcm.example');
    expect((await request(app).post('/api/push/subscribe').set(auth).send({ subscription: s })).status).toBe(201);
    const t = await request(app).post('/api/push/test').set(auth);
    expect(t.body.delivered).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    const list = await request(app).get('/api/notifications').set(auth);
    expect(list.body.unread).toBe(1);
    expect(list.body.notifications[0]).toMatchObject({ title: 'MJ test notification', read: false });
    const read = await request(app).post('/api/notifications/read').set(auth).send({ ids: [list.body.notifications[0].id] });
    expect(read.body.updated).toBe(1);
    expect((await request(app).get('/api/notifications').set(auth)).body.unread).toBe(0);
    expect((await request(app).post('/api/push/unsubscribe').set(auth).send({ endpoint: s.endpoint })).body.ok).toBe(true);
    expect((await request(app).get('/api/push/status').set(auth)).body.subscriptions).toBe(0);
  });

  it('refuses to subscribe or test when push is not configured on the server', async () => {
    const { app, auth } = setup(false);
    expect((await request(app).post('/api/push/subscribe').set(auth).send({ subscription: sub('x.example') })).status).toBe(503);
    expect((await request(app).post('/api/push/test').set(auth)).status).toBe(503);
  });

  it('saves notification preferences and rejects unknown ones', async () => {
    const { app, auth } = setup();
    expect((await request(app).post('/api/push/prefs').set(auth).send({ news: false })).body).toMatchObject({ news: false, reminder: true });
    expect((await request(app).post('/api/push/prefs').set(auth).send({ hack: true })).status).toBe(400);
  });

  it('stops a reminder from the notification button, validating the id', async () => {
    const { app, auth, stopReminder } = setup();
    expect((await request(app).post('/api/reminders/not-an-id/stop').set(auth)).status).toBe(400);
    const id = 'a'.repeat(24);
    expect((await request(app).post(`/api/reminders/${id}/stop`).set(auth)).body).toEqual({ stopped: true });
    expect(stopReminder).toHaveBeenCalledWith(id);
  });
});

describe('web chat sessions', () => {
  it('creates chats, keeps each chat separate from the shared Telegram one, and titles them', async () => {
    const { app, auth, sessionStores, mainStore, mainRespond, sessionRespond, sessions } = setup();
    const created = await request(app).post('/api/sessions').set(auth);
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const chat = await request(app).post('/api/chat').set(auth).send({ query: 'Plan my trip to Ooty', session_id: id });
    expect(chat.body.reply).toBe('session reply');
    expect(sessionRespond).toHaveBeenCalledWith('Plan my trip to Ooty', { channel: 'telegram', chatId: '555' });
    expect(mainRespond).not.toHaveBeenCalled();
    expect(mainStore.log).toHaveLength(0);
    expect(sessionStores.get(id)!.log.map((m) => m.text)).toEqual(['Plan my trip to Ooty', 'session reply']);
    expect(sessions.titles.get(id)).toBe('Plan my trip to Ooty');

    const main = await request(app).post('/api/chat').set(auth).send({ query: 'hello' });
    expect(main.body.reply).toBe('main reply');
    expect(mainStore.log).toHaveLength(2);

    const hist = await request(app).get(`/api/history?session_id=${id}`).set(auth);
    expect(hist.body.messages).toEqual([
      { role: 'user', text: 'Plan my trip to Ooty' },
      { role: 'assistant', text: 'session reply' },
    ]);
  });

  it('lists, renames and deletes chats, and returns 404 for unknown ones', async () => {
    const { app, auth } = setup();
    const id = (await request(app).post('/api/sessions').set(auth)).body.id as string;
    expect((await request(app).get('/api/sessions').set(auth)).body.sessions).toHaveLength(1);
    expect((await request(app).patch(`/api/sessions/${id}`).set(auth).send({ title: 'Trip' })).body.ok).toBe(true);
    expect((await request(app).patch(`/api/sessions/${id}`).set(auth).send({ title: '' })).status).toBe(400);
    expect((await request(app).delete(`/api/sessions/${id}`).set(auth)).body.ok).toBe(true);
    expect((await request(app).post('/api/chat').set(auth).send({ query: 'hi', session_id: id })).status).toBe(404);
    expect((await request(app).get('/api/history?session_id=nope').set(auth)).status).toBe(404);
  });
});
