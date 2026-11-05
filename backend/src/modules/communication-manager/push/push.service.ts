import webpush from 'web-push';
import { logger } from '../../../utils/logger';
import { NotificationModel, PushPrefModel, PushSubscriptionModel } from '../../../models/push.model';

export type Category = 'reminder' | 'alert' | 'news' | 'system';
export const CATEGORIES: Category[] = ['reminder', 'alert', 'news', 'system'];

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap should open, relative to the app (e.g. "/"). */
  url?: string;
  category?: Category;
  /** Notifications with the same tag replace each other (e.g. one slot per reminder). */
  tag?: string;
  /** Lets the Stop button on the notification stop a repeating reminder. */
  reminderId?: string;
}

export interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  url: string;
  category: Category;
  reminderId?: string;
  read: boolean;
  createdAt: string;
}

export type Prefs = Record<Category, boolean>;

export interface PushRepo {
  saveSub(s: StoredSub): Promise<void>;
  removeSub(endpoint: string): Promise<void>;
  listSubs(): Promise<StoredSub[]>;
  touchSub(endpoint: string): Promise<void>;
  addNotification(n: { title: string; body: string; url: string; category: Category; reminderId?: string }): Promise<string>;
  listNotifications(limit: number): Promise<NotificationRecord[]>;
  /** Marks the given ids (or everything when ids is omitted) as read; returns how many changed. */
  markRead(ids?: string[]): Promise<number>;
  unreadCount(): Promise<number>;
  getPrefs(): Promise<Prefs>;
  setPrefs(p: Partial<Prefs>): Promise<Prefs>;
}

/** Sends one encrypted payload to one subscription. Must throw an error with `statusCode` on HTTP failures. */
export type PushSender = (sub: StoredSub, payload: string) => Promise<void>;

export function makeWebPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (sub, payload) => {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 6 * 3600, urgency: 'high' });
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class PushService {
  constructor(
    private readonly repo: PushRepo,
    private readonly sender: PushSender | undefined,
    /** Public VAPID key given to browsers so they can subscribe. */
    readonly publicKey: string | undefined,
  ) {}

  get enabled(): boolean {
    return !!this.sender && !!this.publicKey;
  }

  async subscribe(sub: StoredSub): Promise<void> {
    await this.repo.saveSub(sub);
  }

  unsubscribe(endpoint: string): Promise<void> {
    return this.repo.removeSub(endpoint);
  }

  async status(): Promise<{ enabled: boolean; publicKey?: string; subscriptions: number; unread: number }> {
    const [subs, unread] = await Promise.all([this.repo.listSubs(), this.repo.unreadCount()]);
    return { enabled: this.enabled, publicKey: this.publicKey, subscriptions: subs.length, unread };
  }

  getPrefs = () => this.repo.getPrefs();
  setPrefs = (p: Partial<Prefs>) => this.repo.setPrefs(p);
  list = (limit: number) => this.repo.listNotifications(limit);
  markRead = (ids?: string[]) => this.repo.markRead(ids);

  /**
   * Records the notification in the in-app history and pushes it to every subscribed device.
   * Never throws: a push problem must not break reminders or news delivery.
   * Subscriptions the push service reports as gone (404/410) are removed.
   */
  async send(p: PushPayload): Promise<{ id?: string; delivered: number; removed: number }> {
    const category = p.category ?? 'system';
    const title = clip(p.title, 80);
    const body = clip(p.body, 300);
    const url = p.url && p.url.startsWith('/') ? p.url : '/';
    try {
      const id = await this.repo.addNotification({ title, body, url, category, reminderId: p.reminderId });
      if (!this.sender) return { id, delivered: 0, removed: 0 };
      const [prefs, subs] = await Promise.all([this.repo.getPrefs(), this.repo.listSubs()]);
      if (!prefs[category] || !subs.length) return { id, delivered: 0, removed: 0 };
      const payload = JSON.stringify({ id, title, body, url, category, tag: p.tag, reminderId: p.reminderId, ts: Date.now() });
      let delivered = 0;
      let removed = 0;
      await Promise.all(
        subs.map(async (s) => {
          try {
            await this.sender!(s, payload);
            delivered++;
            await this.repo.touchSub(s.endpoint);
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) {
              removed++;
              await this.repo.removeSub(s.endpoint);
            } else {
              logger.warn({ code, err: { message: (err as Error).message } }, 'Push delivery failed');
            }
          }
        }),
      );
      return { id, delivered, removed };
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Push send failed');
      return { delivered: 0, removed: 0 };
    }
  }
}

const DEFAULT_PREFS: Prefs = { reminder: true, alert: true, news: true, system: true };

export class MongoPushRepo implements PushRepo {
  async saveSub(s: StoredSub): Promise<void> {
    await PushSubscriptionModel.updateOne({ endpoint: s.endpoint }, { $set: { keys: s.keys, userAgent: s.userAgent?.slice(0, 200) } }, { upsert: true });
  }
  async removeSub(endpoint: string): Promise<void> {
    await PushSubscriptionModel.deleteOne({ endpoint });
  }
  async listSubs(): Promise<StoredSub[]> {
    const docs = await PushSubscriptionModel.find().lean();
    return docs.map((d) => ({ endpoint: d.endpoint, keys: { p256dh: d.keys!.p256dh, auth: d.keys!.auth }, userAgent: d.userAgent ?? undefined }));
  }
  async touchSub(endpoint: string): Promise<void> {
    await PushSubscriptionModel.updateOne({ endpoint }, { $set: { lastSuccessAt: new Date() } });
  }
  async addNotification(n: { title: string; body: string; url: string; category: Category; reminderId?: string }): Promise<string> {
    const d = await NotificationModel.create(n);
    return String(d._id);
  }
  async listNotifications(limit: number): Promise<NotificationRecord[]> {
    const docs = await NotificationModel.find().sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      body: d.body ?? '',
      url: d.url ?? '/',
      category: (d.category ?? 'system') as Category,
      reminderId: d.reminderId ?? undefined,
      read: !!d.readAt,
      createdAt: new Date(d.createdAt as Date).toISOString(),
    }));
  }
  async markRead(ids?: string[]): Promise<number> {
    const filter = ids ? { _id: { $in: ids.filter((i) => /^[a-f0-9]{24}$/i.test(i)) }, readAt: null } : { readAt: null };
    const r = await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } });
    return r.modifiedCount;
  }
  async unreadCount(): Promise<number> {
    return NotificationModel.countDocuments({ readAt: null });
  }
  async getPrefs(): Promise<Prefs> {
    const d = await PushPrefModel.findOne({ key: 'owner' }).lean();
    return d ? { reminder: d.reminder !== false, alert: d.alert !== false, news: d.news !== false, system: d.system !== false } : { ...DEFAULT_PREFS };
  }
  async setPrefs(p: Partial<Prefs>): Promise<Prefs> {
    const clean = Object.fromEntries(Object.entries(p).filter(([k, v]) => (CATEGORIES as string[]).includes(k) && typeof v === 'boolean'));
    await PushPrefModel.updateOne({ key: 'owner' }, { $set: clean }, { upsert: true });
    return this.getPrefs();
  }
}
