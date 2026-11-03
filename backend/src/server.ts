import { loadConfig } from './config';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database';
import { createApp } from './app';
import { GroqService } from './core/ai-engine/groq.service';
import { MongoMessageStore } from './modules/communication-manager/whatsapp/message.store';
import { WhatsAppCloudClient } from './modules/communication-manager/whatsapp/whatsapp.client';
import { whatsappRouter } from './routes/whatsapp.routes';
import type { Router } from 'express';
import { logger } from './utils/logger';

async function main() {
  const config = loadConfig();
  await connectDatabase(config.mongoUri, config.dnsServers);

  const extraRouters: Router[] = [];
  const wa = config.whatsapp;
  if (wa.verifyToken && wa.appSecret && wa.accessToken && wa.phoneNumberId && wa.ownerNumber) {
    extraRouters.push(
      whatsappRouter({
        verifyToken: wa.verifyToken,
        appSecret: wa.appSecret,
        ownerNumber: wa.ownerNumber,
        store: new MongoMessageStore(),
        ai: GroqService.fromConfig(config.groq),
        sender: new WhatsAppCloudClient({
          accessToken: wa.accessToken,
          phoneNumberId: wa.phoneNumberId,
          apiVersion: wa.apiVersion,
        }),
      }),
    );
    logger.info('WhatsApp webhook enabled at /webhook/whatsapp');
  } else {
    logger.warn('WhatsApp webhook disabled: missing WHATSAPP_* / OWNER_WHATSAPP_NUMBER configuration');
  }

  const app = createApp({ isDbConnected: isDatabaseConnected, corsOrigins: config.corsOrigins, extraRouters });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'MJ server listening');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'Failed to start');
  process.exit(1);
});
