import { z } from 'zod';
import type { ToolRegistry } from '../../../core/tool-registry';

export interface NewspaperToolDeps {
  /** Today's MJ TIMES PDF (built on demand if it does not exist yet). */
  getPdf: () => Promise<{ name: string; data: Buffer }>;
  /** Emails the PDF to Sir through Brevo. Absent when email is not set up. */
  emailToOwner?: (file: { name: string; data: Buffer }) => Promise<void>;
}

/** "Send me the newspaper": shows today's MJ TIMES PDF under the reply (app, Telegram) or emails it to Sir with the PDF attached. */
export function registerNewspaperTools(registry: ToolRegistry, d: NewspaperToolDeps): void {
  registry.register({
    name: 'get_newspaper',
    description:
      "Give Sir today's MJ TIMES newspaper (the daily PDF). deliver='chat' (default) attaches it under your reply; deliver='email' emails it to him with the PDF attached. " +
      'Use when he asks for the newspaper, the news PDF, the e-paper or MJ TIMES. To attach it to an email to someone else, use draft_email with attach_newspaper instead.',
    schema: z.object({ deliver: z.enum(['chat', 'email']).default('chat') }),
    async run(args, ctx) {
      if (args.deliver === 'email') {
        if (!d.emailToOwner) throw new Error('Email is not set up, so I cannot email the newspaper.');
        const file = await d.getPdf();
        await d.emailToOwner(file);
        return { emailed_to_owner: true, file: file.name };
      }
      if (!ctx.onFile) throw new Error('This chat cannot show files. I can email the newspaper to you instead.');
      const file = await d.getPdf();
      ctx.onFile({ name: file.name, path: '/api/newspaper.pdf' });
      return { note: 'The PDF is attached under your reply automatically. Reply with one short sentence and do not write a link.' };
    },
  });
}
