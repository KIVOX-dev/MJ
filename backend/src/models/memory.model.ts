import { Schema, model } from 'mongoose';

/** A lasting fact MJ knows about its owner (name, studies, work, goals, preferences...). One owner, so no user key. */
const memorySchema = new Schema(
  {
    fact: { type: String, required: true, maxlength: 300 },
    category: { type: String, enum: ['profile', 'preference', 'goal', 'contact', 'other'], default: 'other' },
    /** Where it came from: "chat" (told to MJ) or "import". */
    source: { type: String, default: 'chat' },
    /** Normalised-text hash: the same fact is never stored twice. */
    hash: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);
memorySchema.index({ category: 1, createdAt: -1 });

export const MemoryModel = model('Memory', memorySchema);
