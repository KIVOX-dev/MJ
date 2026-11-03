import { JobRunModel } from '../models/job-run.model';

export interface JobRunRecord {
  key: string;
  kind: string;
  channel: string;
  chatId: string;
  attempts: number;
}

export interface NewJobRun {
  key: string;
  kind: string;
  channel: string;
  chatId: string;
  timezone: string;
  scheduledFor: Date;
}

export const MAX_JOB_ATTEMPTS = 3;

export interface JobRunRepo {
  /** Creates the run record if it does not exist yet (idempotent by key). */
  ensure(r: NewJobRun, now: Date): Promise<void>;
  /** Atomically claims a run that is new, due for retry, or stuck "running". Null if someone else has it or it is done. */
  claim(key: string, now: Date): Promise<JobRunRecord | null>;
  markSent(key: string, now: Date): Promise<void>;
  markFailed(key: string, error: string, retryAt: Date): Promise<void>;
  /** Stores a prepared result (e.g. the morning digest text) with the run. */
  savePayload(key: string, payload: string): Promise<void>;
  getPayload(key: string): Promise<string | null>;
}

const STALE_LOCK_MS = 10 * 60_000;

export class MongoJobRunRepo implements JobRunRepo {
  async ensure(r: NewJobRun, now: Date): Promise<void> {
    await JobRunModel.updateOne({ key: r.key }, { $setOnInsert: { ...r, status: 'new', attempts: 0, runAfter: now } }, { upsert: true });
  }

  async claim(key: string, now: Date): Promise<JobRunRecord | null> {
    const stale = new Date(now.getTime() - STALE_LOCK_MS);
    const d = await JobRunModel.findOneAndUpdate(
      {
        key,
        $or: [
          { status: 'new' },
          { status: 'failed', attempts: { $lt: MAX_JOB_ATTEMPTS }, runAfter: { $lte: now } },
          { status: 'running', lockedAt: { $lte: stale }, attempts: { $lt: MAX_JOB_ATTEMPTS } },
        ],
      },
      { $set: { status: 'running', lockedAt: now }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    ).lean();
    return d ? { key: d.key, kind: d.kind, channel: d.channel, chatId: d.chatId, attempts: d.attempts ?? 0 } : null;
  }

  async markSent(key: string, now: Date): Promise<void> {
    await JobRunModel.updateOne({ key }, { $set: { status: 'sent', sentAt: now }, $unset: { lockedAt: 1 } });
  }

  async markFailed(key: string, error: string, retryAt: Date): Promise<void> {
    await JobRunModel.updateOne({ key }, { $set: { status: 'failed', lastError: error.slice(0, 300), runAfter: retryAt }, $unset: { lockedAt: 1 } });
  }

  async savePayload(key: string, payload: string): Promise<void> {
    await JobRunModel.updateOne({ key }, { $set: { payload } });
  }

  async getPayload(key: string): Promise<string | null> {
    const d = await JobRunModel.findOne({ key }, { payload: 1 }).lean();
    return d?.payload ?? null;
  }
}
