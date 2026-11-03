import crypto from 'node:crypto';
import express, { Router } from 'express';
import { logger } from '../utils/logger';
import { processTelegramUpdate, type TelegramHandlerDeps } from '../modules/communication-manager/telegram/telegram.handler';

export interface TelegramRouteDeps extends TelegramHandlerDeps {
  /** Must match the secret_token given to setWebhook; Telegram echoes it in a header. */
  webhookSecret: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function telegramRouter(deps: TelegramRouteDeps): Router {
  const r = Router();
  r.post('/webhook/telegram', express.json({ limit: '1mb' }), (req, res) => {
    const header = req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(header, deps.webhookSecret)) {
      logger.warn('Rejected Telegram webhook with invalid secret');
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200); // ack fast, process in background
    void processTelegramUpdate(req.body, deps);
  });
  return r;
}
