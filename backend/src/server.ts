import type { Router } from 'express';
import { loadConfig } from './config';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database';
import { MessageModel } from './models/message.model';
import { ReminderModel } from './models/reminder.model';
import { createApp } from './app';
import { GroqService } from './core/ai-engine/groq.service';
import { MongoMessageStore, type Channel } from './core/memory/message.store';
import { Agent } from './core/orchestrator/assistant';
import { ToolRegistry } from './core/tool-registry';
import { MongoReminderRepo } from './modules/personal-secretary/reminders/reminder.repo';
import { ReminderService } from './modules/personal-secretary/reminders/reminder.service';
import { registerReminderTools } from './modules/personal-secretary/reminders/reminder.tools';
import { startDispatcher } from './jobs/dispatcher';
import { jobsRouter } from './routes/jobs.routes';
import { WhatsAppCloudClient } from './modules/communication-manager/whatsapp/whatsapp.client';
import { whatsappRouter } from './routes/whatsapp.routes';
import { telegramRouter } from './routes/telegram.routes';
import { TelegramBotClient } from './modules/communication-manager/telegram/telegram.client';
import { logger } from './utils/logger';

async function main() {
  const config = loadConfig();
  await connectDatabase(config.mongoUri, config.dnsServers);
  // Keep DB indexes in line with the schemas (drops stale ones left by older versions).
  await Promise.all([MessageModel.syncIndexes(), ReminderModel.syncIndexes()]);

  const groq = GroqService.fromConfig(config.groq);
  const reminders = new ReminderService(new MongoReminderRepo(), config.timezone);
  const registry = new ToolRegistry();
  registerReminderTools(registry, reminders);
  const makeAgent = (channel: Channel) =>
    new Agent({ ai: groq, store: new MongoMessageStore(channel), registry, timezone: config.timezone }).respond;

  const extraRouters: Router[] = [];
  const senders: Partial<Record<Channel, (to: string, text: string) => Promise<unknown>>> = {};

  const wa = config.whatsapp;
  if (wa.verifyToken) {
    const full = wa.appSecret && wa.accessToken && wa.phoneNumberId && wa.ownerNumber;
    let messaging;
    if (full) {
      const client = new WhatsAppCloudClient({
        accessToken: wa.accessToken!,
        phoneNumberId: wa.phoneNumberId!,
        apiVersion: wa.apiVersion,
      });
      senders.whatsapp = (to, text) => client.sendText(to, text);
      messaging = {
        appSecret: wa.appSecret!,
        ownerNumber: wa.ownerNumber!,
        store: new MongoMessageStore('whatsapp'),
        respond: makeAgent('whatsapp'),
        sender: client,
      };
    }
    extraRouters.push(whatsappRouter({ verifyToken: wa.verifyToken, messaging }));
    if (full) logger.info('WhatsApp webhook enabled at /webhook/whatsapp');
    else logger.warn('WhatsApp webhook: verification only. Missing WHATSAPP_APP_SECRET/ACCESS_TOKEN/PHONE_NUMBER_ID/OWNER_WHATSAPP_NUMBER');
  } else {
    logger.warn('WhatsApp webhook disabled: WHATSAPP_VERIFY_TOKEN not set');
  }

  const tg = config.telegram;
  let tgClient: TelegramBotClient | undefined;
  if (tg.botToken && tg.webhookSecret) {
    tgClient = new TelegramBotClient(tg.botToken);
    const client = tgClient;
    senders.telegram = (to, text) => client.sendText(to, text);
    extraRouters.push(
      telegramRouter({
        webhookSecret: tg.webhookSecret,
        ownerId: tg.ownerId ?? '',
        store: new MongoMessageStore('telegram'),
        respond: makeAgent('telegram'),
        sender: client,
      }),
    );
    if (!tg.ownerId) logger.warn('Telegram enabled but TELEGRAM_OWNER_ID is not set: send /myid to the bot to get it');
    logger.info('Telegram webhook enabled at /webhook/telegram');
  } else {
    logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not set');
  }

  // Delivers due reminders through whichever channel they were created on.
  const dispatchReminders = () =>
    reminders.dispatchDue(async (channel, chatId, text) => {
      const send = senders[channel];
      if (!send) throw new Error(`Channel ${channel} is not configured`);
      await send(chatId, text);
    });

  // External scheduler hook (Catalyst Job Scheduling / cron calls this); reminders live in MongoDB,
  // so a restart never loses them.
  if (config.jobsSecret) {
    extraRouters.push(jobsRouter({ secret: config.jobsSecret, run: dispatchReminders }));
    logger.info('Job endpoint enabled at POST /jobs/tick');
  } else {
    logger.warn('JOBS_SECRET not set: /jobs/tick disabled');
  }

  const app = createApp({ isDbConnected: isDatabaseConnected, corsOrigins: config.corsOrigins, extraRouters });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'MJ server listening');
  });

  // In-process poller: low-latency delivery while the instance is awake. Safe alongside /jobs/tick
  // because reminder claims are atomic.
  const stopDispatcher = startDispatcher(dispatchReminders, 15_000);

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
    stopDispatcher();
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
