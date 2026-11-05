import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    channel: { type: String, enum: ['whatsapp', 'telegram'], required: true },
    externalId: { type: String, required: true }, // dedupe key (Meta "wamid" / Telegram update_id)
    from: { type: String, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    text: { type: String, default: '' },
    type: { type: String, default: 'text' },
    /** Set for chats started in the web app; empty for the shared Telegram conversation. */
    sessionId: { type: String },
  },
  { timestamps: true },
);
messageSchema.index({ channel: 1, externalId: 1 }, { unique: true });
messageSchema.index({ channel: 1, createdAt: -1 });
messageSchema.index({ sessionId: 1, createdAt: -1 });

export const MessageModel = model('Message', messageSchema);
