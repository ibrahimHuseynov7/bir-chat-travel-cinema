// Prompt 1 - Orchestrator: routing decision only. Never talks to the user, never calls tools.
import { todayISO } from "../config";
import { fill, ORCHESTRATOR_PROMPT } from "../core/prompts";
import { getEntry, moduleCards, registry } from "../core/registry";
import { type Decision, DecisionSchema } from "../core/schemas";
import type { Session } from "../core/state";
import { runJSON } from "../core/validate";

export function compactState(s: Session) {
  return {
    user: s.user,
    active_topic_id: s.active_topic_id,
    topics: s.topics.map((t) => ({
      id: t.id,
      module: t.module,
      status: t.status,
      slots: t.slots,
      summary: t.summary,
      has_shown_results: !!t.last_result_ref,
    })),
    recent_turns: s.recent_turns,
    pending_intents: s.pending_intents,
  };
}

export async function runOrchestrator(session: Session, userTurn: unknown) {
  const system = fill(ORCHESTRATOR_PROMPT, { MODULE_CARDS: moduleCards(), TODAY: todayISO() });
  const input = { user_turn: userTurn, state: compactState(session), today: todayISO() };
  const ids = registry().map((e) => e.id);
  const { value, raw, calls } = await runJSON<Decision>(
    "orchestrator",
    [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(input) },
    ],
    DecisionSchema,
    (d) => {
      const hard: string[] = [];
      if (d.module && !getEntry(d.module))
        hard.push(`module must be one of ${ids.join(", ")} or null`);
      if ((d.decision === "route" || d.decision === "answer_from_context") && !d.module)
        hard.push(`decision ${d.decision} needs a module`);
      if (d.decision === "clarify" && !d.module && d.missing_slot?.name !== "module")
        hard.push("clarify without module must ask for slot 'module'");
      if (d.resume_topic_id && !session.topics.some((t) => t.id === d.resume_topic_id))
        hard.push(`resume_topic_id ${d.resume_topic_id} does not exist`);
      return { hard, soft: [] };
    },
  );
  return { decision: value, input, raw, calls };
}
