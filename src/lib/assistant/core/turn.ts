// One turn: Orchestrator -> (Module Agent | direct adapter | nothing) -> Responder.
// Max 3 LLM calls (+1 retry each on invalid JSON). All state changes happen here, in code.
import { CONFIG, todayISO } from "../config";
import type { LLMStats } from "./llm";
import { runOrchestrator } from "../agents/orchestrator";
import { errorResult, runModuleAgent } from "../agents/module_agent";
import { buildResponderInput, fallbackUI, runResponder } from "../agents/responder";
import { DIRECT_ADAPTERS, prewarmTools } from "../tools/adapters";
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
  /** Pipeline telemetry for the in-app debugger (off with ASSISTANT_TRACE=false). */
  trace?: TurnTrace;
}
export interface TurnTrace {
  provider: string;
  model: string;
  /** Extra LLM calls caused by invalid JSON (each agent retries once). */
  retries: number;
  latency: {
    orchestrator: number | null;
    module: number | null;
    responder: number | null;
    total: number;
  };
  /** args is the tool's JSON input, pretty-printed (keeps the server-fn response serializable). */
  tool_calls: {
    tool: string;
    args: string;
    ok: boolean;
    ms?: number;
    items?: number;
    note?: string;
  }[];
  /** Every model call of the turn, in order (module agent steps included). */
  llm_calls: LLMStats[];
  decision: Decision | null;
  module_result: ModuleResult | null;
  responder: UI | null;
  error: string | null;
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
    !wantedDef.fallback
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

/** Tap events: applied in code; the Orchestrator also sees the raw event (no label parsing). */
function preprocess(s: Session, req: TurnRequest): { userTurn: unknown; display: string } | null {
  const e = req.event;
  if (!e) return { userTurn: req.message!.trim(), display: req.message!.trim() };
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
  const trace: TurnTrace = {
    provider: "azure",
    model: CONFIG.azure.deployment("orchestrator"),
    retries: 0,
    latency: { orchestrator: null, module: null, responder: null, total: 0 },
    tool_calls: [],
    llm_calls: [],
    decision: null,
    module_result: null,
    responder: null,
    error: null,
  };
  let t0 = Date.now();
  try {
    // 1) Orchestrator
    const orch = await runOrchestrator(session, pre.userTurn);
    trace.latency.orchestrator = Date.now() - t0;
    trace.retries += orch.raw.length - 1;
    trace.llm_calls.push(...orch.calls);
    log["orchestrator"] = { input: structuredClone(orch.input), output: orch.decision };
    decision = applyDecision(session, orch.decision);
    log["decision_applied"] = decision;
    trace.decision = decision;
    const entry: RegistryEntry | null = getEntry(decision.module);
    const topic = activeTopic(session);

    // 2) Module (only for route)
    let moduleResult: ModuleResult | null = null;
    let lastResult: ModuleResult | null = null;
    if (decision.decision === "route" && entry && topic) {
      t0 = Date.now();
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
        trace.tool_calls.push({
          tool: entry.tools[0]?.name ?? adapterName,
          args: JSON.stringify(slots, null, 2),
          ok: moduleResult.status !== "error",
          ms: Date.now() - t0,
          items: moduleResult.items.length,
        });
      } else {
        prewarmTools(entry, slots);
        const m = await runModuleAgent(
          entry,
          decision.task,
          slots,
          topic.summary,
          session,
          getResult(session, topic.last_result_ref),
          entry.pass_user_message ? pre.display : undefined,
        );
        moduleResult = m.result;
        trace.retries += Math.max(0, m.raw.length - 1);
        trace.llm_calls.push(...m.calls);
        trace.tool_calls.push(
          ...m.toolLog.map((c) => ({ ...c, args: JSON.stringify(c.args, null, 2) })),
        );
        log["module"] = {
          executor: "agent",
          input: { task: decision.task, slots, topic_summary: topic.summary, user: session.user },
          tools: m.toolLog,
          dropped: m.dropped,
          raw_output: m.raw,
          output: m.result,
        };
      }
      trace.latency.module = Date.now() - t0;
      trace.module_result = moduleResult;
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
    t0 = Date.now();
    const r = await runResponder(rin, session);
    ui = r.ui;
    trace.latency.responder = Date.now() - t0;
    trace.retries += r.raw.length - 1;
    trace.llm_calls.push(...r.calls);
    trace.responder = ui;
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
    trace.error = (e as Error).message;
    ui = fallbackUI(session, decision?.reply_language ?? session.user.language);
  }

  session.recent_turns.push(
    { role: "user", text: pre.display.slice(0, 500) },
    { role: "assistant", text: ui.text },
  );
  session.recent_turns = session.recent_turns.slice(-CONFIG.recentTurns * 2);
  log["ms"] = Date.now() - started;
  trace.latency.total = log["ms"] as number;
  // Every agent's input and output JSON for the turn goes to the server log (Lovable Cloud / Worker logs).
  console.log("[assistant-turn]", JSON.stringify(log));

  return {
    state: await encodeState(session),
    ui,
    meta: meta(decision),
    ...(CONFIG.debug() ? { debug: JSON.stringify(log) } : {}),
    ...(CONFIG.trace() ? { trace } : {}),
  };
}
