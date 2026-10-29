// One turn: Orchestrator -> (Module Agent | direct adapter | nothing) -> Responder.
// Max 3 LLM calls (+1 retry each on invalid JSON). All state changes happen here, in code.
import { CONFIG, todayISO } from "../config";
import { runOrchestrator } from "../agents/orchestrator";
import { errorResult, runModuleAgent } from "../agents/module_agent";
import { buildResponderInput, fallbackUI, runResponder } from "../agents/responder";
import { AGENT_ADAPTERS, DIRECT_ADAPTERS } from "../tools/adapters";
import { parseRange } from "../tools/gifts";
import { newToolContext } from "../tools/web";
import { defaultValue, getEntry, type RegistryEntry, type SlotDef } from "./registry";
import {
  type Decision,
  type ModuleResult,
  ModuleResultSchema,
  type UI,
  type UIEvent,
} from "./schemas";
import {
  activeTopic,
  decodeState,
  encodeState,
  getResult,
  newSession,
  saveResult,
  type Session,
  type Topic,
} from "./state";

export interface TurnRequest {
  state?: string | null | undefined;
  message?: string | null | undefined;
  event?: UIEvent | null | undefined;
  user?:
    | {
        language?: string | undefined;
        citizenship?: string | undefined;
        home_city?: string | undefined;
      }
    | null
    | undefined;
  reset?: boolean | undefined;
}
export interface TurnResponse {
  state: string;
  ui: UI | null;
  meta: {
    decision: string | null;
    module: string | null;
    active_topic_id: string | null;
    topics: { id: string; module: string; status: string }[];
  };
  /** Every agent's JSON for this turn, as a JSON string (only when ASSISTANT_DEBUG=true). */
  debug?: string;
}

const clean = (slots: Record<string, string | null>) =>
  Object.fromEntries(
    Object.entries(slots)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => [k, String(v)]),
  );
const clipWords = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");

function park(s: Session) {
  const a = activeTopic(s);
  if (a) a.status = "parked";
}
function activate(s: Session, t: Topic) {
  if (s.active_topic_id !== t.id) park(s);
  t.status = "active";
  s.active_topic_id = t.id;
}
function newTopic(s: Session, module: string): Topic {
  const t: Topic = {
    id: `t${s.next_topic_num++}`,
    module,
    status: "active",
    slots: {},
    summary: "",
    last_result_ref: null,
  };
  s.topics.push(t);
  activate(s, t);
  return t;
}

const has = (slots: Record<string, string>, k: string) => !!(slots[k] ?? "").toString().trim();

/** Facts the user stated about themselves. A foreign passport makes the profile home city unsafe as origin. */
function applyProfile(s: Session, d: Decision) {
  const u = d.profile_updates ?? {};
  const cit = (u.citizenship ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cit) && cit !== s.user.citizenship) {
    s.user.citizenship = cit;
    if (cit !== s.user.home_country) s.user.home_city_confirmed = false;
  }
  const city = (u.home_city ?? "").trim();
  if (city && city.toLowerCase() !== s.user.home_city.toLowerCase()) {
    s.user.home_city = city;
    s.user.home_city_confirmed = true;
  }
}

/** Applies the Orchestrator's decision to the session state (topics, slots, summary, pending intents). */
export function applyDecision(s: Session, d: Decision): Decision {
  applyProfile(s, d);
  const entry = getEntry(d.module);
  const active = activeTopic(s);
  if (d.resume_topic_id) {
    const t = s.topics.find((x) => x.id === d.resume_topic_id);
    if (t) activate(s, t);
  } else if (entry && d.decision === "answer_from_context" && active?.module !== entry.id) {
    const t = [...s.topics].reverse().find((x) => x.module === entry.id);
    if (t) activate(s, t);
  } else if (
    entry &&
    (d.decision === "route" || d.decision === "clarify") &&
    (!active || d.topic_change || active.module !== entry.id)
  ) {
    newTopic(s, entry.id);
  }

  const cur = activeTopic(s);
  if (cur && entry && cur.module === entry.id && d.decision !== "out_of_scope") {
    const given = clean(d.slots);
    cur.assumed ??= {};
    // A value the user gave replaces a code fallback; an echoed fallback stays "assumed".
    for (const [k, v] of Object.entries(given)) if (cur.assumed[k] !== v) delete cur.assumed[k];
    cur.slots = { ...cur.slots, ...given };
    if (d.topic_summary.trim()) cur.summary = clipWords(d.topic_summary, 60);
  }
  for (const p of d.new_pending_intents)
    if (p.trim() && !s.pending_intents.includes(p)) s.pending_intents.push(p);
  s.pending_intents = s.pending_intents.slice(-5);

  if (!entry || !cur || (d.decision !== "route" && d.decision !== "clarify")) return d;
  if (d.decision === "clarify" && d.missing_slot?.name === "module") return d;
  return askOrAssume(s, cur, entry, d);
}

