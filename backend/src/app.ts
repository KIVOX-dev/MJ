import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { healthRouter } from './routes/health.routes';
import { logger } from './utils/logger';

export interface AppDeps {
  isDbConnected: () => boolean;
  corsOrigins?: string[];
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.set('trust proxy', 1); // AppSail sits behind a proxy
  app.disable('x-powered-by');
  app.use(helmet());
  // Frontend (e.g. Vercel) origins allowed to call this API from the browser.
  // The WhatsApp webhook is server-to-server and doesn't need CORS.
  app.use(cors({ origin: deps.corsOrigins?.length ? deps.corsOrigins : false, credentials: true }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  // Note: the WhatsApp webhook (Phase 2) needs the raw body for signature
  // verification, so it will mount its own raw parser before this one.
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
