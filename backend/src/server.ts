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
import { CompositeNewsSource, GoogleNewsSource, THE_HINDU_TN, googleNewsFeed } from './modules/research-assistant/web-search/rss';
import { BreakingNewsService } from './modules/research-assistant/web-search/breaking-news.service';
import { MongoSeenRepo } from './jobs/seen.repo';
import { SeenArticleModel } from './models/seen-article.model';
import { NewsdataClient } from './modules/research-assistant/web-search/newsdata.client';
import { registerNewsTools } from './modules/research-assistant/web-search/news.tools';
import { NewsDigestService } from './modules/personal-secretary/briefing/news-digest.service';
import { MongoJobRunRepo } from './jobs/job-run.repo';
import { JobRunModel } from './models/job-run.model';
import { renderNewspaperPdf } from './modules/personal-secretary/briefing/newspaper';
import { sectionFeeds } from './modules/personal-secretary/briefing/section-feeds';
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
  await Promise.all([MessageModel.syncIndexes(), ReminderModel.syncIndexes(), JobRunModel.syncIndexes(), SeenArticleModel.syncIndexes()]);

  const groq = GroqService.fromConfig(config.groq);
  const reminders = new ReminderService(new MongoReminderRepo(), config.timezone);
  const registry = new ToolRegistry();
  registerReminderTools(registry, reminders);
  // Fresh headlines come from Google News RSS (free, real-time); Newsdata (free plan is ~12 h delayed) adds depth.
  const newsSources = [new GoogleNewsSource(), ...(config.news.apiKey ? [new NewsdataClient(config.news.apiKey)] : [])];
  if (!config.news.apiKey) logger.warn('NEWSDATA_API_KEY not set: using Google News RSS only');
  const news = new CompositeNewsSource(newsSources);
  registerNewsTools(registry, news);
  // Tells the assistant what already runs by itself, so it answers "when will I get breaking news?" instead of asking for details.
  const automationNotes =
    'AUTOMATIC FEATURES ALREADY RUNNING (the user does not need to ask for these): ' +
    (config.news.alertsEnabled
      ? `(1) Tamil Nadu breaking news: MJ checks live Tamil Nadu news every ${config.news.alertIntervalMin} minutes and sends an immediate alert message the moment something important appears (at most ${config.news.alertMaxPerDay} a day). `
      : '') +
    (config.news.digestEnabled
      ? `(2) Every morning MJ prepares the news briefing from ${config.news.prepareTime} and sends it at ${config.news.digestTime} ${config.timezone}, together with the "MJ TIMES" newspaper as a PDF with photos. It covers Tamil Nadu, India and world politics and sports, Kollywood, Hollywood, box office and reviews. `
      : '') +
    'If the user asks when or whether they will get breaking news or the daily news, explain this directly and do NOT ask them for a region or topic. ' +
    'Use the get_news tool only when the user asks for news right now on a specific topic.';
  const makeAgent = (channel: Channel) =>
    new Agent({
      ai: groq,
      store: new MongoMessageStore(channel),
      registry,
      timezone: config.timezone,
      extraInstructions: automationNotes,
    }).respond;

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

  // Daily news digest (prepared from 05:00, sent 08:00 Asia/Kolkata) and Tamil Nadu breaking-news alerts,
  // delivered to the owner on each configured channel.
  let digest: NewsDigestService | undefined;
  let alerts: BreakingNewsService | undefined;
  const owners: Record<Channel, string | undefined> = { telegram: config.telegram.ownerId, whatsapp: config.whatsapp.ownerNumber };
  const recipients = config.news.digestChannels
    .filter((c): c is Channel => (c === 'telegram' || c === 'whatsapp') && !!senders[c] && !!owners[c])
    .map((channel) => ({ channel, chatId: owners[channel]! }));
  const notify = async (channel: Channel, chatId: string, text: string) => {
    await senders[channel]!(chatId, text);
  };
  if (!recipients.length) {
    logger.warn('News digest/alerts have no usable recipient (channel not configured or owner id missing)');
  } else {
    const jobs = new MongoJobRunRepo();
    if (config.news.digestEnabled) {
      digest = new NewsDigestService({
        repo: jobs,
        news,
        ai: groq,
        recipients,
        timezone: config.timezone,
        prepareTime: config.news.prepareTime,
        sendTime: config.news.digestTime,
        notify,
        feeds: sectionFeeds(),
        // MJ TIMES PDF edition: only on channels that can carry files (Telegram)
        makePdf: (payload) => renderNewspaperPdf(payload),
        sendFile: async (channel, chatId, file) => {
          if (channel === 'telegram' && tgClient) await tgClient.sendDocument(chatId, file.data, file.name, file.caption);
        },
      });
      logger.info(
        { prepare: config.news.prepareTime, send: config.news.digestTime, channels: recipients.map((r) => r.channel) },
        'Daily news digest scheduled',
      );
    }
    if (config.news.alertsEnabled) {
      alerts = new BreakingNewsService({
        feeds: [THE_HINDU_TN(), googleNewsFeed('Tamil Nadu when:3h')],
        ai: groq,
        seen: new MongoSeenRepo(),
        jobs,
        notify,
        recipients,
        timezone: config.timezone,
        intervalMin: config.news.alertIntervalMin,
        maxPerDay: config.news.alertMaxPerDay,
      });
      logger.info({ everyMin: config.news.alertIntervalMin, maxPerDay: config.news.alertMaxPerDay }, 'Tamil Nadu breaking-news alerts enabled');
    }
  }

  // One tick of all scheduled work. Called by the in-process poller and by POST /jobs/tick.
  const runScheduled = async () => ({
    reminders: await dispatchReminders(),
    digest: digest ? await digest.runDue() : 'disabled',
    alerts: alerts ? await alerts.runDue() : 'disabled',
  });

  // External scheduler hook (Catalyst Job Scheduling / cron calls this); reminders live in MongoDB,
  // so a restart never loses them.
  if (config.jobsSecret) {
    extraRouters.push(jobsRouter({ secret: config.jobsSecret, run: runScheduled }));
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
  const stopDispatcher = startDispatcher(runScheduled, 15_000);

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
