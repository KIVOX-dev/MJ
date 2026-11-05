import crypto from 'node:crypto';
import { ChatSessionModel } from '../../models/push.model';
import { MessageModel } from '../../models/message.model';

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
}

export interface SessionRepo {
  list(): Promise<ChatSession[]>;
  create(): Promise<ChatSession>;
  exists(id: string): Promise<boolean>;
  rename(id: string, title: string): Promise<boolean>;
  /** Sets the title from the first message, only while it is still the default "New chat". */
  autoTitle(id: string, firstMessage: string): Promise<void>;
  touch(id: string): Promise<void>;
  remove(id: string): Promise<boolean>;
}

const clean = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat';

export class MongoSessionRepo implements SessionRepo {
  async list(): Promise<ChatSession[]> {
    const docs = await ChatSessionModel.find().sort({ updatedAt: -1 }).limit(100).lean();
    return docs.map((d) => ({ id: d.sessionId, title: d.title ?? 'New chat', updatedAt: new Date(d.updatedAt as Date).toISOString() }));
  }
  async create(): Promise<ChatSession> {
    const d = await ChatSessionModel.create({ sessionId: crypto.randomUUID() });
    return { id: d.sessionId, title: d.title ?? 'New chat', updatedAt: new Date(d.updatedAt as Date).toISOString() };
  }
  async exists(id: string): Promise<boolean> {
    return !!(await ChatSessionModel.exists({ sessionId: id }));
  }
  async rename(id: string, title: string): Promise<boolean> {
    const r = await ChatSessionModel.updateOne({ sessionId: id }, { $set: { title: clean(title) } });
    return r.matchedCount > 0;
  }
  async autoTitle(id: string, firstMessage: string): Promise<void> {
    await ChatSessionModel.updateOne({ sessionId: id, title: 'New chat' }, { $set: { title: clean(firstMessage) } });
  }
  async touch(id: string): Promise<void> {
    await ChatSessionModel.updateOne({ sessionId: id }, { $set: { updatedAt: new Date() } });
  }
  async remove(id: string): Promise<boolean> {
    const r = await ChatSessionModel.deleteOne({ sessionId: id });
    if (r.deletedCount) await MessageModel.deleteMany({ sessionId: id });
    return r.deletedCount > 0;
  }
}
