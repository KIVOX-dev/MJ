/* MJ service worker: shows push notifications while the app is closed and handles taps on them. */

const DB = 'mj-sw';

function readConfig() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('cfg');
      open.onsuccess = () => {
        const get = open.result.transaction('cfg').objectStore('cfg').get('cfg');
        get.onsuccess = () => resolve(get.result || {});
        get.onerror = () => resolve({});
      };
      open.onerror = () => resolve({});
    } catch (e) {
      resolve({});
    }
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'MJ', body: event.data ? event.data.text() : '' };
  }
  if (!data || typeof data !== 'object') data = {};
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'MJ';
  const body = typeof data.body === 'string' ? data.body.slice(0, 300) : '';
  const isReminder = data.category === 'reminder' && typeof data.reminderId === 'string';
  const actions = isReminder ? [{ action: 'stop', title: 'Stop' }, { action: 'open', title: 'Open' }] : [{ action: 'open', title: 'Open' }];
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      renotify: typeof data.tag === 'string',
      vibrate: [200, 100, 200],
      requireInteraction: isReminder,
      actions,
      data: { url: typeof data.url === 'string' ? data.url : '/', id: data.id, reminderId: isReminder ? data.reminderId : undefined },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();

  // "Stop" button on a repeating reminder: stop it on the server without opening the app.
  if (event.action === 'stop' && d.reminderId) {
    event.waitUntil(
      (async () => {
        const cfg = await readConfig();
        let stopped = false;
        try {
          const res = await fetch((cfg.url || '') + '/api/reminders/' + d.reminderId + '/stop', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + (cfg.token || '') },
          });
          stopped = res.ok;
        } catch (e) {
          stopped = false;
        }
        await self.registration.showNotification(stopped ? 'Reminder stopped' : 'Could not stop the reminder', {
          body: stopped ? 'I will not remind you about that again, Sir.' : 'Please open MJ and press Stop there.',
          icon: '/icon-192.png',
          badge: '/badge-96.png',
          tag: 'reminder-stop-result',
        });
      })(),
    );
    return;
  }

  const target = new URL(d.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          c.postMessage({ type: 'notification-click', url: d.url || '/', id: d.id });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
