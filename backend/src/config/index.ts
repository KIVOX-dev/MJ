import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  X_ZOHO_CATALYST_LISTEN_PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v23.0'),
  OWNER_WHATSAPP_NUMBER: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_OWNER_ID: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  JOBS_SECRET: z.string().optional(),
  NEWSDATA_API_KEY: z.string().optional(),
  NEWS_DIGEST_ENABLED: z.enum(['true', 'false']).default('true'),
  NEWS_DIGEST_PREPARE_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').default('05:00'),
  NEWS_ALERTS_ENABLED: z.enum(['true', 'false']).default('true'),
  NEWS_ALERT_INTERVAL_MIN: z.coerce.number().int().min(2).max(120).default(10),
  NEWS_ALERT_MAX_PER_DAY: z.coerce.number().int().min(1).max(100).default(15),
  NEWS_DIGEST_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').default('08:00'),
  NEWS_DIGEST_CHANNELS: z.string().default('telegram'),
  CORS_ORIGINS: z.string().default(''),
  DNS_SERVERS: z.string().optional(),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  GROQ_API_KEYS: z.string().min(1, 'GROQ_API_KEYS is required'),
  GROQ_MODELS: z.string().default('openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b'),
});

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    // On Catalyst AppSail the platform provides the port to bind to.
    port: e.X_ZOHO_CATALYST_LISTEN_PORT ?? e.PORT,
    logLevel: e.LOG_LEVEL,
    timezone: e.DEFAULT_TIMEZONE,
    whatsapp: {
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      appSecret: e.WHATSAPP_APP_SECRET,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: e.WHATSAPP_API_VERSION,
      ownerNumber: e.OWNER_WHATSAPP_NUMBER,
    },
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
      ownerId: e.TELEGRAM_OWNER_ID,
    },
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    jobsSecret: e.JOBS_SECRET,
    news: {
      apiKey: e.NEWSDATA_API_KEY,
      digestEnabled: e.NEWS_DIGEST_ENABLED === 'true',
      digestTime: e.NEWS_DIGEST_TIME,
      prepareTime: e.NEWS_DIGEST_PREPARE_TIME,
      alertsEnabled: e.NEWS_ALERTS_ENABLED === 'true',
      alertIntervalMin: e.NEWS_ALERT_INTERVAL_MIN,
      alertMaxPerDay: e.NEWS_ALERT_MAX_PER_DAY,
      digestChannels: list(e.NEWS_DIGEST_CHANNELS),
    },
    corsOrigins: list(e.CORS_ORIGINS),
    dnsServers: e.DNS_SERVERS ? list(e.DNS_SERVERS) : [],
    mongoUri: e.MONGODB_URI,
    groq: { apiKeys: list(e.GROQ_API_KEYS), models: list(e.GROQ_MODELS) },
  };
}
