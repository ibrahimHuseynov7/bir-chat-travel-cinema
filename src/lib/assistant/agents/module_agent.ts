// Prompt 2 - Module Agent: one template for every executor:agent module; runs that module's tools.
// Speed: tool calls of one step run in parallel; tools hand over ready-made items that the agent picks by
// {"ref": id}, so the agent writes a short JSON instead of re-typing every flight/showtime.
import { CONFIG, todayISO } from "../config";
import { type ChatMessage, llm, parseJSONObject } from "../core/llm";
import { fill, MODULE_AGENT_PROMPT } from "../core/prompts";
import { openAITools, type RegistryEntry } from "../core/registry";
import { type Item, type ModuleResult, ModuleResultSchema, zodErrors } from "../core/schemas";
import type { Session } from "../core/state";
import { AGENT_ADAPTERS } from "../tools/adapters";
import { loadRates, parseBudget, withinBudget } from "../tools/money";
import { newToolContext, normUrl, type ToolContext } from "../tools/web";

const MAX_TOOL_RESULT_CHARS = 12000;
export const errorResult = (summary: string): ModuleResult => ({
  status: "error",
  summary,
  items: [],
  suggestions: [],
  need_input: null,
  refinements: [],
});

/** {"ref": "f_x"} entries -> the stored items (facts copied from tool data, never from the model). */
export function expandRefs(raw: unknown, ctx: ToolContext): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items))
    return raw;
  const r = raw as { items: unknown[] };
  return {
    ...r,
    items: r.items.flatMap((it) => {
      if (it && typeof it === "object" && "ref" in it) {
        const ref = String((it as { ref: unknown }).ref);
        const stored = ctx.items.get(ref);
        return stored ? [structuredClone(stored)] : [];
      }
      return [it];
    }),
  };
}

/**
 * Rule 4 in code: drop items whose source_url no tool returned; unconfirmed prices get verify=true.
 * Also enforces the user's budget (items above it are removed) and the module's card limit.
 */
export function groundResult(
  r: ModuleResult,
  ctx: ToolContext,
  opts: { budget?: string | undefined; maxItems?: number } = {},
): { result: ModuleResult; dropped: string[] } {
  const dropped: string[] = [];
  const budget = parseBudget(opts.budget);
  const seenIds = new Set<string>();
  let items = r.items.filter((it) => {
    if (seenIds.has(it.id)) return false;
    seenIds.add(it.id);
    const how = it.source_url ? ctx.seen.get(normUrl(it.source_url)) : undefined;
    if (!how) {
      dropped.push(`${it.id}: source_url ${it.source_url || "(empty)"} not returned by any tool`);
      return false;
    }
    if (how !== "fetched" && it.price.amount != null) it.verify = true;
    if (it.action.type === "handoff_url" && !ctx.seen.has(normUrl(it.action.value)))
      it.action.value = it.source_url;
    if (budget) {
      const per = Number(it.attributes["price_per_person"]);
      const ok = withinBudget(it.price, Number.isFinite(per) && per > 0 ? per : null, budget);
      if (ok === false) {
        dropped.push(`${it.id}: over budget (${it.price.amount} ${it.price.currency})`);
        return false;
      }
    }
    return true;
  });
  // A "search on site" link card only when there are no real options of that kind.
  const realFlights = items.some((i) => i.kind === "flight" && i.id !== "f_search");
  if (realFlights) items = items.filter((i) => i.id !== "f_search");
  items = items.slice(0, opts.maxItems ?? CONFIG.defaultMaxCards);

  let status = r.status;
  const overBudget = dropped.some((d) => d.includes("over budget"));
  if (r.items.length && !items.length && (status === "ok" || status === "partial"))
    status = "no_results";
  else if (dropped.length && status === "ok" && !overBudget) status = "partial";
  let refinements = r.refinements;
  if (overBudget && !items.length) refinements = ["raise the budget", ...refinements];
  if (status === "no_results" && !refinements.length)
    refinements = ["different dates", "other options"];
  // Code-derived next steps (e.g. airport choice) go first; the model's suggestions follow.
  const suggestions = [...ctx.suggestions, ...r.suggestions].filter(
    (s, i, a) => a.findIndex((x) => x.label === s.label) === i,
  );
  return {
    result: { ...r, status, items, refinements, suggestions: suggestions.slice(0, 4) },
    dropped,
  };
}

/** Earlier results of this topic, compact, so "earlier flight" / "cheaper hotel" can refer to them. */
export function previousResultsView(r: ModuleResult | null): unknown {
  if (!r) return [];
  return r.items.slice(0, 8).map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    price: i.price.amount != null ? `${i.price.amount} ${i.price.currency}` : null,
    ...Object.fromEntries(
      [
        "departure_date",
        "departure_time",
        "arrival_time",
        "stops_label",
        "from_airport",
        "price_basis",
      ]
        .filter((k) => i.attributes[k] != null)
        .map((k) => [k, i.attributes[k]]),
    ),
  }));
}

