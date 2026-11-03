import { loadConfig } from './config';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database';
import { createApp } from './app';
import { GroqService } from './core/ai-engine/groq.service';
import { MongoMessageStore } from './core/memory/message.store';
import { WhatsAppCloudClient } from './modules/communication-manager/whatsapp/whatsapp.client';
import { whatsappRouter } from './routes/whatsapp.routes';
import { telegramRouter } from './routes/telegram.routes';
import { TelegramBotClient } from './modules/communication-manager/telegram/telegram.client';
import type { Router } from 'express';
import { logger } from './utils/logger';

async function main() {
  const config = loadConfig();
  await connectDatabase(config.mongoUri, config.dnsServers);

  const extraRouters: Router[] = [];
  const wa = config.whatsapp;
  if (wa.verifyToken) {
    const full = wa.appSecret && wa.accessToken && wa.phoneNumberId && wa.ownerNumber;
    extraRouters.push(
      whatsappRouter({
        verifyToken: wa.verifyToken,
        messaging: full
          ? {
              appSecret: wa.appSecret!,
              ownerNumber: wa.ownerNumber!,
              store: new MongoMessageStore('whatsapp'),
              ai: GroqService.fromConfig(config.groq),
              sender: new WhatsAppCloudClient({
                accessToken: wa.accessToken!,
                phoneNumberId: wa.phoneNumberId!,
                apiVersion: wa.apiVersion,
              }),
            }
          : undefined,
      }),
    );
    if (full) logger.info('WhatsApp webhook enabled at /webhook/whatsapp');
    else logger.warn('WhatsApp webhook: verification only. Missing WHATSAPP_APP_SECRET/ACCESS_TOKEN/PHONE_NUMBER_ID/OWNER_WHATSAPP_NUMBER');
  } else {
    logger.warn('WhatsApp webhook disabled: WHATSAPP_VERIFY_TOKEN not set');
  }

  const tg = config.telegram;
  let tgClient: TelegramBotClient | undefined;
  if (tg.botToken && tg.webhookSecret) {
    tgClient = new TelegramBotClient(tg.botToken);
    extraRouters.push(
      telegramRouter({
        webhookSecret: tg.webhookSecret,
        ownerId: tg.ownerId ?? '',
        store: new MongoMessageStore('telegram'),
        ai: GroqService.fromConfig(config.groq),
        sender: tgClient,
      }),
    );
    if (!tg.ownerId) logger.warn('Telegram enabled but TELEGRAM_OWNER_ID is not set: send /myid to the bot to get it');
    logger.info('Telegram webhook enabled at /webhook/telegram');
  } else {
    logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not set');
  }

  const app = createApp({ isDbConnected: isDatabaseConnected, corsOrigins: config.corsOrigins, extraRouters });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'MJ server listening');
  });

  // Register the Telegram webhook on boot (idempotent) when a public URL is known.
  if (tgClient && tg.webhookSecret && config.publicBaseUrl) {
    tgClient
      .setWebhook(`${config.publicBaseUrl}/webhook/telegram`, tg.webhookSecret)
      .then(() => logger.info('Telegram webhook registered'))
      .catch((err) => logger.error({ err: { message: (err as Error).message } }, 'Telegram setWebhook failed'));
  }

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
