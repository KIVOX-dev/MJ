import { z } from 'zod';
import type { ToolRegistry } from '../../../core/tool-registry';
import type { BrevoClient } from './brevo.client';
import { renderEmailHtml } from './template';

/** Lets MJ email the OWNER only. The recipient is fixed in config, never chosen by the model (prevents data being mailed elsewhere). */
export function registerEmailTools(registry: ToolRegistry, brevo: BrevoClient, ownerEmail: string): void {
  registry.register({
    name: 'email_me',
    description:
      "Send an email to the user's own email address (the only address MJ can email). Use when the user asks to be emailed " +
      'something ("email me this", "mail me the summary"). Write the full content in the body.',
    schema: z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(20000).describe('Plain-text email body'),
    }),
    async run(args) {
      const date = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const r = await brevo.send(ownerEmail, args.subject, args.body, [], renderEmailHtml(args.subject, args.body, { date }));
      return { sent_to: ownerEmail, message_id: r.messageId ?? null };
    },
  });
}
