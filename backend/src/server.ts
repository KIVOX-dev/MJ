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
import type { AlertMeta } from './modules/research-assistant/web-search/breaking-news.service';
import { BreakingNewsService } from './modules/research-assistant/web-search/breaking-news.service';
import { MongoSeenRepo } from './jobs/seen.repo';
import { SeenArticleModel } from './models/seen-article.model';
import { NewsdataClient } from './modules/research-assistant/web-search/newsdata.client';
import { registerNewsTools } from './modules/research-assistant/web-search/news.tools';
import { NewsDigestService, type DigestFile } from './modules/personal-secretary/briefing/news-digest.service';
import { MongoJobRunRepo } from './jobs/job-run.repo';
import { JobRunModel } from './models/job-run.model';
import { MemoryService, MongoMemoryRepo } from './core/memory/memory.service';
import { registerMemoryTools } from './core/memory/memory.tools';
import { CrawlitClient } from './modules/research-assistant/web-search/crawlit.client';
import { registerWebTools } from './modules/research-assistant/web-search/web.tools';
import { MemoryModel } from './models/memory.model';
import type { DigestPayload } from './modules/personal-secretary/briefing/digest.types';
import { renderEmailHtml } from './modules/communication-manager/email/template';
import { registerNewspaperTools } from './modules/personal-secretary/briefing/newspaper.tools';
import { renderNewspaperPdf } from './modules/personal-secretary/briefing/newspaper';
import { sectionFeeds } from './modules/personal-secretary/briefing/section-feeds';
import { startDispatcher } from './jobs/dispatcher';
import { jobsRouter } from './routes/jobs.routes';
import { WhatsAppCloudClient } from './modules/communication-manager/whatsapp/whatsapp.client';
import { whatsappRouter } from './routes/whatsapp.routes';
import { telegramRouter } from './routes/telegram.routes';
import { TelegramBotClient } from './modules/communication-manager/telegram/telegram.client';
import { BrevoClient } from './modules/communication-manager/email/brevo.client';
import { registerEmailTools, type EmailController } from './modules/communication-manager/email/email.tools';
import { GroqTranscriber, TranscriberChain } from './core/ai-engine/transcribe';
import { EDGE_VOICES, EdgeSpeech, GROQ_VOICES, GroqSpeech, SARVAM_VOICES, Speaker } from './core/ai-engine/speech';
import { SarvamSpeech, SarvamTranscriber } from './core/ai-engine/sarvam';
import { ImageService, MongoImageStore, geminiProvider, groqSvgProvider, huggingFaceSpaceProvider, pollinationsProvider, registerImageTools, type ImageProvider } from './modules/creative/image.service';
import { webChatRouter } from './routes/web.routes';
import { MongoPushRepo, PushService, makeWebPushSender } from './modules/communication-manager/push/push.service';
import { MongoSessionRepo } from './core/memory/session.repo';
import { logger } from './utils/logger';

