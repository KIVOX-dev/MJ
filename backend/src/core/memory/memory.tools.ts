import { z } from 'zod';
import type { ToolRegistry } from '../tool-registry';
import type { MemoryService } from './memory.service';

export function registerMemoryTools(registry: ToolRegistry, memory: MemoryService): void {
  registry.register({
    name: 'remember_fact',
    description:
      'Save ONE lasting fact about the user so you remember it in future chats: name, college, work, location, goals, ' +
      'preferences, family or contacts they tell you. Write it as a short third-person sentence (e.g. "Kaviarasan studies ' +
      'at Sri Krishna Arts and Science College, Coimbatore"). Use it when the user shares personal details or asks you to ' +
      'remember something. NEVER save passwords, PINs, API keys, tokens or card numbers.',
    schema: z.object({
      fact: z.string().min(3).max(300),
      category: z.enum(['profile', 'preference', 'goal', 'contact', 'other']).default('other').describe('profile = who the user is'),
    }),
    async run(args) {
      const r = await memory.remember(args.fact, args.category);
      return { id: r.id, saved: r.fact, already_known: r.duplicate };
    },
  });

  registry.register({
    name: 'list_memories',
    description: 'Show everything MJ has stored about the user (use when they ask "what do you know about me?" or want to review it).',
    schema: z.object({}),
    async run() {
      const all = await memory.list();
      return { count: all.length, memories: all.map((m) => ({ id: m.id, fact: m.fact, category: m.category })) };
    },
  });

  registry.register({
    name: 'forget_memory',
    description: 'Delete one stored fact by its id (get ids from list_memories). Use when the user asks you to forget something.',
    schema: z.object({ id: z.string().min(1) }),
    async run(args) {
      if (!(await memory.forget(args.id))) throw new Error('No stored memory with that id');
      return { forgotten: args.id };
    },
  });

  registry.register({
    name: 'forget_all_memories',
    description: 'Erase EVERYTHING stored about the user. Only when they explicitly ask to delete all their data.',
    schema: z.object({}),
    async run() {
      return { erased: await memory.forgetAll() };
    },
  });
}
