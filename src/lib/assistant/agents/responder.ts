// Prompt 3 - Responder: decision + ModuleResult -> UI JSON. Code then enforces the UI contract.
import { fill, RESPONDER_PROMPT } from "../core/prompts";
import { registry, type RegistryEntry, moduleCardJSON } from "../core/registry";
import {
  type Card,
  type Decision,
  type Item,
  type ModuleResult,
  type ResponderUI,
  ResponderUISchema,
  type UI,
} from "../core/schemas";
import type { Session } from "../core/state";
import { type Checked, runJSON } from "../core/validate";
import { dateLabel, t } from "../core/i18n";

export interface ResponderInput {
  decision: Decision;
  module_result: ModuleResult | null;
  topic_summary: string;
  last_result: ModuleResult | null;
  module_card: ReturnType<typeof moduleCardJSON> | null;
  pending_intents: string[];
  parked_topics: { id: string; module: string; summary: string }[];
  available_modules: { id: string; display_name: string }[];
  /** Slots filled by a registry fallback this turn: the reply asks about the first one after the results. */
  assumed_slots: Record<string, string>;
  language: string;
}

export function buildResponderInput(
  d: Decision,
  session: Session,
  entry: RegistryEntry | null,
  moduleResult: ModuleResult | null,
  lastResult: ModuleResult | null,
): ResponderInput {
  const active = session.topics.find((x) => x.id === session.active_topic_id);
  return {
    decision: d,
    module_result: moduleResult,
    topic_summary: active?.summary ?? "",
    last_result: d.decision === "answer_from_context" ? lastResult : null,
    module_card: entry ? moduleCardJSON(entry) : null,
    pending_intents: session.pending_intents,
    parked_topics: session.topics
      .filter((x) => x.status === "parked")
      .map((x) => ({
        id: x.id,
        module: registry().find((e) => e.id === x.module)?.display_name ?? x.module,
        summary: x.summary.slice(0, 160),
      })),
    available_modules: registry().map((e) => ({ id: e.id, display_name: e.display_name })),
    assumed_slots:
      d.decision === "route" && moduleResult?.status !== "need_input"
        ? Object.fromEntries(
            Object.entries(active?.assumed ?? {}).filter(
              ([k]) => !(active?.asked ?? []).includes(k),
            ),
          )
        : {},
    language: d.reply_language,
  };
}

/** What the Responder model sees: the same facts, without long URLs and nested data it never needs. */
function compactItem(i: Item) {
  const a = i.attributes;
  const pick = [
    "departure_date",
    "departure_time",
    "arrival_time",
    "arrival_day_offset",
    "stops_label",
    "duration",
    "from_airport",
    "to_airport",
    "airline",
    "tags",
    "return_date",
    "return_departure_time",
    "price_basis",
    "city",
    "films_today",
    "rating",
    "genres",
    "cinemas",
  ];
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    subtitle: i.subtitle,
    price: i.price.amount != null ? i.price : null,
    verify: i.verify,
    action: i.action.type,
    ...Object.fromEntries(pick.filter((k) => a[k] != null && a[k] !== "").map((k) => [k, a[k]])),
    ...(Array.isArray(a["showtimes"])
      ? { showtimes: (a["showtimes"] as { time?: string }[]).slice(0, 6).map((s) => s.time) }
      : {}),
  };
}
function compactResult(r: ModuleResult | null) {
  return r ? { ...r, items: r.items.map(compactItem) } : null;
}
export function responderView(input: ResponderInput) {
  return {
    ...input,
    decision: {
      decision: input.decision.decision,
      module: input.decision.module,
      missing_slot: input.decision.missing_slot,
      slots: input.decision.slots,
      task: input.decision.task,
    },
    module_result: compactResult(input.module_result),
    last_result: compactResult(input.last_result),
  };
}

// ---------- rule checks -------------------------------------------------------
const normNums = (s: string) =>
  s.replace(/(\d)[ ,\u00a0](?=\d{3}\b)/g, "$1").replace(/(\d),(\d)/g, "$1.$2");
const numbersIn = (s: string) => (normNums(s).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const sentences = (s: string) =>
  s
    .split(/(?<=[.!?…])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/[.!?…]/g, "").trim());
const isAsking = (ui: { text: string }, input: ResponderInput) =>
  input.decision.decision === "clarify" ||
  input.module_result?.status === "need_input" ||
  Object.keys(input.assumed_slots).length > 0 ||
  /[?؟]/.test(ui.text);