/**
 * "Ask as little as possible" in code:
 * - a missing slot with a registry fallback is filled with it (results first; the reply asks one follow-up),
 *   except an ask_first slot when nothing else about the request is known yet and it was never asked;
 * - a missing required slot without fallback, or an optional slot with an ask text and no usable default
 *   that the Orchestrator asks for (e.g. the departure city), is asked;
 * - the Orchestrator never gets to ask about anything else (it routes instead).
 */
function askOrAssume(s: Session, cur: Topic, entry: RegistryEntry, d: Decision): Decision {
  const today = todayISO();
  const slots = cur.slots;
  cur.asked ??= [];
  cur.assumed ??= {};
  const profile = s.user as unknown as Record<string, unknown>;
  const usable = (def: SlotDef) => has(slots, def.name) || !!defaultValue(def, profile, today);
  const missing = entry.required_slots.filter((def) => !usable(def));
  const knownOther = (def: SlotDef) =>
    Object.keys(slots).some((k) => k !== def.name && has(slots, k) && !(k in cur.assumed!));

  const toAsk: SlotDef[] = [];
  const toAssume: SlotDef[] = [];
  for (const def of missing) {
    const askFirst = def.ask_first && !cur.asked.includes(def.name) && !knownOther(def);
    if (def.fallback && !askFirst) toAssume.push(def);
    else toAsk.push(def);
  }
  // An optional slot the Orchestrator wants to ask about: allowed only if it has an ask text and no usable value.
  const wanted = d.decision === "clarify" ? d.missing_slot?.name : undefined;
  const wantedDef = [...entry.required_slots, ...entry.optional_slots].find(
    (x) => x.name === wanted,
  );
  if (
    wantedDef &&
    !toAsk.includes(wantedDef) &&
    wantedDef.ask &&
    !usable(wantedDef) &&
    !wantedDef.fallback &&
    !wantedDef.choose_first // picked from cards by the module step, not asked as a question
  )
    toAsk.unshift(wantedDef);

  if (toAsk.length) {
    const ask = toAsk.find((x) => x.name === wanted) ?? toAsk[0]!;
    if (!cur.asked.includes(ask.name)) cur.asked.push(ask.name);
    return {
      ...d,
      decision: "clarify",
      missing_slot: { name: ask.name, why: d.missing_slot?.why ?? "" },
    };
  }
  // Nothing left to ask: fill the fallbacks and show results (the reply asks one follow-up about them).
  for (const def of toAssume) {
    slots[def.name] = def.fallback!;
    cur.assumed[def.name] = def.fallback!;
  }
  const task =
    d.task.trim() ||
    `Help with this request: ${
      cur.summary ||
      Object.entries(slots)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    }`;
  return { ...d, decision: "route", missing_slot: null, task, slots: { ...slots } };
}

/** Registry defaults (e.g. origin = profile.home_city, only while the home city is confirmed) are filled in code. */
export function withDefaults(
  entry: RegistryEntry,
  slots: Record<string, string>,
  s: Session,
): Record<string, string> {
  const out = { ...slots };
  const profile = s.user as unknown as Record<string, unknown>;
  for (const d of [...entry.required_slots, ...entry.optional_slots]) {
    if (out[d.name]) continue;
    const v = defaultValue(d, profile, todayISO());
    if (v) out[d.name] = v;
  }
  return out;
}

/** A tap whose meaning is fully known in code: the module runs again without an Orchestrator call. */
type CodeRoute = { task: string };
type Pre = { userTurn: unknown; display: string; codeRoute?: CodeRoute };