async function main() {
  const config = loadConfig();
  for (const w of config.warnings) logger.warn(`Config: ${w}`);
  await connectDatabase(config.mongoUri, config.dnsServers);
  // Keep DB indexes in line with the schemas (drops stale ones left by older versions).
  await Promise.all([MessageModel.syncIndexes(), ReminderModel.syncIndexes(), JobRunModel.syncIndexes(), SeenArticleModel.syncIndexes(), MemoryModel.syncIndexes()]);

  const groq = GroqService.fromConfig(config.groq);
  // Listening: Sarvam first (best for Indian English and Tamil), Whisper as the backup.
  const stt = new TranscriberChain([...(config.sarvamKeys.length ? [new SarvamTranscriber(config.sarvamKeys)] : []), new GroqTranscriber(config.groq.apiKeys)]);
  // Speaking: Sarvam voices first when a key is set, Microsoft neural voices otherwise (and as the backup).
  const tts = new Speaker({ edge: new EdgeSpeech(), groq: new GroqSpeech(config.groq.apiKeys), ...(config.sarvamKeys.length ? { sarvam: new SarvamSpeech(config.sarvamKeys) } : {}) });
  const voiceMenu = {
    default: config.sarvamKeys.length ? 'sarvam:priya' : 'edge:en-IN-NeerjaNeural',
    voices: [...(config.sarvamKeys.length ? SARVAM_VOICES : []), ...EDGE_VOICES, ...GROQ_VOICES],
  };
  const reminders = new ReminderService(new MongoReminderRepo(), config.timezone);
  const registry = new ToolRegistry();
  registerReminderTools(registry, reminders);
  // Fresh headlines come from Google News RSS (free, real-time); Newsdata (free plan is ~12 h delayed) adds depth.
  const newsSources = [new GoogleNewsSource(), ...(config.news.apiKey ? [new NewsdataClient(config.news.apiKey)] : [])];
  if (!config.news.apiKey) logger.warn('NEWSDATA_API_KEY not set: using Google News RSS only');
  const news = new CompositeNewsSource(newsSources);
  registerNewsTools(registry, news);
  // Crawlit (self-hosted crawler) is optional: with it MJ can render JS pages, search the web and crawl sites.
  const crawlit = config.crawlitUrl ? new CrawlitClient(config.crawlitUrl, fetch, undefined, { token: config.crawlitToken }) : undefined;
  registerWebTools(registry, { crawlit });
  if (crawlit) void crawlit.health().then((ok) => (ok ? logger.info('Crawlit connected') : logger.warn('CRAWLIT_URL is set but Crawlit is not answering; falling back to the built-in page reader')));
  const em = config.email;
  let emailDrafts: EmailController | undefined;
  let brevo: BrevoClient | undefined;
  // eslint-disable-next-line prefer-const
  let digest: NewsDigestService | undefined;
  if (em.brevoApiKey && em.senderEmail && em.ownerEmail) {
    brevo = new BrevoClient({ apiKey: em.brevoApiKey, senderEmail: em.senderEmail, senderName: em.senderName });
    emailDrafts = registerEmailTools(registry, brevo, em.ownerEmail, { ownerName: config.ownerName, newspaper: () => digest!.newspaperNow() });
    logger.info('Email enabled (Brevo): MJ can email the owner');
  } else if (em.brevoApiKey) {
    logger.warn('BREVO_API_KEY is set but BREVO_SENDER_EMAIL or OWNER_EMAIL is missing: email disabled');
  }
  // Picture generation. Groq has no image model, so by default MJ has Groq's language model DRAW vector graphics (no extra account).
  // Better engines are used first if you add their key; the free Pollinations service is used only if you opt in.
  const imageProviders: ImageProvider[] = [
    ...(config.images.geminiKey ? [geminiProvider(config.images.geminiKey)] : []),
    ...(config.images.hfToken ? [huggingFaceSpaceProvider(config.images.hfToken)] : []),
    ...(config.images.pollinations ? [pollinationsProvider(config.images.pollinationsKey)] : []),
    groqSvgProvider(async (system, user) => {
      const r = await groq.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0.7, maxTokens: 6500, models: config.groq.imageModels });
      return r.content ?? '';
    }),
  ];
  const imageStore = new MongoImageStore();
  registerImageTools(registry, new ImageService(imageProviders, imageStore));
  logger.info({ engines: imageProviders.map((p) => p.name) }, 'Picture generation enabled');
  const memory = new MemoryService(new MongoMemoryRepo());
  registerMemoryTools(registry, memory);
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
    'Use the get_news tool only when the user asks for news right now on a specific topic. ' +
    `The user's name is ${config.ownerName}. Always sign emails and letters you write for him as "${config.ownerName}", never with a placeholder like [Your Name]; in chat you still address him as Sir.`;
  const makeAgent = (channel: Channel, sessionId?: string) =>
    new Agent({
      ai: groq,
      store: new MongoMessageStore(channel, sessionId),
      registry,
      timezone: config.timezone,
      extraInstructions: automationNotes,
      memory,
      visionModels: config.groq.visionModels,
    }).respond;

  const extraRouters: Router[] = [];
  const senders: Partial<Record<Channel, (to: string, text: string, opts?: { stopButtonFor?: string }) => Promise<unknown>>> = {};

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
      senders.whatsapp = (to, text, opts) => client.sendText(to, opts?.stopButtonFor ? `${text}

Reply "stop reminders" to stop these.` : text);
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
    senders.telegram = (to, text, opts) => client.sendText(to, text, { stopReminderId: opts?.stopButtonFor });
    extraRouters.push(
      telegramRouter({
        webhookSecret: tg.webhookSecret,
        ownerId: tg.ownerId ?? '',
        store: new MongoMessageStore('telegram'),
        respond: makeAgent('telegram'),
        sender: client,
        stopReminder: (chatId, id) => reminders.cancel('telegram', chatId, id),
        transcribe: (a, m) => stt.transcribe(a, m, config.sttLanguage),
        getImage: (id) => imageStore.get(id),
        emailDrafts,
        sendNewspaper: async (chatId) => {
          if (!digest) throw new Error('the daily newspaper is switched off');
          const file = await digest.newspaperNow();
          await client.sendDocument(chatId, file.data, file.name, file.caption);
        },
      }),
    );
    if (!tg.ownerId) logger.warn('Telegram enabled but TELEGRAM_OWNER_ID is not set: send /myid to the bot to get it');
    logger.info('Telegram webhook enabled at /webhook/telegram');
  } else {
    logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not set');
  }

  // Web Push: reminders, breaking news and the morning briefing also arrive as phone notifications,
  // even when the web app is closed. History and preferences live in MongoDB.
  const vapid = config.push;
  const push = new PushService(
    new MongoPushRepo(),
    vapid.publicKey && vapid.privateKey && vapid.subject ? makeWebPushSender({ subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }) : undefined,
    vapid.publicKey && vapid.privateKey && vapid.subject ? vapid.publicKey : undefined,
  );
  if (!push.enabled) logger.warn('Web Push is off: set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (or OWNER_EMAIL) to enable phone notifications');

  // Mobile web app: same assistant as the Telegram bot (shared history, memory and reminders).
  if (config.webApiToken && tg.ownerId) {
    const ownerId = tg.ownerId;
    extraRouters.push(
      webChatRouter({
        token: config.webApiToken,
        respond: makeAgent('telegram'),
        store: new MongoMessageStore('telegram'),
        ownerChatId: ownerId,
        transcribe: (a, m, l) => stt.transcribe(a, m, l ?? config.sttLanguage),
        speak: (t, v) => tts.synth(t, v),
        voices: voiceMenu,
        getImage: (id) => imageStore.get(id),
        emailDrafts,
        newspaper: () => { if (!digest) throw new Error("newspaper off"); return digest.newspaperNow(); },
        sessions: new MongoSessionRepo(),
        storeFor: (sid) => new MongoMessageStore('telegram', sid),
        respondFor: (sid) => makeAgent('telegram', sid),
        push,
        stopReminder: (id) => reminders.cancel('telegram', ownerId, id),
      }),
    );
    logger.info('Web chat API enabled at /api/chat');
  } else if (config.webApiToken) {
    logger.warn('WEB_API_TOKEN is set but TELEGRAM_OWNER_ID is missing: web chat disabled');
  }

  // Delivers due reminders through whichever channel they were created on.
  const dispatchReminders = () =>
    reminders.dispatchDue(async (channel, chatId, text, opts) => {
      const send = senders[channel];
      if (!send) throw new Error(`Channel ${channel} is not configured`);
      await send(chatId, text, opts);
      // Same reminder as a phone notification (works with the web app closed). Repeats share one tag so they replace each other.
      void push.send({
        title: 'Reminder',
        body: text.replace(/^⏰ Reminder, Sir:\s*/, '').split('\n\n')[0] ?? text,
        category: 'reminder',
        url: '/',
        reminderId: opts?.stopButtonFor,
        tag: opts?.stopButtonFor ? `reminder-${opts.stopButtonFor}` : undefined,
      });
    });

  // Daily news digest (prepared from 05:00, sent 08:00 Asia/Kolkata) and Tamil Nadu breaking-news alerts,
  // delivered to the owner on each configured channel.
  let alerts: BreakingNewsService | undefined;
  const owners: Record<Channel, string | undefined> = { telegram: config.telegram.ownerId, whatsapp: config.whatsapp.ownerNumber };
  const recipients = config.news.digestChannels
    .filter((c): c is Channel => (c === 'telegram' || c === 'whatsapp') && !!senders[c] && !!owners[c])
    .map((channel) => ({ channel, chatId: owners[channel]! }));
  const digestEmailText = (d: DigestPayload) =>
    d.sections
      .filter((x) => x.stories.length)
      .map((x) => `${x.label}\n${x.stories.map((st) => `- ${st.summary}${st.source ? ` (${st.source})` : ''}`).join('\n')}`)
      .join('\n\n') + '\n\nThe full MJ TIMES edition is attached as a PDF.';
  /** The morning briefing also goes to the phone (push) and to the owner's email with the MJ TIMES PDF attached. */
  const mailMorning = async (d: DigestPayload, file?: DigestFile) => {
    if (!brevo || !em.ownerEmail) return;
    const body = digestEmailText(d);
    const subject = `MJ TIMES · ${d.date}`;
    const html = renderEmailHtml(subject, body, { heading: 'Your morning briefing', preheader: 'Headlines, with the MJ TIMES PDF attached', date: d.date, audience: 'owner', ownerName: config.ownerName });
    const ok = file && file.data.length <= 3_500_000;
    await brevo.send(em.ownerEmail, subject, body, ok ? [{ name: file!.name, data: file!.data }] : [], html, { replyTo: em.ownerEmail, senderName: 'MJ TIMES' });
  };
  function morningExtras(): NonNullable<ConstructorParameters<typeof NewsDigestService>[0]['extras']> {
    const x: NonNullable<ConstructorParameters<typeof NewsDigestService>[0]['extras']> = [
      {
        name: 'push',
        deliver: async (d) => {
          const top = d.sections.flatMap((s) => s.stories).slice(0, 3).map((st) => st.summary);
          await push.send({
            title: 'Your morning news briefing',
            body: top[0] ?? 'Good morning, Sir.',
            category: 'news',
            url: '/',
            tag: 'daily-news',
            details: { description: top.join(' • '), source: 'MJ TIMES', published: d.date },
          });
        },
      },
    ];
    if (brevo) x.push({ name: 'email', deliver: async (d, pdf) => mailMorning(d, await pdf()) });
    return x;
  }
  const notify = async (channel: Channel, chatId: string, text: string, meta?: AlertMeta) => {
    await senders[channel]!(chatId, text);
    // Breaking-news alerts and the first part of the morning briefing also go out as phone notifications.
    if (text.startsWith('🚨')) {
      const headline = text.split('\n\n')[1] ?? text;
      void push.send({
        title: 'Tamil Nadu alert',
        body: meta?.headline ?? headline,
        category: 'alert',
        url: '/',
        details: meta ? { source: meta.source, description: meta.description, link: meta.link, published: meta.published } : undefined,
      });
    }
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
        extras: morningExtras(),
        sendFile: async (channel, chatId, file) => {
          if (channel === 'telegram' && tgClient) await tgClient.sendDocument(chatId, file.data, file.name, file.caption);
        },
      });
      registerNewspaperTools(registry, {
        getPdf: () => digest!.newspaperNow(),
        ...(brevo && em.ownerEmail
          ? { emailToOwner: async (f: DigestFile) => { const d = await digest!.currentDigest(); await mailMorning(d, f); } }
          : {}),
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

  const app = createApp({
    isDbConnected: isDatabaseConnected,
    corsOrigins: config.corsOrigins,
    extraRouters,
    features: () => ({
      // names of settings only, never values: tells you what to fix when a feature is off
      ...(registry.has('email_me')
        ? {}
        : {
            emailMissing: [
              ...(config.email.brevoApiKey ? [] : ['BREVO_API_KEY']),
              ...(config.email.senderEmail ? [] : ['BREVO_SENDER_EMAIL']),
              ...(config.email.ownerEmail ? [] : ['OWNER_EMAIL']),
            ],
          }),
      configIssues: config.warnings.map((w) => /^([A-Z0-9_]+):/.exec(w)?.[1] ?? w.split(' ')[0]!),
      email: registry.has('email_me'),
      webChat: !!(config.webApiToken && tg.ownerId),
      telegram: !!tgClient,
      crawlit: !!crawlit,
      newsDigest: !!digest,
      newsAlerts: !!alerts,
      push: push.enabled,
      images: imageProviders.map((p) => p.name).join('+'),
      speech: config.sarvamKeys.length ? `sarvam(${config.sarvamKeys.length} key${config.sarvamKeys.length > 1 ? 's' : ''})+whisper` : 'whisper',
    }),
  });
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
