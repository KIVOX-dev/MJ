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
      'Create a reminder sent to the user in this chat. Time: either in_minutes (relative, e.g. "in 2 minutes" = 2), or day ("today", "tomorrow" or YYYY-MM-DD) + time (24-hour HH:mm, Asia/Kolkata). ' +
      'Pass the words "today"/"tomorrow", never compute dates. Every reminder repeats every 10 minutes with a Stop button until stopped; set repeat_every_minutes only for another interval, and once=true only if the user explicitly wants a single reminder.',
    schema: z.object({
      text: z.string().min(1).max(500).describe('What to remind the user about, phrased as a short message'),
      in_minutes: z.number().int().min(1).max(525600).optional().describe('Minutes from now'),
      day: z.string().optional().describe('"today", "tomorrow" or YYYY-MM-DD (use with time)'),
      time: z.string().optional().describe('24-hour HH:mm local time (use with day)'),
      repeat_every_minutes: z.number().int().min(1).max(1440).optional().describe('Repeat interval in minutes (default 10)'),
      once: z.boolean().optional().describe('true ONLY if the user explicitly wants a single, non-repeating reminder'),
    }),
    async run(args, ctx) {
      const relative = args.in_minutes !== undefined;
      const clock = args.day !== undefined && args.time !== undefined;
      if (relative === clock) throw new Error('Provide either in_minutes, or both day and time');
      const dueAt = relative
        ? new Date(ctx.now().getTime() + args.in_minutes! * 60_000)
        : resolveLocalDateTime(args.day!, args.time!, ctx.now(), ctx.timezone);
      const r = await svc.create(ctx.channel, ctx.chatId, args.text, dueAt, args.once ? undefined : (args.repeat_every_minutes ?? 10));
      return {
        id: r.id,
        text: r.text,
        due_at: r.dueAt.toISOString(),
        due_local: fmt(r.dueAt, ctx.timezone),
        repeats_every_min: r.repeatEveryMin ?? null,
        stop_hint: r.repeatEveryMin ? (ctx.channel === 'telegram' ? 'A Stop button appears on each reminder' : 'Tell me "stop reminders" to stop it') : null,
      };
    },
  });

  registry.register({
    name: 'list_reminders',
    description: "List the user's upcoming (not yet finished) reminders, including repeating ones.",
    schema: z.object({}),
    async run(_args, ctx) {
      const list = await svc.list(ctx.channel, ctx.chatId);
      return {
        count: list.length,
        reminders: list.map((r) => ({
          id: r.id,
          text: r.text,
          due_local: fmt(r.dueAt, ctx.timezone),
          repeats_every_min: r.repeatEveryMin ?? null,
        })),
      };
    },
  });

  registry.register({
    name: 'cancel_reminder',
    description: 'Stop one reminder (one-time or repeating) by its id (get ids from list_reminders).',
    schema: z.object({ id: z.string().min(1) }),
    async run(args, ctx) {
      const done = await svc.cancel(ctx.channel, ctx.chatId, args.id);
      if (!done) throw new Error('No active reminder with that id');
      return { cancelled: args.id };
    },
  });

  registry.register({
    name: 'cancel_all_reminders',
    description: 'Stop ALL of the user\'s active reminders, including repeating ones. Use for "stop all reminders" or "stop the reminders".',
    schema: z.object({}),
    async run(_args, ctx) {
      return { cancelled_count: await svc.cancelAll(ctx.channel, ctx.chatId) };
    },
  });
}
