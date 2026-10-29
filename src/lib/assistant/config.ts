// Server-only configuration. Secrets come from Lovable Cloud secrets (process.env), never from the browser.
const env = (k: string, d = ""): string =>
  (typeof process !== "undefined" ? process.env[k] : undefined) ?? d;

export type AgentRole = "orchestrator" | "module_agent" | "responder";

/**
 * Reasoning effort per role, most-preferred first. GPT-5.x deployments differ in what they accept
 * ("none" on 5.1+, "minimal" on 5.0); llm.ts walks down the list when the deployment rejects a value,
 * remembers the first accepted one, and drops the parameter only if none is accepted.
 * Lower effort = much faster answers; routing and reply writing do not need deep reasoning.
 * Override with AZURE_REASONING_<ROLE>=low (comma-separated list allowed).
 */
const effortChain = (role: AgentRole, d: string[]): string[] => {
  const v = env(`AZURE_REASONING_${role.toUpperCase()}`);
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : d;
};

export const CONFIG = {
  azure: {
    // The same resource the app already used successfully (createAzure resourceName "ai-ds-coe-resource").
    endpoint: () =>
      env("AZURE_OPENAI_ENDPOINT", "https://ai-ds-coe-resource.openai.azure.com").replace(
        /\/+$/,
        "",
      ),
    apiKey: () => env("COMPANY_AI_KEY") || env("AZURE_OPENAI_API_KEY"),
    deployment: (role: AgentRole) =>
      env(`AZURE_DEPLOYMENT_${role.toUpperCase()}`) ||
      env("AZURE_OPENAI_DEPLOYMENT", "gpt-5.4-superchat"),
    reasoningEffort: (role: AgentRole): string[] =>
      ({
        orchestrator: effortChain("orchestrator", ["none", "minimal", "low"]),
        module_agent: effortChain("module_agent", ["low", "minimal"]),
        responder: effortChain("responder", ["none", "minimal", "low"]),
      })[role],
    // Doc: Orchestrator at temperature 0. Dropped automatically if the deployment rejects it.
    temperature: { orchestrator: 0, module_agent: null, responder: null } as Record<
      AgentRole,
      number | null
    >,
    maxCompletionTokens: { orchestrator: 2500, module_agent: 5000, responder: 2000 } as Record<
      AgentRole,
      number
    >,
    timeoutMs: 45_000,
  },
  search: {
    provider: () => env("SEARCH_PROVIDER", "tavily") as "tavily" | "brave",
    tavilyKey: () => env("TAVILY_API_KEY"),
    braveKey: () => env("BRAVE_API_KEY"),
    maxResults: 6,
    cacheMs: 30 * 60_000,
  },
  fetch: { maxChars: 7000, timeoutMs: 8_000 },
  flights: {
    currency: "usd",
    maxOptions: 7,
    cacheMs: 10 * 60_000,
  },
  /** Live Birmarket listing lookups (tag / brand pages) on top of the background catalog snapshot. */
  birmarketLive: () => env("BIRMARKET_LIVE_LOOKUP", "true") !== "false",
  stateSecret: () => env("STATE_SECRET") || env("COMPANY_AI_KEY") || env("AZURE_OPENAI_API_KEY"),
  timezone: "Asia/Baku",
  recentTurns: 6,
  defaultMaxToolCalls: 4,
  defaultMaxCards: 5,
  /** Hard stop for the Module Agent loop: after this, answer with what the tools returned so far. */
  moduleAgentBudgetMs: 40_000,
  debug: () => env("ASSISTANT_DEBUG") === "true",
};

export function todayISO(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.timezone }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}
