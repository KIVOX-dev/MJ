import { Schema, model } from 'mongoose';

/** One row per scheduled job execution (e.g. one daily news digest per channel per day). */
const jobRunSchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // idempotency key
    kind: { type: String, required: true },
    channel: { type: String, required: true },
    chatId: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: ['new', 'running', 'sent', 'failed'], default: 'new' },
    attempts: { type: Number, default: 0 },
    runAfter: { type: Date, required: true },
    lockedAt: { type: Date },
    lastError: { type: String },
    sentAt: { type: Date },
    payload: { type: String },
  },
  { timestamps: true },
);
jobRunSchema.index({ kind: 1, scheduledFor: -1 });
// housekeeping: run records expire after 14 days
jobRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });

export const JobRunModel = model('JobRun', jobRunSchema);
