import { z } from 'zod';
import type { ToolSpec } from '../ai-engine/groq.service';
import type { Channel } from '../memory/message.store';

/** Who is talking to MJ, so tools can act for (and reply to) the right chat. */
export interface ToolContext {
  channel: Channel;
  chatId: string;
  timezone: string;
  now: () => Date;
  /** Unique per assistant turn (one user message). Lets a tool tell "same message" from "a later message". */
  turnId?: string;
  /** Hands a generated picture (by id) to the chat layer, which shows it to the user. Absent on chats that cannot show pictures. */
  onImage?: (imageId: string) => void;
  /** Shows an email draft to the user with Send and Discard buttons. Absent on chats without buttons. */
  onDraft?: (draft: { id: string; to: string; subject: string; body: string }) => void;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Consequential tools (sending email, deleting events) must be gated by user approval. */
  requiresApproval?: boolean;
  run(args: z.infer<S>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register<S extends z.ZodObject>(tool: ToolDef<S>): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDef);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
      return { type: 'function' as const, function: { name: t.name, description: t.description, parameters } };
    });
  }

  /** Validates arguments, runs the tool and always returns a structured result (never throws). */
  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    let parsedJson: unknown;
    try {
      parsedJson = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, error: 'Arguments were not valid JSON' };
    }
    const args = tool.schema.safeParse(parsedJson);
    if (!args.success) {
      return { ok: false, error: `Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    }
    if (tool.requiresApproval) {
      // The approval workflow arrives with the first consequential tools (email/calendar deletion).
      return { ok: false, error: 'This action requires approval, which is not available yet' };
    }
    try {
      return { ok: true, ...(await tool.run(args.data, ctx)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