/** Tap events: applied in code; the Orchestrator also sees the raw event (no label parsing). */
function preprocess(s: Session, req: TurnRequest): Pre | null {
  const e = req.event;
  if (!e) return { userTurn: req.message!.trim(), display: req.message!.trim() };
  const act = activeTopic(s);
  // Price filter chip under products: sets (or clears) budget_min / budget_max and shows the results again.
  if (e.type === "select" && e.slot === "price_range" && act) {
    const r = parseRange(e.value);
    for (const [k, v] of [
      ["budget_min", r.min],
      ["budget_max", r.max],
    ] as const) {
      if (v == null) delete act.slots[k];
      else act.slots[k] = String(v);
      if (act.assumed) delete act.assumed[k];
    }
    const what =
      r.min == null && r.max == null
        ? "any price"
        : `price ${r.min ?? 0}${r.max != null ? `-${r.max}` : "+"} AZN`;
    return {
      userTurn: e,
      display: `[filter] ${what}`,
      codeRoute: { task: `Show the same search filtered by ${what}.` },
    };
  }
  // A card picked for a choose_first slot (e.g. a cinema): fill it and continue the request.
  const entry = act ? getEntry(act.module) : null;
  const chooseDef =
    entry && e.type === "select" && e.slot && e.value
      ? [...entry.required_slots, ...entry.optional_slots].find(
          (d) => d.choose_first && d.name === e.slot,
        )
      : undefined;
  if (act && chooseDef && e.value) {
    act.slots[chooseDef.name] = e.value;
    return {
      userTurn: e,
      display: `[tap] ${chooseDef.name}=${e.value}`,
      codeRoute: {
        task: `The user picked ${chooseDef.name} "${e.value}". Continue the request with it${
          act.summary ? `: ${act.summary}` : "."
        }`,
      },
    };
  }
  if (e.type === "free_text" || e.type === "handoff_url") return null; // handled by the app
  if (e.type === "select" && e.slot === "pending_intent") {
    s.pending_intents = s.pending_intents.filter((p) => p !== e.value);
    return { userTurn: e.value ?? "", display: e.value ?? "" };
  }
  if (e.type === "select" && e.slot === "module")
    return { userTurn: e.value ?? "", display: e.value ?? "" };
  if (e.type === "switch_topic") {
    const t = s.topics.find((x) => x.id === e.value);
    if (t) activate(s, t);
    return {
      userTurn: { ...e, note: t ? `user went back to topic ${t.id}` : "unknown topic" },
      display: `[back to ${e.value}]`,
    };
  }
  const a = activeTopic(s);
  if (a && e.slot && e.value && (e.type === "select" || e.type === "date_picker"))
    a.slots[e.slot] = e.value;
  return { userTurn: e, display: `[tap] ${e.slot ? e.slot + "=" : ""}${e.value ?? e.type}` };
}

/**
 * A slot with `choose_first` (e.g. cinema) that is still empty: run its tool in code and return the items as
 * cards to pick from (status need_input). No model call. Null when the slot is filled or the tool found nothing.
 */
