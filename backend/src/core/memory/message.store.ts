import { MessageModel } from '../../models/message.model';

export type Channel = 'whatsapp' | 'telegram';

export interface StoredMessage {
  direction: 'in' | 'out';
  text: string;
}

export interface MessageStore {
  /** Atomically records an inbound message id. Returns false if already seen (duplicate delivery). */
  claimInbound(externalId: string, from: string, text: string, type: string): Promise<boolean>;
  saveOutbound(externalId: string, to: string, text: string): Promise<void>;
  recent(limit: number): Promise<StoredMessage[]>;
}

export class MongoMessageStore implements MessageStore {
  constructor(private readonly channel: Channel) {}

  async claimInbound(externalId: string, from: string, text: string, type: string): Promise<boolean> {
    try {
      await MessageModel.create({ channel: this.channel, externalId, from, direction: 'in', text, type });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async saveOutbound(externalId: string, to: string, text: string): Promise<void> {
    await MessageModel.create({ channel: this.channel, externalId, from: to, direction: 'out', text }).catch(() => undefined);
  }

  async recent(limit: number): Promise<StoredMessage[]> {
    const docs = await MessageModel.find({ channel: this.channel, type: 'text' }).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.reverse().map((d) => ({ direction: d.direction as 'in' | 'out', text: d.text ?? '' }));
  }
}