/** When the model fails, still show what the tools found (code-built items only). */
function resultFromTools(ctx: ToolContext, maxItems: number): ModuleResult | null {
  const items = [...ctx.items.values()].filter((i) => i.id !== "f_search").slice(0, maxItems);
  if (!items.length) return null;
  return {
    status: "partial",
    summary: "Results from the data sources.",
    items,
    suggestions: [],
    need_input: null,
    refinements: [],
  };
}

export async function runModuleAgent(
  entry: RegistryEntry,
  task: string,
  slots: Record<string, string>,
  topicSummary: string,
  session: Session,
  previous: ModuleResult | null = null,
) {
  const started = Date.now();
  const maxCalls = entry.max_tool_calls ?? CONFIG.defaultMaxToolCalls;
  const maxItems = entry.max_cards ?? CONFIG.defaultMaxCards;
  const system = fill(MODULE_AGENT_PROMPT, {
    MODULE_DISPLAY_NAME: entry.display_name,
    MODULE_INSTRUCTIONS: entry.module_instructions.trim(),
    TASK: task,
    SLOTS: JSON.stringify(slots),
    TOPIC_SUMMARY: topicSummary || "(new topic)",
    PREVIOUS_RESULTS: JSON.stringify(previousResultsView(previous)),
    USER_PROFILE: JSON.stringify({
      language: session.user.language,
      citizenship: session.user.citizenship,
      home_city: session.user.home_city_confirmed ? session.user.home_city : "(unknown)",
    }),
    TODAY: todayISO(),
    RESULT_KINDS: entry.result_kinds.join(", "),
    MAX_TOOL_CALLS: String(maxCalls),
    MAX_ITEMS: String(maxItems),
  });
  const ctx = newToolContext();
  const tools = openAITools(entry);
  const ratesReady = slots["budget"] ? loadRates() : Promise.resolve();
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        "Run the task now. Make all independent tool calls in this first reply, in parallel. When done, reply with the ModuleResult JSON object only.",
    },
  ];
  let calls = 0,
    corrected = false;
  const raw: (string | null)[] = [];
  const finish = async (r: ModuleResult) => {
    await ratesReady;
    const g = groundResult(r, ctx, { budget: slots["budget"], maxItems });
    return { result: g.result, toolLog: ctx.log, dropped: g.dropped, raw };
  };

  for (let step = 0; step < maxCalls + 3; step++) {
    const outOfTime = Date.now() - started > CONFIG.moduleAgentBudgetMs;
    const msg = await llm("module_agent", messages, {
      tools,
      toolChoice: calls >= maxCalls || corrected || outOfTime ? "none" : "auto",
    });
    if (msg.tool_calls?.length) {
      messages.push(msg);
      // All tool calls of this step run at the same time.
      const outputs = await Promise.all(
        msg.tool_calls.map(async (tc) => {
          const tool = entry.tools.find((t) => t.name === tc.function.name);
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* bad args */
          }
          if (!tool) return { error: `unknown tool ${tc.function.name}` };
          if (calls >= maxCalls)
            return { error: "tool budget exhausted; answer with what you have" };
          calls++;
          const adapter = AGENT_ADAPTERS[tool.adapter];
          const t0 = Date.now();
          try {
            if (!adapter) throw new Error(`adapter ${tool.adapter} not found`);
            const out = await adapter((args ?? {}) as Record<string, unknown>, tool, ctx);
            ctx.log.push({ tool: tool.name, args, ok: true, ms: Date.now() - t0 });
            return out;
          } catch (e) {
            ctx.log.push({
              tool: tool.name,
              args,
              ok: false,
              note: (e as Error).message,
              ms: Date.now() - t0,
            });
            return { error: (e as Error).message };
          }
        }),
      );
      msg.tool_calls.forEach((tc, i) =>
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(outputs[i]).slice(0, MAX_TOOL_RESULT_CHARS),
        }),
      );
      continue;
    }
    raw.push(msg.content);
    let err = "";
    try {
      const parsed = ModuleResultSchema.safeParse(expandRefs(parseJSONObject(msg.content), ctx));
      if (parsed.success) {
        if (parsed.data.status === "need_input" && !parsed.data.need_input)
          err = "status need_input requires need_input {slot, ask, options}";
        else return finish(parsed.data);
      } else err = zodErrors(parsed.error);
    } catch (e) {
      err = (e as Error).message;
    }
    if (corrected) break; // retried once already -> fallback
    corrected = true;
    messages.push({ role: "assistant", content: msg.content ?? "" });
    messages.push({
      role: "user",
      content: `Your output failed validation: ${err}. Return the corrected ModuleResult JSON object only.`,
    });
  }
  const fromTools = resultFromTools(ctx, maxItems);
  if (fromTools) return finish(fromTools);
  return {
    result: errorResult("Module output invalid after retry"),
    toolLog: ctx.log,
    dropped: [] as string[],
    raw,
  };
}

export type { Item };
