// Azure OpenAI client (Chat Completions, api-key header). Plain fetch so behaviour is explicit.
import { type AgentRole, CONFIG } from "../config";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[] | undefined;
  tool_call_id?: string;
}
export interface ChatOptions {
  json?: boolean;
  tools?: unknown[];
  toolChoice?: "auto" | "none";
}
export type LLMFn = (
  role: AgentRole,
  messages: ChatMessage[],
  opts?: ChatOptions,
) => Promise<ChatMessage>;

export class LLMError extends Error {}

/** Telemetry of one model call, for the in-app debugger. */
export interface LLMStats {
  role: AgentRole;
  ms: number;
  /** HTTP requests sent (>1 = parameter fallback or 429/5xx retry). */
  attempts: number;
  /** Time spent sleeping before 429/5xx retries. */
  wait_ms: number;
  effort: string | null;
  prompt_tokens: number | null;
  cached_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  tool_calls: number;
}
/** Stats per returned message (kept off the message itself, which is sent back to the model). */
export const llmStats = new WeakMap<ChatMessage, LLMStats>();
export const statsOf = (msgs: ChatMessage[]): LLMStats[] =>
  msgs.flatMap((m) => {
    const s = llmStats.get(m);
    return s ? [s] : [];
  });

// Parameters some deployments reject; dropped automatically (once per process) on a 400 that names them.
const OPTIONAL_PARAMS = [
  "temperature",
  "reasoning_effort",
  "response_format",
  "parallel_tool_calls",
  "max_completion_tokens",
];
const rejected: Record<string, Set<string>> = {};
/** Index into CONFIG.azure.reasoningEffort(role) of the first value the deployment accepted. */
const effortIdx: Record<string, number> = {};

const azureChat: LLMFn = async (role, messages, opts = {}) => {
  const key = CONFIG.azure.apiKey();
  if (!key) throw new LLMError("COMPANY_AI_KEY is not set");
  const body: Record<string, unknown> = {
    model: CONFIG.azure.deployment(role),
    messages,
    max_completion_tokens: CONFIG.azure.maxCompletionTokens[role],
  };
  const efforts = CONFIG.azure.reasoningEffort(role);
  const effort = () => efforts[effortIdx[role] ?? 0];
  if (effort()) body["reasoning_effort"] = effort();
  if (CONFIG.azure.temperature[role] != null) body["temperature"] = CONFIG.azure.temperature[role];
  if (opts.json) body["response_format"] = { type: "json_object" };
  if (opts.tools?.length) {
    body["tools"] = opts.tools;
    body["tool_choice"] = opts.toolChoice ?? "auto";
    body["parallel_tool_calls"] = true;
  }
  for (const p of rejected[role] ?? []) {
    if (p === "max_completion_tokens" && body[p] !== undefined) body["max_tokens"] = body[p];
    delete body[p];
  }
  const started = Date.now();
  let waited = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${CONFIG.azure.endpoint()}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.azure.timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        choices?: {
          finish_reason?: string;
          message?: { content?: string | null; tool_calls?: ToolCall[] };
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new LLMError("Empty response from model");
      if (choice?.finish_reason === "length" && !msg.content && !msg.tool_calls?.length) {
        throw new LLMError("Model hit the token limit before answering");
      }
      const out: ChatMessage = {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      };
      const u = data.usage;
      llmStats.set(out, {
        role,
        ms: Date.now() - started,
        attempts: attempt + 1,
        wait_ms: waited,
        effort: (body["reasoning_effort"] as string | undefined) ?? null,
        prompt_tokens: u?.prompt_tokens ?? null,
        cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? null,
        completion_tokens: u?.completion_tokens ?? null,
        reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
        tool_calls: msg.tool_calls?.length ?? 0,
      });
      return out;
    }
    const text = await res.text();
    if (res.status === 400) {
      // An unsupported reasoning_effort value: try the next (higher) value before dropping the parameter.
      if (body["reasoning_effort"] !== undefined && /reasoning[_.]effort/i.test(text)) {
        effortIdx[role] = (effortIdx[role] ?? 0) + 1;
        if (effort()) {
          console.warn(
            `LLM: reasoning_effort '${body["reasoning_effort"]}' rejected, trying '${effort()}'`,
          );
          body["reasoning_effort"] = effort();
          continue;
        }
      }
      const bad = OPTIONAL_PARAMS.find((p) => body[p] !== undefined && text.includes(p));
      if (bad) {
        if (bad === "max_completion_tokens") body["max_tokens"] = body["max_completion_tokens"];
        delete body[bad];
        (rejected[role] ??= new Set()).add(bad);
        console.warn(`LLM: deployment rejected '${bad}', retrying without it`);
        continue;
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      waited += 800 * (attempt + 1);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    throw new LLMError(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new LLMError("Azure OpenAI: too many retries");
};

export const _azureChat = azureChat; // exported for tests
let _llm: LLMFn = azureChat;
export const llm: LLMFn = (role, messages, opts) => _llm(role, messages, opts);
export function setLLM(fn: LLMFn) {
  _llm = fn;
}

/** Parse a JSON object out of model text (tolerates ```json fences). */
export function parseJSONObject(text: string | null): unknown {
  if (!text) throw new Error("empty output");
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const s = t.indexOf("{"),
    e = t.lastIndexOf("}");
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("output is not a JSON object");
}
