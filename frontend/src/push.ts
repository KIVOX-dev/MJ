import { getPushStatus, subscribePush, unsubscribePush, type Settings } from './api';

export type PushState = 'unsupported' | 'ios-install' | 'blocked' | 'off' | 'on';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* an unsupported or blocked environment just means no push */
  }
}

/** The service worker cannot read localStorage, so the address and token it needs for the notification's Stop button live in IndexedDB. */
export function writeSwConfig(s: Settings): Promise<void> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('mj-sw', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('cfg');
      open.onsuccess = () => {
        const tx = open.result.transaction('cfg', 'readwrite');
        tx.objectStore('cfg').put({ url: s.url, token: s.token }, 'cfg');
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      open.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await registerServiceWorker();
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    return await (await registration()).pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && (await currentSubscription()) ? 'on' : 'off';
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks for permission (only called from a button tap), subscribes this device and registers it with the backend. */
export async function enablePush(s: Settings): Promise<void> {
  if (!pushSupported()) throw new Error('This browser cannot receive push notifications.');
  const status = await getPushStatus(s);
  if (!status.enabled || !status.publicKey) throw new Error('Notifications are not set up on the server yet (VAPID keys missing).');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can allow them in your browser settings.');
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) }));
  await subscribePush(s, sub.toJSON());
}

export async function disablePush(s: Settings): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await unsubscribePush(s, endpoint).catch(() => undefined);
}

/** Quietly re-registers this device when permission was granted earlier (e.g. the subscription expired or the server forgot it). */
export async function refreshSubscription(s: Settings): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const status = await getPushStatus(s);
    if (!status.enabled || !status.publicKey) return;
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) }));
    await subscribePush(s, sub.toJSON());
  } catch {
    /* best effort */
  }
}
