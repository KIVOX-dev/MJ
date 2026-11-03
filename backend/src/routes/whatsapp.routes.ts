import express, { Router } from 'express';
import { logger } from '../utils/logger';
import { verifySignature } from '../modules/communication-manager/whatsapp/signature';
import { processWebhook, type HandlerDeps } from '../modules/communication-manager/whatsapp/whatsapp.handler';

export interface WhatsAppRouteDeps {
  verifyToken: string;
  /** Present only when fully configured; without it POSTs are refused (503) but verification still works. */
  messaging?: HandlerDeps & { appSecret: string };
}

const PATHS = ['/webhook/whatsapp', '/api/webhook/whatsapp'];

export function whatsappRouter(deps: WhatsAppRouteDeps): Router {
  const r = Router();

  // Meta verification handshake
  r.get(PATHS, (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
    if (mode === 'subscribe' && token === deps.verifyToken && challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  // Raw body is required: the signature is computed over the exact bytes Meta sent.
  r.post(PATHS, express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const m = deps.messaging;
    if (!m) {
      logger.warn('WhatsApp message received but messaging is not fully configured');
      res.sendStatus(503);
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.header('x-hub-signature-256'), m.appSecret)) {
      logger.warn('Rejected WhatsApp webhook with invalid signature');
      res.sendStatus(401);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.sendStatus(400);
      return;
    }
    // Acknowledge fast (Meta retries on slow responses), process in the background.
    res.sendStatus(200);
    void processWebhook(payload, m);
  });

  return r;
}
