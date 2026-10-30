// Rule 6: validate each agent's JSON against its schema, retry once with the error, then fall back.
import type { AgentRole } from "../config";
import type { z } from "zod";
import { type ChatMessage, type LLMStats, llm, llmStats, parseJSONObject } from "./llm";
import { zodErrors } from "./schemas";

export class ValidationFailed extends Error {
  constructor(
    public role: AgentRole,
    public errors: string[],
    public raw: (string | null)[],
  ) {
    super(`${role} output invalid after retry: ${errors.join(" | ")}`);
  }
}
export interface Checked {
  hard: string[];
  soft: string[];
}

/**
 * Calls the model in JSON mode, validates, retries once with the errors.
 * `check` adds rule checks beyond the schema. Hard errors (schema, invented facts) trigger the one
 * retry and, if still present, ValidationFailed (caller uses the safe fallback). Soft errors are
 * cosmetic rule breaks that code fixes itself, so they never cost an extra LLM call.
 */
export async function runJSON<T>(
  role: AgentRole,
  messages: ChatMessage[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  check?: (v: T) => Checked,
): Promise<{ value: T; soft: string[]; raw: (string | null)[]; calls: LLMStats[] }> {
  const raw: (string | null)[] = [];
  const calls: LLMStats[] = [];
  let lastErrors: string[] = [];
  const convo = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await llm(role, convo, { json: true });
    raw.push(msg.content);
    const st = llmStats.get(msg);
    if (st) calls.push(st);
    let value: T | undefined;
    let hard: string[] = [],
      soft: string[] = [];
    try {
      const parsed = schema.safeParse(parseJSONObject(msg.content));
      if (parsed.success) {
        value = parsed.data;
        const c = check?.(value) ?? { hard: [], soft: [] };
        hard = c.hard;
        soft = c.soft;
      } else hard = [zodErrors(parsed.error)];
    } catch (e) {
      hard = [(e as Error).message];
    }
    if (value !== undefined && !hard.length) return { value, soft, raw, calls };
    lastErrors = hard;
    convo.push({ role: "assistant", content: msg.content ?? "" });
    convo.push({
      role: "user",
      content: `Your output failed validation: ${lastErrors.join("; ")}. Return the corrected JSON object only.`,
    });
  }
  throw new ValidationFailed(role, lastErrors, raw);
}
