import crypto from 'node:crypto';
import { MemoryModel } from '../../models/memory.model';

export type MemoryCategory = 'profile' | 'preference' | 'goal' | 'contact' | 'other';

export interface MemoryRecord {
  id: string;
  fact: string;
  category: MemoryCategory;
}

export interface MemoryRepo {
  /** Idempotent by hash. Returns the stored record and whether it already existed. */
  add(fact: string, category: MemoryCategory, hash: string, source: string): Promise<{ record: MemoryRecord; duplicate: boolean }>;
  listAll(limit: number): Promise<MemoryRecord[]>;
  remove(id: string): Promise<boolean>;
  removeAll(): Promise<number>;
  count(): Promise<number>;
}

const MAX_FACTS = 300;

/** Credentials never go into memory (spec: no sensitive secrets in stored personal data). */
const SENSITIVE =
  /\b(password|passcode|passwd|otp|cvv|card number|api[ _-]?key|secret key|access token|refresh token|private key|pin code)\b|\b(gsk_|sk-|AIza|ghp_|xox[bp]-|EAA[A-Za-z0-9])[A-Za-z0-9_-]{8,}|\b[A-Fa-f0-9]{32,}\b|\b\d{13,19}\b/i;

const STOP = new Set(['the', 'and', 'for', 'you', 'are', 'was', 'what', 'who', 'how', 'when', 'where', 'why', 'can', 'could', 'would', 'about', 'with', 'this', 'that', 'have', 'has', 'from', 'tell', 'please', 'know', 'does', 'did', 'your', 'mine', 'sir']);
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class MongoMemoryRepo implements MemoryRepo {
  async add(fact: string, category: MemoryCategory, hash: string, source: string) {
    const before = await MemoryModel.findOne({ hash }).lean();
    if (before) return { record: { id: String(before._id), fact: before.fact, category: before.category as MemoryCategory }, duplicate: true };
    const d = await MemoryModel.findOneAndUpdate({ hash }, { $setOnInsert: { fact, category, hash, source } }, { upsert: true, returnDocument: 'after' }).lean();
    return { record: { id: String(d!._id), fact: d!.fact, category: d!.category as MemoryCategory }, duplicate: false };
  }
  async listAll(limit: number): Promise<MemoryRecord[]> {
    const docs = await MemoryModel.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map((d) => ({ id: String(d._id), fact: d.fact, category: d.category as MemoryCategory }));
  }
  async remove(id: string): Promise<boolean> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return false;
    return (await MemoryModel.deleteOne({ _id: id })).deletedCount === 1;
  }
  async removeAll(): Promise<number> {
    return (await MemoryModel.deleteMany({})).deletedCount;
  }
  count(): Promise<number> {
    return MemoryModel.countDocuments({});
  }
}

export class MemoryService {
  constructor(private readonly repo: MemoryRepo) {}

  async remember(fact: string, category: MemoryCategory = 'other', source = 'chat'): Promise<{ id: string; fact: string; duplicate: boolean }> {
    const text = fact.replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 300) throw new Error('A memory must be 3 to 300 characters');
    if (SENSITIVE.test(text)) throw new Error('I do not store passwords, keys, tokens or card numbers');
    if ((await this.repo.count()) >= MAX_FACTS) throw new Error('Memory is full; ask me to forget something first');
    const hash = crypto.createHash('sha256').update(norm(text)).digest('hex');
    const { record, duplicate } = await this.repo.add(text, category, hash, source);
    return { id: record.id, fact: record.fact, duplicate };
  }

  list(): Promise<MemoryRecord[]> {
    return this.repo.listAll(MAX_FACTS);
  }

  forget(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  forgetAll(): Promise<number> {
    return this.repo.removeAll();
  }

  /**
   * Relevance-based recall (instead of sending every memory every time): core profile facts always,
   * plus the other facts that best match the words of the current message.
   */
  async recall(query: string, limit = 14): Promise<string[]> {
    const all = await this.repo.listAll(MAX_FACTS);
    if (!all.length) return [];
    const q = new Set(words(query));
    const scored = all.map((m) => ({ m, score: words(m.fact).filter((w) => q.has(w)).length }));
    const core = all.filter((m) => m.category === 'profile').slice(0, 8);
    const coreIds = new Set(core.map((m) => m.id));
    const related = scored.filter((s) => s.score > 0 && !coreIds.has(s.m.id)).sort((a, b) => b.score - a.score).map((s) => s.m);
    return [...core, ...related].slice(0, limit).map((m) => m.fact);
  }
}
