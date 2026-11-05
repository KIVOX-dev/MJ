import { Schema, model } from 'mongoose';

/** A picture MJ generated. The random 128-bit id is the only way to fetch it, so the link cannot be guessed. Removed after 30 days. */
const generatedImageSchema = new Schema(
  {
    imageId: { type: String, required: true, unique: true },
    mime: { type: String, required: true },
    data: { type: Buffer, required: true },
    prompt: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
  },
  { versionKey: false },
);

export const GeneratedImageModel = model('GeneratedImage', generatedImageSchema);
