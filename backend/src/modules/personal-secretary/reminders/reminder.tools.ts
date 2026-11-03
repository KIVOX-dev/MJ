import { z } from 'zod';
import type { ToolRegistry } from '../../../core/tool-registry';
import { resolveLocalDateTime } from '../../../utils/time';
import type { ReminderService } from './reminder.service';

function fmt(d: Date, tz: string): string {
  return d.toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
}

export function registerReminderTools(registry: ToolRegistry, svc: ReminderService): void {
  registry.register({
    name: 'create_reminder',
    description:
      'Create a one-time reminder that MJ will send to the user in this chat. Give the time in ONE of two ways: ' +
      '(a) in_minutes for relative times like "in 2 minutes" or "in 1 hour" (convert to minutes); or ' +
      '(b) day + time for clock times: day is "today", "tomorrow" or a date YYYY-MM-DD, and time is 24-hour HH:mm ' +
      'in the user\'s local time (Asia/Kolkata). Do NOT work out calendar dates yourself: pass the word "today" or "tomorrow".',
    schema: z.object({
      text: z.string().min(1).max(500).describe('What to remind the user about, phrased as a short message'),
      in_minutes: z.number().int().min(1).max(525600).optional().describe('Minutes from now'),
      day: z.string().optional().describe('"today", "tomorrow" or YYYY-MM-DD (use with time)'),
      time: z.string().optional().describe('24-hour HH:mm local time (use with day)'),
    }),
    async run(args, ctx) {
      const relative = args.in_minutes !== undefined;
      const clock = args.day !== undefined && args.time !== undefined;
      if (relative === clock) throw new Error('Provide either in_minutes, or both day and time');
      const dueAt = relative
        ? new Date(ctx.now().getTime() + args.in_minutes! * 60_000)
        : resolveLocalDateTime(args.day!, args.time!, ctx.now(), ctx.timezone);
      const r = await svc.create(ctx.channel, ctx.chatId, args.text, dueAt);
      return { id: r.id, text: r.text, due_at: r.dueAt.toISOString(), due_local: fmt(r.dueAt, ctx.timezone) };
    },
  });

  registry.register({
    name: 'list_reminders',
    description: "List the user's upcoming (not yet sent) reminders.",
    schema: z.object({}),
    async run(_args, ctx) {
      const list = await svc.list(ctx.channel, ctx.chatId);
      return {
        count: list.length,
        reminders: list.map((r) => ({ id: r.id, text: r.text, due_local: fmt(r.dueAt, ctx.timezone) })),
      };
    },
  });

  registry.register({
    name: 'cancel_reminder',
    description: 'Cancel an upcoming reminder by its id (get ids from list_reminders).',
    schema: z.object({ id: z.string().min(1) }),
    async run(args, ctx) {
      const done = await svc.cancel(ctx.channel, ctx.chatId, args.id);
      if (!done) throw new Error('No pending reminder with that id');
      return { cancelled: args.id };
    },
  });
}
