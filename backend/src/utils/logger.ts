import pino from 'pino';

// Secrets must never reach logs: redact common credential-bearing fields.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.apiKey',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
    ],
    censor: '[REDACTED]',
  },
});
