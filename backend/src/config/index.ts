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
  CRAWLIT_URL: z.string().url().optional(),
  CRAWLIT_TOKEN: z.string().min(16, 'CRAWLIT_TOKEN must be at least 16 characters').optional(),
  VAPID_PUBLIC_KEY: z.string().min(40).max(120).optional(),
  VAPID_PRIVATE_KEY: z.string().min(20).max(120).optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:.+@.+|https:\/\/.+)$/, 'must be mailto:you@example.com or https://...').optional(),
  WEB_API_TOKEN: z.string().min(16, 'WEB_API_TOKEN must be at least 16 characters').optional(),
  BREVO_API_KEY: z.string().optional(),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default('MJ'),
  OWNER_EMAIL: z.string().email().optional(),
  NEWSDATA_API_KEY: z.string().optional(),
  NEWS_DIGEST_ENABLED: z.enum(['true', 'false']).default('true'),
  NEWS_DIGEST_PREPARE_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').default('05:00'),
  NEWS_ALERTS_ENABLED: z.enum(['true', 'false']).default('true'),
  NEWS_ALERT_INTERVAL_MIN: z.coerce.number().int().min(2).max(120).default(10),
  NEWS_ALERT_MAX_PER_DAY: z.coerce.number().int().min(1).max(100).default(30),
  NEWS_DIGEST_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').default('08:00'),
  NEWS_DIGEST_CHANNELS: z.string().default('telegram'),
  CORS_ORIGINS: z.string().default(''),
  DNS_SERVERS: z.string().optional(),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  GROQ_API_KEYS: z.string().min(1, 'GROQ_API_KEYS is required'),
  GROQ_VISION_MODELS: z.string().default('qwen/qwen3.8-27b'),
  GROQ_MODELS: z.string().default('openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b'),
});

/** Optional add-ons: a bad value here disables the add-on instead of stopping the server. */
const OPTIONAL_ADDONS = new Set(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'WEB_API_TOKEN', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'OWNER_EMAIL', 'CRAWLIT_URL', 'CRAWLIT_TOKEN']);

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // A blank value (e.g. "BREVO_API_KEY=" left in .env or the console) means "not set", not an invalid value.
  // Values are trimmed too: a stray space or newline pasted into a console must not invalidate a setting.
  const cleaned = Object.fromEntries(
    Object.entries(env)
      .filter(([, v]) => v === undefined || v.trim() !== '')
      .map(([k, v]) => [k, v === undefined ? v : v.trim()]),
  );
  let parsed = schema.safeParse(cleaned);
  // A wrong value in an optional add-on (web app, email, Crawlit) must not take the whole bot down:
  // drop just that add-on, keep running, and report it in `warnings` (logged at startup).
  const warnings: string[] = [];
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => String(i.path[0]));
    if (bad.every((k) => OPTIONAL_ADDONS.has(k))) {
      for (const issue of parsed.error.issues) warnings.push(`${issue.path.join('.')}: ${issue.message} (that feature is disabled)`);
      for (const k of bad) delete cleaned[k];
      parsed = schema.safeParse(cleaned);
    }
  }
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  let crawlitUrl = e.CRAWLIT_URL;
  if (crawlitUrl) {
    const u = new URL(crawlitUrl);
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    if (!local && u.protocol !== 'https:') {
      warnings.push('CRAWLIT_URL must use https:// unless it is localhost (Crawlit is disabled)');
      crawlitUrl = undefined;
    } else if (!local && !e.CRAWLIT_TOKEN) {
      warnings.push('A remote CRAWLIT_URL requires CRAWLIT_TOKEN (Crawlit is disabled)');
      crawlitUrl = undefined;
    }
  }
  return {
    warnings,
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
    crawlitUrl,
    crawlitToken: e.CRAWLIT_TOKEN,
    webApiToken: e.WEB_API_TOKEN,
    // Web Push (free, no third-party service). Needs all three; the subject falls back to mailto:OWNER_EMAIL.
    push: {
      publicKey: e.VAPID_PUBLIC_KEY,
      privateKey: e.VAPID_PRIVATE_KEY,
      subject: e.VAPID_SUBJECT ?? (e.OWNER_EMAIL ? `mailto:${e.OWNER_EMAIL}` : undefined),
    },
    email: { brevoApiKey: e.BREVO_API_KEY, senderEmail: e.BREVO_SENDER_EMAIL, senderName: e.BREVO_SENDER_NAME, ownerEmail: e.OWNER_EMAIL },
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
    groq: { apiKeys: list(e.GROQ_API_KEYS), models: list(e.GROQ_MODELS), visionModels: list(e.GROQ_VISION_MODELS) },
  };
}
