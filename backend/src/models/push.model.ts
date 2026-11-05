import { Schema, model } from 'mongoose';

/** One browser/phone that agreed to receive push notifications (single owner, possibly several devices). */
const pushSubscriptionSchema = new Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: { type: String },
    lastSuccessAt: { type: Date },
  },
  { timestamps: true },
);
export const PushSubscriptionModel = model('PushSubscription', pushSubscriptionSchema);

/** Notification history shown inside the app (read/unread). Removed automatically after 30 days. */
const notificationSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, default: '' },
    url: { type: String, default: '/' },
    category: { type: String, enum: ['reminder', 'alert', 'news', 'system'], default: 'system' },
    reminderId: { type: String },
    readAt: { type: Date },
    createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
  },
  { versionKey: false },
);
notificationSchema.index({ createdAt: -1 });
export const NotificationModel = model('Notification', notificationSchema);

/** Which kinds of notification the owner wants as push. */
const pushPrefSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    reminder: { type: Boolean, default: true },
    alert: { type: Boolean, default: true },
    news: { type: Boolean, default: true },
    system: { type: Boolean, default: true },
  },
  { versionKey: false },
);
export const PushPrefModel = model('PushPref', pushPrefSchema);

/** A separate chat in the web app (like ChatGPT's conversations). The default chat is the shared Telegram one. */
const chatSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    title: { type: String, default: 'New chat' },
  },
  { timestamps: true },
);
chatSessionSchema.index({ updatedAt: -1 });
export const ChatSessionModel = model('ChatSession', chatSessionSchema);
