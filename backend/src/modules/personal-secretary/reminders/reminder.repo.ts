import { ReminderModel } from '../../../models/reminder.model';
import type { Channel } from '../../../core/memory/message.store';

export interface ReminderRecord {
  id: string;
  channel: Channel;
  chatId: string;
  text: string;
  dueAt: Date;
  attempts: number;
}

export interface NewReminder {
  channel: Channel;
  chatId: string;
  text: string;
  dueAt: Date;
  timezone: string;
  idempotencyKey: string;
}

export interface ReminderRepo {
  /** Idempotent: the same idempotencyKey returns the existing reminder instead of a duplicate. */
  create(r: NewReminder): Promise<ReminderRecord>;
  listPending(channel: Channel, chatId: string, limit: number): Promise<ReminderRecord[]>;
  cancel(channel: Channel, chatId: string, id: string): Promise<boolean>;
  /** Atomically claims one due reminder (also recovers ones stuck in "processing"). */
  claimDue(now: Date): Promise<ReminderRecord | null>;
  markSent(id: string, now: Date): Promise<void>;
  reschedule(id: string, dueAt: Date, error: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

const STALE_LOCK_MS = 5 * 60_000;

const toRecord = (d: any): ReminderRecord => ({
  id: String(d._id),
  channel: d.channel,
  chatId: d.chatId,
  text: d.text,
  dueAt: d.dueAt,
  attempts: d.attempts ?? 0,
});

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
    const docs = await ReminderModel.find({ channel, chatId, status: { $in: ['pending', 'processing'] } })
      .sort({ dueAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(toRecord);
  }

  async cancel(channel: Channel, chatId: string, id: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return false;
    const res = await ReminderModel.updateOne({ _id: id, channel, chatId, status: 'pending' }, { $set: { status: 'cancelled' } });
    return res.modifiedCount === 1;
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

  async markSent(id: string, now: Date): Promise<void> {
    await ReminderModel.updateOne({ _id: id }, { $set: { status: 'sent', sentAt: now }, $unset: { lockedAt: 1 } });
  }

  async reschedule(id: string, dueAt: Date, error: string): Promise<void> {
    await ReminderModel.updateOne({ _id: id }, { $set: { status: 'pending', dueAt, lastError: error }, $unset: { lockedAt: 1 } });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await ReminderModel.updateOne({ _id: id }, { $set: { status: 'failed', lastError: error }, $unset: { lockedAt: 1 } });
  }
}
