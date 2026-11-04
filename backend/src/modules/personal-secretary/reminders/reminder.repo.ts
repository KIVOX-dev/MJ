import { ReminderModel } from '../../../models/reminder.model';
import type { Channel } from '../../../core/memory/message.store';

export interface ReminderRecord {
  id: string;
  channel: Channel;
  chatId: string;
  text: string;
  dueAt: Date;
  attempts: number;
  repeatEveryMin?: number;
  sentCount: number;
}

export interface NewReminder {
  channel: Channel;
  chatId: string;
  text: string;
  dueAt: Date;
  timezone: string;
  idempotencyKey: string;
  repeatEveryMin?: number;
}

export interface ReminderRepo {
  /** Idempotent: the same idempotencyKey returns the existing reminder instead of a duplicate. */
  create(r: NewReminder): Promise<ReminderRecord>;
  listPending(channel: Channel, chatId: string, limit: number): Promise<ReminderRecord[]>;
  /** Stops one pending or currently-being-sent reminder (also used by the Stop button). */
  cancel(channel: Channel, chatId: string, id: string): Promise<boolean>;
  /** Stops every pending reminder of a chat; returns how many were stopped. */
  cancelAll(channel: Channel, chatId: string): Promise<number>;
  /** Atomically claims one due reminder (also recovers ones stuck in "processing"). */
  claimDue(now: Date): Promise<ReminderRecord | null>;
  markSent(id: string, now: Date): Promise<void>;
  /** After a successful delivery of a repeating reminder: schedule the next one. */
  scheduleNext(id: string, dueAt: Date): Promise<void>;
  reschedule(id: string, dueAt: Date, error: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

const STALE_LOCK_MS = 5 * 60_000;
const ACTIVE: Array<'pending' | 'processing'> = ['pending', 'processing'];

const toRecord = (d: any): ReminderRecord => ({
  id: String(d._id),
  channel: d.channel,
  chatId: d.chatId,
  text: d.text,
  dueAt: d.dueAt,
  attempts: d.attempts ?? 0,
  repeatEveryMin: d.repeatEveryMin ?? undefined,
  sentCount: d.sentCount ?? 0,
});

const validId = (id: string) => /^[a-f0-9]{24}$/i.test(id);

export class MongoReminderRepo implements ReminderRepo {
  async create(r: NewReminder): Promise<ReminderRecord> {
    const { idempotencyKey, ...fields } = r;
    const doc = await ReminderModel.findOneAndUpdate(
      { idempotencyKey },
      { $setOnInsert: { ...fields, idempotencyKey, status: 'pending' } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return toRecord(doc);
  }

  async listPending(channel: Channel, chatId: string, limit: number): Promise<ReminderRecord[]> {
    const docs = await ReminderModel.find({ channel, chatId, status: { $in: ACTIVE } })
      .sort({ dueAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(toRecord);
  }

  async cancel(channel: Channel, chatId: string, id: string): Promise<boolean> {
    if (!validId(id)) return false;
    const res = await ReminderModel.updateOne({ _id: id, channel, chatId, status: { $in: ACTIVE } }, { $set: { status: 'cancelled' }, $unset: { lockedAt: 1 } });
    return res.modifiedCount === 1;
  }

  async cancelAll(channel: Channel, chatId: string): Promise<number> {
    const res = await ReminderModel.updateMany({ channel, chatId, status: { $in: ACTIVE } }, { $set: { status: 'cancelled' }, $unset: { lockedAt: 1 } });
    return res.modifiedCount;
  }

  async claimDue(now: Date): Promise<ReminderRecord | null> {
    const stale = new Date(now.getTime() - STALE_LOCK_MS);
    const doc = await ReminderModel.findOneAndUpdate(
      { $or: [{ status: 'pending', dueAt: { $lte: now } }, { status: 'processing', lockedAt: { $lte: stale } }] },
      { $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
      { sort: { dueAt: 1 }, returnDocument: 'after' },
    ).lean();
    return doc ? toRecord(doc) : null;
  }

  // The follow-up updates below only apply while the reminder is still "processing", so a Stop pressed while a
  // delivery was in flight (status already "cancelled") can never be overwritten back to pending.
  async markSent(id: string, now: Date): Promise<void> {
    await ReminderModel.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'sent', sentAt: now }, $inc: { sentCount: 1 }, $unset: { lockedAt: 1 } });
  }

  async scheduleNext(id: string, dueAt: Date): Promise<void> {
    await ReminderModel.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'pending', dueAt, attempts: 0 }, $inc: { sentCount: 1 }, $unset: { lockedAt: 1, lastError: 1 } });
  }

  async reschedule(id: string, dueAt: Date, error: string): Promise<void> {
    await ReminderModel.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'pending', dueAt, lastError: error }, $unset: { lockedAt: 1 } });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await ReminderModel.updateOne({ _id: id, status: 'processing' }, { $set: { status: 'failed', lastError: error }, $unset: { lockedAt: 1 } });
  }
}
