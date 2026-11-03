import crypto from 'node:crypto';
import { Router } from 'express';
import { logger } from '../utils/logger';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Endpoint for an external scheduler (e.g. Catalyst Job Scheduling) to trigger due work. */
export function jobsRouter(deps: { secret: string; run: () => Promise<unknown> }): Router {
  const r = Router();
  r.post('/jobs/tick', async (req, res) => {
    if (!safeEqual(req.header('x-job-secret') ?? '', deps.secret)) {
      res.sendStatus(401);
      return;
    }
    try {
      res.json({ ok: true, result: await deps.run() });
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Job tick failed');
      res.status(500).json({ ok: false });
    }
  });
  return r;
}
