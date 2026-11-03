import crypto from 'node:crypto';
import { logger } from '../../../utils/logger';
import type { Channel } from '../../../core/memory/message.store';
import type { ReminderRecord, ReminderRepo } from './reminder.repo';

export type Notify = (channel: Channel, chatId: string, text: string) => Promise<void>;

const MAX_ATTEMPTS = 3;
const MAX_HORIZON_MS = 366 * 24 * 3600_000;

export class ReminderService {
  constructor(
    private readonly repo: ReminderRepo,
    private readonly timezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(channel: Channel, chatId: string, text: string, dueAt: Date): Promise<ReminderRecord> {
    const t = this.now().getTime();
    if (Number.isNaN(dueAt.getTime())) throw new Error('Invalid reminder time');
    if (dueAt.getTime() < t - 30_000) throw new Error('That time is in the past');
    if (dueAt.getTime() > t + MAX_HORIZON_MS) throw new Error('Reminders can be at most one year ahead');
    // Same chat + minute + text => same reminder (guards against the model calling the tool twice).
    const minute = Math.floor(dueAt.getTime() / 60_000);
    const idempotencyKey = crypto.createHash('sha256').update(`${channel}:${chatId}:${minute}:${text}`).digest('hex');
    return this.repo.create({ channel, chatId, text, dueAt, timezone: this.timezone, idempotencyKey });
  }

  list(channel: Channel, chatId: string): Promise<ReminderRecord[]> {
    return this.repo.listPending(channel, chatId, 25);
  }

  cancel(channel: Channel, chatId: string, id: string): Promise<boolean> {
    return this.repo.cancel(channel, chatId, id);
  }

  /** Sends every due reminder. Safe to call concurrently (claims are atomic) and repeatedly. */
  async dispatchDue(notify: Notify): Promise<{ sent: number; retried: number; failed: number }> {
    const out = { sent: 0, retried: 0, failed: 0 };
    for (let i = 0; i < 50; i++) {
      const r = await this.repo.claimDue(this.now());
      if (!r) break;
      try {
        await notify(r.channel, r.chatId, `⏰ Reminder, Sir: ${r.text}`);
        await this.repo.markSent(r.id, this.now());
        out.sent++;
      } catch (err) {
        const msg = (err as Error).message.slice(0, 300);
        if (r.attempts >= MAX_ATTEMPTS) {
          await this.repo.markFailed(r.id, msg);
          out.failed++;
          logger.error({ id: r.id, err: { message: msg } }, 'Reminder failed permanently');
        } else {
          await this.repo.reschedule(r.id, new Date(this.now().getTime() + 60_000 * r.attempts), msg);
          out.retried++;
          logger.warn({ id: r.id, attempts: r.attempts, err: { message: msg } }, 'Reminder delivery failed, will retry');
        }
      }
    }
    return out;
  }
}
