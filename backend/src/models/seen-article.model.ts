import { Schema, model } from 'mongoose';

/** Remembers which headlines were already processed so alerts are never repeated. Auto-expires after 7 days. */
const seenSchema = new Schema(
  {
    kind: { type: String, required: true },
    key: { type: String, required: true },
    alerted: { type: Boolean, default: false },
    createdAt: { type: Date, default: () => new Date(), expires: 7 * 24 * 3600 },
  },
  { versionKey: false },
);
seenSchema.index({ kind: 1, key: 1 }, { unique: true });
seenSchema.index({ kind: 1, alerted: 1, createdAt: -1 });

export const SeenArticleModel = model('SeenArticle', seenSchema);
