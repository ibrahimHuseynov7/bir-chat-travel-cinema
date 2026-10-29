// MVP data tools: web_search + fetch_page. Every URL a tool returns is recorded in the
// run context, so code can later check that each item's source_url really came from a tool.
import { CONFIG } from "../config";
import type { Item } from "../core/schemas";

export type Seen = Map<string, "searched" | "fetched" | "link">;
export interface ToolContext {
  seen: Seen;
  log: { tool: string; args: unknown; ok: boolean; note?: string; ms?: number }[];
  /** Ready-made items built in code from tool data; the Module Agent picks them by {"ref": id}. */
  items: Map<string, Item>;
  /** Next-step chips derived from tool data in code (e.g. "Only MXP" when a city has several airports). */
  suggestions: { label: string; value: string }[];
}
export const newToolContext = (): ToolContext => ({
  seen: new Map(),
  log: [],
  items: new Map(),
  suggestions: [],
});
/** Registers code-built items so the agent can reference them, and marks their URLs as tool-returned. */
export function offerItems(ctx: ToolContext, items: Item[]) {
  for (const it of items) {
    ctx.items.set(it.id, it);
    if (it.source_url) mark(ctx, it.source_url, "fetched");
    if (it.action.type === "handoff_url" && it.action.value) mark(ctx, it.action.value, "fetched");
  }
}

const searchCache = new Map<string, { at: number; v: SearchResult[] }>();

export function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    let s = x.toString();
    if (s.endsWith("/") && x.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return u.trim();
  }
}
const rank = { link: 0, searched: 1, fetched: 2 } as const;
export function mark(ctx: ToolContext, url: string, how: "searched" | "fetched" | "link") {
  const k = normUrl(url),
    prev = ctx.seen.get(k);
  if (!prev || rank[how] > rank[prev]) ctx.seen.set(k, how);
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(
  query: string,
  siteFilter: string[] | undefined,
  ctx: ToolContext,
): Promise<SearchResult[]> {
  const sites = (siteFilter ?? []).filter(Boolean);
  const ck = `${CONFIG.search.provider()}|${query.toLowerCase()}|${sites.join(",")}`;
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.at < CONFIG.search.cacheMs) {
    hit.v.forEach((r) => mark(ctx, r.url, "searched"));
    return hit.v;
  }
  let results: SearchResult[];
  if (CONFIG.search.provider() === "brave") {
    const key = CONFIG.search.braveKey();
    if (!key) throw new Error("BRAVE_API_KEY is not set");
    const q = sites.length ? `${query} (${sites.map((s) => `site:${s}`).join(" OR ")})` : query;
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${CONFIG.search.maxResults}`,
      {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!res.ok) throw new Error(`Brave search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    // deno-lint-ignore no-explicit-any
    results = (data?.web?.results ?? []).map((r: Record<string, string | undefined>) => ({
      title: r["title"] ?? "",
      url: r["url"] ?? "",
      snippet: stripTags(r["description"] ?? ""),
    }));
  } else {
    const key = CONFIG.search.tavilyKey();
    if (!key) throw new Error("TAVILY_API_KEY is not set");
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        max_results: CONFIG.search.maxResults,
        search_depth: "basic",
        ...(sites.length ? { include_domains: sites } : {}),
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok)
      throw new Error(`Tavily search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    // deno-lint-ignore no-explicit-any
    results = (data?.results ?? []).map((r: Record<string, string | undefined>) => ({
      title: r["title"] ?? "",
      url: r["url"] ?? "",
      snippet: (r["content"] ?? "").slice(0, 700),
    }));
  }
  results = results.filter((r) => /^https?:\/\//.test(r.url));
  results.forEach((r) => mark(ctx, r.url, "searched"));
  searchCache.set(ck, { at: Date.now(), v: results });
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value!);
  return results;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^0\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function stripTags(s: string) {
  return decode(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  structured_data: string[];
  links: { text: string; url: string }[];
}

export async function fetchPage(rawUrl: string, ctx: ToolContext): Promise<FetchedPage> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname))
    throw new Error("URL not allowed");
  const res = await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LifestyleAssistant/1.0)",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      "Accept-Language": "az,en;q=0.8,ru;q=0.7",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(CONFIG.fetch.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const finalUrl = res.url || u.toString();
  const html = (await res.text()).slice(0, 2_000_000);
  const max = CONFIG.fetch.maxChars;

  // JSON-LD often holds exact prices / showtimes / offers - keep it.
  const structured = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ]
    .map((m) => (m[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 2500))
    .slice(0, 4);
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const links: { text: string; url: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2] ?? "").slice(0, 80);
    if (!text) continue;
    try {
      const abs = new URL(decode(m[1] ?? ""), finalUrl);
      if (!/^https?:$/.test(abs.protocol)) continue;
      links.push({ text, url: abs.toString() });
    } catch {
      /* ignore */
    }
    if (links.length >= 40) break;
  }
  const text = stripTags(
    html
      .replace(/<(script|style|noscript|svg|head|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, " \n "),
  ).slice(0, max);

  mark(ctx, rawUrl, "fetched");
  mark(ctx, finalUrl, "fetched");
  links.forEach((l) => mark(ctx, l.url, "link"));
  return { url: finalUrl, title, text, structured_data: structured, links };
}
