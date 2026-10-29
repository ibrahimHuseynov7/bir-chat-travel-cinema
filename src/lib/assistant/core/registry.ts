// Registry loader: reads the YAML, keeps enabled entries, builds module cards for the
// Orchestrator and tool configs for the Module Agent. Only this file knows the format.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import REGISTRY_YAML from "../registry.yaml";

const SlotSchema = z.object({
  name: z.string(),
  ask: z.string().optional(),
  example_options: z.array(z.string()).optional(),
  default: z.string().optional(),
  // Which example option opens the app's date picker instead of being sent as a value.
  picker: z.object({ type: z.literal("date"), option: z.string() }).optional(),
  // How the Orchestrator must write this slot's value (e.g. Azerbaijani product words for Birmarket).
  hint: z.string().optional(),
  // The default applies only when this profile flag is true (e.g. profile.home_city_confirmed).
  default_if: z.string().optional(),
  // Value used instead of asking, so the user sees results first; the reply then asks ONE follow-up.
  fallback: z.string().optional(),
  // Ask once before using the fallback, but only when nothing else about the request is known yet.
  ask_first: z.boolean().optional(),
  // How the Responder should build options when example_options don't fit (e.g. cities of the user's country).
  options_hint: z.string().optional(),
});
const ToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().default(""),
  input_schema: z.record(z.any()),
  adapter: z.string(),
  default_site_filter: z.array(z.string()).optional(),
});
const EntrySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  enabled: z.boolean(),
  version: z.union([z.number(), z.string()]).optional(),
  owner: z.string().optional(),
  executor: z.enum(["agent", "direct"]),
  description: z.string(),
  use_when: z.array(z.string()).default([]),
  not_when: z.array(z.string()).default([]),
  required_slots: z.array(SlotSchema).default([]),
  optional_slots: z.array(SlotSchema).default([]),
  max_tool_calls: z.number().int().positive().optional(),
  // Max cards in one reply for this module (doc default 5; lists like flight options need more).
  max_cards: z.number().int().positive().max(10).optional(),
  tools: z.array(ToolSchema).min(1),
  module_instructions: z.string().default(""),
  result_kinds: z.array(z.string()).default([]),
  // The Module Agent also gets the user's own words this turn (e.g. shopping: colour / size the task left out).
  pass_user_message: z.boolean().default(false),
});
export type RegistryEntry = z.infer<typeof EntrySchema>;
export type ToolConfig = z.infer<typeof ToolSchema>;
export type SlotDef = z.infer<typeof SlotSchema>;

export function loadRegistry(yamlText: string = REGISTRY_YAML): RegistryEntry[] {
  const raw = parseYaml(yamlText);
  if (!Array.isArray(raw)) throw new Error("Registry YAML must be a list of entries");
  const entries = raw
    .map((e, i) => {
      const r = EntrySchema.safeParse(e);
      if (!r.success)
        throw new Error(`Registry entry #${i} (${e?.id ?? "?"}) is invalid: ${r.error.message}`);
      return r.data;
    })
    .filter((e) => e.enabled);
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`Duplicate registry id: ${e.id}`);
    ids.add(e.id);
  }
  return entries;
}

let _registry: RegistryEntry[] | null = null;
export function registry(): RegistryEntry[] {
  return (_registry ??= loadRegistry());
}
export function setRegistry(r: RegistryEntry[]) {
  _registry = r;
}
export const getEntry = (id: string | null | undefined) =>
  registry().find((e) => e.id === id) ?? null;

const fmtSlot = (s: SlotDef) =>
  s.name +
  (s.ask ? ` (ask: "${s.ask}")` : "") +
  (s.default ? ` (default: ${s.default}${s.default_if ? ` only if ${s.default_if}` : ""})` : "") +
  (s.fallback ? ` (if unknown, code uses: ${s.fallback})` : "") +
  (s.example_options?.length ? ` (options: ${s.example_options.join(", ")})` : "") +
  (s.hint ? ` (value format: ${s.hint})` : "");

/** One "module card" per entry, injected into the Orchestrator prompt at {{MODULE_CARDS}}. */
export function moduleCards(entries = registry()): string {
  return entries
    .map((e) =>
      [
        `- id: ${e.id} | ${e.description}`,
        `  use_when: ${e.use_when.join(", ")}`,
        `  not_when: ${e.not_when.join(", ") || "-"}`,
        `  required_slots: ${e.required_slots.map(fmtSlot).join("; ") || "none"}`,
        `  optional_slots: ${e.optional_slots.map(fmtSlot).join("; ") || "none"}`,
      ].join("\n"),
    )
    .join("\n");
}

/** Compact card for the Responder (slot ask texts + example options). */
export function moduleCardJSON(e: RegistryEntry) {
  return {
    id: e.id,
    display_name: e.display_name,
    description: e.description,
    required_slots: e.required_slots,
    optional_slots: e.optional_slots,
    result_kinds: e.result_kinds,
    max_cards: e.max_cards ?? 5,
  };
}

type Profile = Record<string, unknown>;
/** Value of a registry default for this user, or "" when it does not apply (default_if is false). */
export function defaultValue(s: SlotDef, profile: Profile, today: string): string {
  if (!s.default) return "";
  if (s.default_if) {
    const flag = s.default_if.startsWith("profile.") ? profile[s.default_if.slice(8)] : true;
    if (!flag) return "";
  }
  if (s.default === "today") return today;
  if (s.default.startsWith("profile.")) return String(profile[s.default.slice(8)] ?? "");
  return s.default;
}

/** Required slots still missing after defaults are applied. */
export function missingRequired(
  e: RegistryEntry,
  slots: Record<string, string>,
  profile: Profile = {},
): SlotDef[] {
  return e.required_slots.filter(
    (s) => !defaultValue(s, profile, "x") && !(slots[s.name] ?? "").toString().trim(),
  );
}

/** Tools of one entry in Chat Completions function-calling format. */
export function openAITools(e: RegistryEntry) {
  return e.tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}
