import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { whatsappRouter } from '../src/routes/whatsapp.routes';
import { verifySignature } from '../src/modules/communication-manager/whatsapp/signature';
import { processWebhook } from '../src/modules/communication-manager/whatsapp/whatsapp.handler';
import { WhatsAppCloudClient } from '../src/modules/communication-manager/whatsapp/whatsapp.client';
import type { MessageStore } from '../src/core/memory/message.store';

const SECRET = 'app-secret';
const OWNER = '919876543210';

const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const payload = (from: string, id: string, body = 'hello') =>
  JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body } }] } }] }] });

function memoryStore(): MessageStore & { seen: Set<string> } {
  const seen = new Set<string>();
  const log: Array<{ direction: 'in' | 'out'; text: string }> = [];
  return {
    seen,
    claimInbound: async (id, _f, text) => {
      if (seen.has(id)) return false;
      seen.add(id);
      log.push({ direction: 'in', text });
      return true;
    },
    saveOutbound: async (_id, _to, text) => void log.push({ direction: 'out', text }),
    recent: async () => log.slice(-8),
  };
}

function setup() {
  const sender = { sendText: vi.fn().mockResolvedValue({ messageId: 'out1' }) };
  const ai = { complete: vi.fn().mockResolvedValue('Very well, Sir.') };
  const deps = { verifyToken: 'vt', appSecret: SECRET, ownerNumber: OWNER, store: memoryStore(), ai, sender };
  const app = createApp({ isDbConnected: () => true, extraRouters: [whatsappRouter({ verifyToken: 'vt', messaging: deps })] });
  return { app, sender, ai, deps };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('signature', () => {
  it('accepts a valid signature and rejects tampered/missing ones', () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifySignature(raw, sign('{"a":1}'), SECRET)).toBe(true);
    expect(verifySignature(raw, sign('{"a":2}'), SECRET)).toBe(false);
    expect(verifySignature(raw, undefined, SECRET)).toBe(false);
    expect(verifySignature(raw, 'sha256=zz', SECRET)).toBe(false);
  });
});

describe('webhook verification (GET)', () => {
  it('echoes the challenge for the right token', async () => {
    const { app } = setup();
    const res = await request(app).get('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=12345');
    expect(res.status).toBe(200);
    expect(res.text).toBe('12345');
  });
  it('rejects a wrong token', async () => {
    const { app } = setup();
    const res = await request(app).get('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1');
    expect(res.status).toBe(403);
  });
});

describe('verification-only mode', () => {
  it('verifies the token but refuses messages (503) when messaging is not configured', async () => {
    const app = createApp({ isDbConnected: () => true, extraRouters: [whatsappRouter({ verifyToken: 'vt' })] });
    const ok = await request(app).get('/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=9');
    expect(ok.text).toBe('9');
    const post = await request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json').send('{}');
    expect(post.status).toBe(503);
  });
});

describe('alias path', () => {
  it('also serves /api/webhook/whatsapp', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777');
    expect(res.text).toBe('777');
  });
});

describe('webhook messages (POST)', () => {
  it('rejects invalid signatures without processing', async () => {
    const { app, sender } = setup();
    const body = payload(OWNER, 'm1');
    const res = await request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(body);
    expect(res.status).toBe(401);
    await tick();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('replies to the owner via the AI and sends the reply', async () => {
    const { app, sender, ai } = setup();
    const body = payload(OWNER, 'm2', 'what is on today?');
    const res = await request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await tick();
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(sender.sendText).toHaveBeenCalledWith(OWNER, 'Very well, Sir.');
  });

  it('ignores non-owner senders', async () => {
    const { app, sender, ai } = setup();
    const body = payload('911111111111', 'm3');
    await request(app).post('/webhook/whatsapp').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body)).send(body);
    await tick();
    expect(ai.complete).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});

describe('processWebhook', () => {
  it('skips duplicate deliveries of the same message id', async () => {
    const { deps, sender } = setup();
    const p = JSON.parse(payload(OWNER, 'dup'));
    await processWebhook(p, deps);
    await processWebhook(p, deps);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it('falls back to a polite message when the AI fails', async () => {
    const { deps, sender, ai } = setup();
    ai.complete.mockRejectedValueOnce(new Error('down'));
    await processWebhook(JSON.parse(payload(OWNER, 'e1')), deps);
    expect(sender.sendText).toHaveBeenCalledWith(OWNER, expect.stringContaining('Apologies'));
  });

  it('fails closed when no owner is configured', async () => {
    const { deps, sender } = setup();
    await processWebhook(JSON.parse(payload(OWNER, 'x1')), { ...deps, ownerNumber: '' });
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});

describe('WhatsAppCloudClient', () => {
  const opts = { accessToken: 'tok', phoneNumberId: '123', apiVersion: 'v23.0' };
  it('posts to the Graph API and returns the message id', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) });
    const out = await new WhatsAppCloudClient(opts, f as unknown as typeof fetch).sendText('91', 'hi');
    expect(out.messageId).toBe('wamid.1');
    expect(f.mock.calls[0]![0]).toBe('https://graph.facebook.com/v23.0/123/messages');
  });
  it('throws when Meta rejects the send', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'bad', code: 131030 } }) });
    await expect(new WhatsAppCloudClient(opts, f as unknown as typeof fetch).sendText('91', 'hi')).rejects.toThrow(/131030/);
  });
});