const itemsOf = (input: ResponderInput): Item[] => [
  ...(input.module_result?.items ?? []),
  ...(input.last_result?.items ?? []),
];

export function checkUI(ui: ResponderUI, input: ResponderInput): Checked {
  const hard: string[] = [],
    soft: string[] = [];
  // Every number in the text must exist in the facts given (counts of cards/items are allowed).
  const factText = JSON.stringify([
    input.module_result,
    input.last_result,
    input.topic_summary,
    input.decision.slots,
  ]);
  const allowed = new Set([...numbersIn(factText), ui.cards.length, itemsOf(input).length]);
  const bad = numbersIn(ui.text).filter((n) => !allowed.has(n));
  if (bad.length)
    hard.push(`text contains numbers not present in module_result/last_result: ${bad.join(", ")}`);
  if (sentences(ui.text).length > 2) soft.push("text must be max 2 sentences");
  if ((ui.text.match(/[?؟]/g) ?? []).length > 1) hard.push("text must contain max 1 question");
  if (/[*#`]|^\s*-\s/m.test(ui.text)) soft.push("no markdown in text");
  if (ui.cards.length > (input.module_card?.max_cards ?? 5)) soft.push("too many cards");
  const ids = new Set(itemsOf(input).map((i) => i.id));
  if (ui.cards.some((c) => !ids.has(c.id)))
    soft.push("every card id must be an item id from module_result/last_result");
  if (ui.quick_replies.length > 5) soft.push("max 5 quick_replies");
  if (ui.quick_replies.some((q) => q.label.trim().split(/\s+/).length > 4))
    soft.push("chip labels max 4 words");
  if (isAsking(ui, input)) {
    const last = ui.quick_replies.at(-1);
    if (!last || last.event.type !== "free_text")
      soft.push(
        'when asking, the last quick reply must be "Type my own" with event {"type":"free_text"}',
      );
    if (ui.quick_replies.filter((q) => q.event.type !== "free_text").length < 1)
      soft.push("a question needs 2-5 options");
  }
  return { hard, soft };
}

// ---------- code-side enforcement (always runs) ---------------------------------
export function finalizeUI(ui: ResponderUI, input: ResponderInput, session: Session): UI {
  const lang = input.language;
  const note = t("check_price", lang);
  const maxCards = input.module_card?.max_cards ?? 5;
  const items = new Map(itemsOf(input).map((i) => [i.id, i]));
  // A route reply always shows the module's results, even if the model listed no cards.
  const chosen =
    ui.cards.length || !input.module_result?.items.length
      ? ui.cards
      : input.module_result.items.map((i): ResponderUI["cards"][number] => ({ id: i.id }));
  // Cards: re-grounded on the stored items - titles, prices, times, URLs and actions come from data, never from the model.
  const cards: Card[] = [];
  for (const c of chosen) {
    const it = items.get(c.id);
    if (!it || cards.some((x) => x.id === it.id)) continue;
    let subtitle = it.subtitle;
    if (it.verify && !subtitle.toLowerCase().includes(note.toLowerCase()))
      subtitle = subtitle ? `${subtitle} · ${note}` : note;
    cards.push({
      id: it.id,
      kind: it.kind,
      title: it.title,
      subtitle,
      price:
        it.price.amount != null ? { from: it.price.amount, currency: it.price.currency } : null,
      attributes: it.attributes,
      source_url: it.source_url,
      verify: it.verify,
      action: {
        label: (typeof c.action?.label === "string" && c.action.label) || it.action.label,
        event:
          it.action.type === "handoff_url"
            ? { type: "handoff_url", value: it.action.value || it.source_url }
            : { type: "select", slot: it.kind, value: it.action.value },
      },
    });
    if (cards.length === maxCards) break;
  }

  const slotDefs = [
    ...(input.module_card?.required_slots ?? []),
    ...(input.module_card?.optional_slots ?? []),
  ];
  const topicIds = new Set(session.topics.map((x) => x.id));
  const urls = new Set(itemsOf(input).flatMap((i) => [i.source_url, i.action.value]));
  let qrs = ui.quick_replies
    .filter((q) => {
      const e = q.event;
      if (e.type === "switch_topic")
        return !!e.value && topicIds.has(e.value) && e.value !== session.active_topic_id;
      if (e.type === "select" && e.slot === "pending_intent")
        return session.pending_intents.includes(e.value ?? "");
      if (e.type === "handoff_url") return urls.has(e.value ?? "");
      return true;
    })
    .map((q) => {
      // A slot's picker option (e.g. "Pick dates") must open the date picker, not be sent as a value.
      const def = slotDefs.find((d) => d.name === q.event.slot);
      const event =
        def?.picker && q.event.type === "select" && q.event.value === def.picker.option
          ? { type: "date_picker" as const, slot: def.name }
          : q.event;
      // Date chips: the label is written in code from the ISO dates in the value (the model may garble month names).
      const dl = dateLabel(event.value ?? "", lang) ?? dateLabel(q.label, lang);
      if (dl) return { label: dl, event };
      return { label: q.label.trim().split(/\s+/).slice(0, 4).join(" "), event };
    });

  const asking = isAsking(ui, input);
  const free = qrs.filter((q) => q.event.type === "free_text");
  qrs = qrs.filter((q) => q.event.type !== "free_text");
  const chip = (label: string) => label.split(/\s+/).slice(0, 4).join(" ");
  if (asking && !qrs.length) {
    // A question must have options: take them from the registry slot definition.
    const slotName =
      input.decision.missing_slot?.name ??
      input.module_result?.need_input?.slot ??
      Object.keys(input.assumed_slots)[0];
    const def = slotDefs.find((s) => s.name === slotName);
    const opts = input.module_result?.need_input?.options?.length
      ? input.module_result.need_input.options
      : (def?.example_options ?? []);
    if (slotName === "module")
      qrs = input.available_modules.map((m) => ({
        label: m.display_name,
        event: { type: "select" as const, slot: "module", value: m.display_name },
      }));
    else {
      qrs = opts.slice(0, 4).map((o) => ({
        label: chip(o),
        event:
          def?.picker && o === def.picker.option
            ? { type: "date_picker" as const, slot: def.name }
            : { type: "select" as const, slot: slotName, value: o },
      }));
    }
  }
  if (!asking && qrs.length < 2) {
    // Doc: 2-5 quick replies. Top up from the module's refinements/suggestions, then parked topics.
    const extra = [
      ...(input.module_result?.refinements ?? []).map((r) => ({
        label: chip(r),
        event: { type: "refine" as const, value: r },
      })),
      ...(input.module_result?.suggestions ?? []).map((r) => ({
        label: chip(r.label),
        event: { type: "refine" as const, value: r.value },
      })),
      ...session.pending_intents.map((p) => ({
        label: chip(p),
        event: { type: "select" as const, slot: "pending_intent", value: p },
      })),
      ...input.parked_topics.map((p) => ({
        label: chip(p.module),
        event: { type: "switch_topic" as const, value: p.id },
      })),
      ...input.available_modules
        .filter((m) => m.id !== input.decision.module)
        .map((m) => ({
          label: chip(m.display_name),
          event: { type: "select" as const, slot: "module", value: m.display_name },
        })),
    ];
    for (const e of extra) {
      if (qrs.length >= 2) break;
      if (!qrs.some((q) => q.label === e.label)) qrs.push(e);
    }
  }
  qrs = qrs.slice(0, asking ? 4 : 5);
  if (asking) qrs.push(free[0] ?? { label: t("type_my_own", lang), event: { type: "free_text" } });

  let text = ui.text
    .replace(/[*#`]/g, "")
    .replace(/^\s*-\s+/gm, "")
    .trim();
  const ss = sentences(text);
  if (ss.length > 2) text = ss.slice(0, 2).join(" ");
  return { text, cards, quick_replies: qrs, input_hint: ui.input_hint ?? "" };
}

export function fallbackUI(_session: Session, language: string): UI {
  return {
    text: t("fallback", language),
    cards: [],
    quick_replies: [
      ...registry()
        .slice(0, 4)
        .map((e) => ({
          label: e.display_name,
          event: { type: "select" as const, slot: "module", value: e.display_name },
        })),
      { label: t("type_my_own", language), event: { type: "free_text" as const } },
    ],
    input_hint: "",
  };
}

export async function runResponder(input: ResponderInput, session: Session) {
  const system = fill(RESPONDER_PROMPT, {
    MAX_CARDS: String(input.module_card?.max_cards ?? 5),
    REPLY_LANGUAGE: input.language,
    CHECK_PRICE: t("check_price", input.language),
  });
  const { value, raw, calls } = await runJSON<ResponderUI>(
    "responder",
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(responderView(input)) },
    ],
    ResponderUISchema,
    (ui) => checkUI(ui, input),
  );
  return { ui: finalizeUI(value, input, session), raw, calls };
}
