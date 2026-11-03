import { Router } from 'express';

export function healthRouter(deps: { isDbConnected: () => boolean }): Router {
  const r = Router();
  // Liveness: process is up.
  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });
  // Readiness: dependencies reachable.
  r.get('/ready', (_req, res) => {
    const db = deps.isDbConnected();
    res.status(db ? 200 : 503).json({ status: db ? 'ready' : 'degraded', db });
  });
  return r;
}