export async function chooseFirst(
  entry: RegistryEntry,
  slots: Record<string, string>,
): Promise<ModuleResult | null> {
  const def = [...entry.required_slots, ...entry.optional_slots].find(
    (d) => d.choose_first && !has(slots, d.name),
  );
  const tool = def && entry.tools.find((x) => x.name === def.choose_first);
  const adapter = tool && AGENT_ADAPTERS[tool.adapter];
  if (!def || !tool || !adapter) return null;
  const props = Object.keys(
    ((tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {}) as object,
  );
  const args = Object.fromEntries(props.filter((k) => has(slots, k)).map((k) => [k, slots[k]]));
  const ctx = newToolContext();
  try {
    await adapter(args, tool, ctx);
  } catch (e) {
    console.error("choose_first tool failed:", (e as Error).message);
    return null;
  }
  const items = [...ctx.items.values()].slice(0, entry.max_cards ?? CONFIG.defaultMaxCards);
  if (!items.length) return null;
  return {
    status: "need_input",
    summary: `${items.length} options for ${def.name}; the user picks one first.`,
    items,
    suggestions: [],
    need_input: { slot: def.name, ask: def.ask ?? "", options: def.example_options ?? [] },
    refinements: [],
  };
}

export async function handleTurn(req: TurnRequest): Promise<TurnResponse> {
  const started = Date.now();
  let session = (!req.reset ? await decodeState(req.state) : null) ?? newSession(req.user ?? null);
  // The app's profile seeds a new session only. Later turns keep what the user said in the chat
  // (e.g. "I have an Italian passport"); just the UI language follows the app setting.
  if (req.user?.language) session.user.language = req.user.language;
  const meta = (d: Decision | null): TurnResponse["meta"] => ({
    decision: d?.decision ?? null,
    module: d?.module ?? null,
    active_topic_id: session.active_topic_id,
    topics: session.topics.map((x) => ({ id: x.id, module: x.module, status: x.status })),
  });

  if (req.reset && !req.message && !req.event) {
    session = newSession(req.user ?? session.user);
    return { state: await encodeState(session), ui: null, meta: meta(null) };
  }
  const pre = preprocess(session, req);
  if (!pre) return { state: await encodeState(session), ui: null, meta: meta(null) };

  const log: Record<string, unknown> = {
    session: session.session_id,
    at: new Date().toISOString(),
    request: { message: req.message, event: req.event },
  };
  let decision: Decision | null = null;
  let ui: UI;
  try {
    // 1) Orchestrator (skipped for taps whose meaning code already knows: price filters, a picked cinema)
    const routedTopic = pre.codeRoute ? activeTopic(session) : null;
    let raw: Decision;
    if (pre.codeRoute && routedTopic) {
      raw = {
        decision: "route",
        module: routedTopic.module,
        topic_change: false,
        resume_topic_id: null,
        slots: { ...routedTopic.slots },
        missing_slot: null,
        task: pre.codeRoute.task,
        topic_summary: "",
        new_pending_intents: [],
        reply_language: session.last_language ?? session.user.language,
        profile_updates: {},
      };
      log["orchestrator"] = { skipped: "tap routed in code", output: raw };
    } else {
      const orch = await runOrchestrator(session, pre.userTurn);
      log["orchestrator"] = { input: structuredClone(orch.input), output: orch.decision };
      raw = orch.decision;
    }
    session.last_language = raw.reply_language;
    decision = applyDecision(session, raw);
    log["decision_applied"] = decision;
    const entry: RegistryEntry | null = getEntry(decision.module);
    const topic = activeTopic(session);

    // 2) Module (only for route)
    let moduleResult: ModuleResult | null = null;
    let lastResult: ModuleResult | null = null;
    if (decision.decision === "route" && entry && topic) {
      const slots = withDefaults(entry, topic.slots, session);
      if (entry.executor === "direct") {
        const adapterName = entry.tools[0]?.adapter ?? "";
        const adapter = DIRECT_ADAPTERS[adapterName];
        try {
          if (!adapter) throw new Error(`direct adapter ${adapterName} not found`);
          const query = slots[entry.required_slots[0]?.name ?? "query"] ?? decision.task;
          moduleResult = ModuleResultSchema.parse(
            await adapter({ query, slots, session, language: decision.reply_language }),
          );
        } catch (e) {
          moduleResult = errorResult((e as Error).message);
        }
        log["module"] = { executor: "direct", input: { slots }, output: moduleResult };
      } else if ((moduleResult = await chooseFirst(entry, slots))) {
        log["module"] = { executor: "choose_first", input: { slots }, output: moduleResult };
      } else {
        const m = await runModuleAgent(
          entry,
          decision.task,
          slots,
          topic.summary,
          session,
          getResult(session, topic.last_result_ref),
        );
        moduleResult = m.result;
        log["module"] = {
          executor: "agent",
          input: { task: decision.task, slots, topic_summary: topic.summary, user: session.user },
          tools: m.toolLog,
          dropped: m.dropped,
          raw_output: m.raw,
          output: m.result,
        };
      }
      if (moduleResult.status === "error") throw new Error("module error: " + moduleResult.summary);
      if (moduleResult.items.length) topic.last_result_ref = saveResult(session, moduleResult);
      if (moduleResult.status === "need_input" && moduleResult.need_input) {
        topic.asked ??= [];
        if (!topic.asked.includes(moduleResult.need_input.slot))
          topic.asked.push(moduleResult.need_input.slot);
      }
    } else if (decision.decision === "answer_from_context" && topic) {
      lastResult = getResult(session, topic.last_result_ref);
    }

    // 3) Responder
    const rin = buildResponderInput(decision, session, entry, moduleResult, lastResult);
    const r = await runResponder(rin, session);
    ui = r.ui;
    log["responder"] = { input: rin, output: ui, retried: r.raw.length > 1 };
    // The follow-up question about a guessed slot is asked once; after that the guess stands quietly.
    if (topic && Object.keys(rin.assumed_slots).length) {
      topic.asked ??= [];
      const first = Object.keys(rin.assumed_slots)[0]!;
      if (!topic.asked.includes(first)) topic.asked.push(first);
    }
  } catch (e) {
    console.error("turn failed:", (e as Error).message);
    log["error"] = (e as Error).message;
    ui = fallbackUI(session, decision?.reply_language ?? session.user.language);
  }

  session.recent_turns.push(
    { role: "user", text: pre.display.slice(0, 500) },
    { role: "assistant", text: ui.text },
  );
  session.recent_turns = session.recent_turns.slice(-CONFIG.recentTurns * 2);
  log["ms"] = Date.now() - started;
  // Every agent's input and output JSON for the turn goes to the server log (Lovable Cloud / Worker logs).
  console.log("[assistant-turn]", JSON.stringify(log));

  return {
    state: await encodeState(session),
    ui,
    meta: meta(decision),
    ...(CONFIG.debug() ? { debug: JSON.stringify(log) } : {}),
  };
}
