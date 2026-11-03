import { Schema, model } from 'mongoose';

const reminderSchema = new Schema(
  {
    channel: { type: String, enum: ['whatsapp', 'telegram'], required: true },
    chatId: { type: String, required: true },
    text: { type: String, required: true },
    dueAt: { type: Date, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    status: { type: String, enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date },
    lastError: { type: String },
    sentAt: { type: Date },
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);
reminderSchema.index({ status: 1, dueAt: 1 });
reminderSchema.index({ channel: 1, chatId: 1, status: 1 });

export const ReminderModel = model('Reminder', reminderSchema);
