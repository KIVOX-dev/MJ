import { logger } from '../../utils/logger';
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
  /** `sessionId` selects a separate web chat; without it this is the shared per-channel conversation. */
  constructor(
    private readonly channel: Channel,
    private readonly sessionId?: string,
  ) {}

  async claimInbound(externalId: string, from: string, text: string, type: string): Promise<boolean> {
    try {
      await MessageModel.create({ channel: this.channel, externalId, from, direction: 'in', text, type, sessionId: this.sessionId });
      return true;
    } catch (err) {
      // Only a collision on (channel, externalId) means "duplicate delivery". Any other
      // unique-index clash is a real bug and must surface, not be mistaken for a duplicate.
      const e = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (e.code === 11000 && e.keyPattern && 'externalId' in e.keyPattern) return false;
      throw err;
    }
  }

  async saveOutbound(externalId: string, to: string, text: string): Promise<void> {
    try {
      await MessageModel.create({ channel: this.channel, externalId, from: to, direction: 'out', text, sessionId: this.sessionId });
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Failed to store outbound message');
    }
  }

  async recent(limit: number): Promise<StoredMessage[]> {
    const docs = await MessageModel.find({ channel: this.channel, type: 'text', sessionId: this.sessionId ?? null }).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.reverse().map((d) => ({ direction: d.direction as 'in' | 'out', text: d.text ?? '' }));
  }
}
