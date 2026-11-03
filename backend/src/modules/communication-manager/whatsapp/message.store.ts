import { MessageModel } from '../../../models/message.model';

export interface StoredMessage {
  direction: 'in' | 'out';
  text: string;
}

export interface MessageStore {
  /** Atomically records an inbound message id. Returns false if it was already seen (duplicate webhook delivery). */
  claimInbound(waMessageId: string, from: string, text: string, type: string): Promise<boolean>;
  saveOutbound(waMessageId: string, to: string, text: string): Promise<void>;
  recent(limit: number): Promise<StoredMessage[]>;
}

export class MongoMessageStore implements MessageStore {
  async claimInbound(waMessageId: string, from: string, text: string, type: string): Promise<boolean> {
    try {
      await MessageModel.create({ waMessageId, from, direction: 'in', text, type });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async saveOutbound(waMessageId: string, to: string, text: string): Promise<void> {
    await MessageModel.create({ waMessageId, from: to, direction: 'out', text }).catch(() => undefined);
  }

  async recent(limit: number): Promise<StoredMessage[]> {
    const docs = await MessageModel.find({ type: 'text' }).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.reverse().map((d) => ({ direction: d.direction as 'in' | 'out', text: d.text ?? '' }));
  }
}
