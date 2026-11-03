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
    corsOrigins: list(e.CORS_ORIGINS),
    dnsServers: e.DNS_SERVERS ? list(e.DNS_SERVERS) : [],
    mongoUri: e.MONGODB_URI,
    groq: { apiKeys: list(e.GROQ_API_KEYS), models: list(e.GROQ_MODELS) },
  };
}
