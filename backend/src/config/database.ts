import dns from 'node:dns';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export async function connectDatabase(uri: string, dnsServers: string[] = []): Promise<void> {
  // Some networks/OSes can't resolve Atlas SRV records; allow overriding resolvers.
  if (dnsServers.length) dns.setServers(dnsServers);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 10 });
  logger.info('MongoDB connected');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** readyState 1 === connected */
export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
