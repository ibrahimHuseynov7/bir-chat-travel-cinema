// JSON contracts between agents (rule 6). Code validates every agent output against these.
import { z } from "zod";

const str = z.string();
const slotValue = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

// ---- Events sent by the app when the user taps something --------------------
export const EVENT_TYPES = [
  "select",
  "refine",
  "free_text",
  "date_picker",
  "handoff_url",
  "switch_topic",
] as const;
export const EventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  slot: str.optional().nullable(),
  value: str.optional().nullable(),
});
export type UIEvent = z.infer<typeof EventSchema>;

// ---- Prompt 1: Orchestrator output ------------------------------------------
export const DecisionSchema = z.object({
  decision: z.enum(["route", "clarify", "answer_from_context", "out_of_scope"]),
  module: str.nullable().default(null),
  topic_change: z.boolean().default(false),
  resume_topic_id: str.nullable().default(null),
  slots: z.record(slotValue.nullable()).default({}),
  missing_slot: z
    .object({ name: str, why: str.optional().default("") })
    .nullable()
    .default(null),
  task: str.default(""),
  topic_summary: str.default(""),
  new_pending_intents: z.array(str).default([]),
  reply_language: str.default("en"),
  /** Facts about the user stated in this turn ("I have an Italian passport", "I live in Milan"). */
  profile_updates: z
    .object({
      citizenship: str.nullable().optional(),
      home_city: str.nullable().optional(),
    })
    .nullable()
    .default({})
    .transform((v) => v ?? {}),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ---- Prompt 2: Module Agent output = ModuleResult -----------------------------
export const ItemSchema = z.object({
  id: str,
  kind: str,
  title: str,
  subtitle: str.default(""),
  attributes: z.record(z.any()).default({}),
  price: z
    .object({ amount: z.number().nullable().default(null), currency: str.nullable().default(null) })
    .default({ amount: null, currency: null }),
  source_url: str.default(""),
  verify: z.boolean().default(false),
  action: z.object({ label: str, type: z.enum(["select", "handoff_url"]), value: str }),
});
export type Item = z.infer<typeof ItemSchema>;

export const ModuleResultSchema = z.object({
  status: z.enum(["ok", "partial", "no_results", "need_input", "error"]),
  summary: str.default(""),
  items: z.array(ItemSchema).default([]),
  suggestions: z.array(z.object({ label: str, value: str })).default([]),
  need_input: z
    .object({ slot: str, ask: str.optional().default(""), options: z.array(str).default([]) })
    .nullable()
    .default(null),
  refinements: z.array(str).default([]),
});
export type ModuleResult = z.infer<typeof ModuleResultSchema>;

// ---- Prompt 3: Responder output = UI JSON -------------------------------------
export const CardSchema = z.object({
  id: str,
  kind: str,
  title: str,
  subtitle: str.default(""),
  price: z
    .object({
      from: z.number().nullable().optional(),
      amount: z.number().nullable().optional(),
      currency: str.nullable().optional(),
    })
    .nullable()
    .optional(),
  attributes: z.record(z.any()).optional(),
  verify: z.boolean().optional(),
  source_url: str.optional().default(""),
  action: z.object({ label: str, event: EventSchema }),
});
/** What the Responder may return for a card: the item id is enough; code copies everything else from data. */
export const ResponderCardSchema = z
  .object({
    id: str,
    title: str.optional(),
    subtitle: str.optional(),
    action: z.object({ label: str.optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
export const QuickReplySchema = z.object({ label: str.min(1), event: EventSchema });
export const UISchema = z.object({
  text: str.min(1),
  cards: z.array(CardSchema).default([]),
  quick_replies: z.array(QuickReplySchema).default([]),
  input_hint: str.optional().default(""),
});
export type UI = z.infer<typeof UISchema>;
export const ResponderUISchema = z.object({
  text: str.min(1),
  cards: z.array(ResponderCardSchema).default([]),
  quick_replies: z.array(QuickReplySchema).default([]),
  input_hint: str.nullable().optional().default(""),
});
export type ResponderUI = z.infer<typeof ResponderUISchema>;
export type Card = z.infer<typeof CardSchema>;

// ---- Request to the edge function -------------------------------------------
export const RequestSchema = z
  .object({
    state: str.max(300_000).optional().nullable(), // signed session-state token from the previous reply
    message: str.max(4000).optional().nullable(),
    event: EventSchema.optional().nullable(),
    user: z
      .object({
        language: str.max(5).optional(),
        citizenship: str.max(3).optional(),
        home_city: str.max(80).optional(),
      })
      .optional()
      .nullable(),
    reset: z.boolean().optional(),
  })
  .refine((r) => r.reset || (r.message && r.message.trim()) || r.event, {
    message: "Send a message or an event.",
  });

export function zodErrors(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
