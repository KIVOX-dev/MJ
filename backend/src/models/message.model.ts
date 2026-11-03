import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    waMessageId: { type: String, required: true, unique: true }, // dedupe key (Meta "wamid")
    from: { type: String, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    text: { type: String, default: '' },
    type: { type: String, default: 'text' },
  },
  { timestamps: true },
);
messageSchema.index({ createdAt: -1 });

export const MessageModel = model('Message', messageSchema);
