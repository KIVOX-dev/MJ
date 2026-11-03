import { SeenArticleModel } from '../models/seen-article.model';

export interface SeenRepo {
  /** Returns the subset of keys not seen before. */
  unseen(kind: string, keys: string[]): Promise<string[]>;
  mark(kind: string, keys: string[], alerted: boolean): Promise<void>;
  alertedCountSince(kind: string, since: Date): Promise<number>;
}

export class MongoSeenRepo implements SeenRepo {
  async unseen(kind: string, keys: string[]): Promise<string[]> {
    if (!keys.length) return [];
    const found = await SeenArticleModel.find({ kind, key: { $in: keys } }, { key: 1 }).lean();
    const have = new Set(found.map((d) => d.key));
    return keys.filter((k) => !have.has(k));
  }

  async mark(kind: string, keys: string[], alerted: boolean): Promise<void> {
    if (!keys.length) return;
    await SeenArticleModel.bulkWrite(
      keys.map((key) => ({
        updateOne: { filter: { kind, key }, update: { $setOnInsert: { kind, key, alerted, createdAt: new Date() } }, upsert: true },
      })),
      { ordered: false },
    );
  }

  alertedCountSince(kind: string, since: Date): Promise<number> {
    return SeenArticleModel.countDocuments({ kind, alerted: true, createdAt: { $gte: since } });
  }
}
