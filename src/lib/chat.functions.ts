import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CINEMAS, keywordRoute, toIata, CITIES, type ChatResult, type CinemaData, type Route } from "./bir";

const msgSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) });
const chatInput = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(msgSchema).max(8),
  active: z.enum(["cinema", "avia", "shopping", "general"]).nullable(),
});

const MODEL = "gpt-5.4-superchat";

type Plan = {
  route: Route; reply: string;
  cinema?: { cinema_slugs?: string[]; movies?: string[]; day?: "today" | "tomorrow" };
  avia?: { origin?: string; destination?: string; depart?: string; return?: string; adults?: number };
  shopping?: { query?: string; max_price?: number | null };
};

async function aiPlan(message: string, history: z.infer<typeof msgSchema>[], active: Route | null, today: string): Promise<Plan | null> {
  const key = process.env["COMPANY_AI_KEY"];
  if (!key) return null;
  try {
    const { createAzure } = await import("@ai-sdk/azure");
    const { generateText } = await import("ai");
    const provider = createAzure({ resourceName: "ai-ds-coe-resource", apiKey: key });
    const cinemaList = Object.entries(CINEMAS).map(([s, c]) => `${s} (${c.name}, ${c.city})`).join("; ");
    const prompt = `You are the router of "Bir Chat", which combines three services:
CinemaPlus (cinemas in Azerbaijan), AviaSales (flights, we redirect to aviasales.com before payment),
and a Shopping Assistant (products from Birmarket).
Today is ${today}. The active service is ${active ?? "none"}; keep it unless the user clearly asks for something else.
Cinemas (slug (name, city)): ${cinemaList}.
Default departure airport: GYD (Baku). Use IATA codes.
Never invent showtimes, prices or products: the app fetches real data after you route.

Conversation:
${history.map((m) => `${m.role}: ${m.content}`).join("\n")}
user: ${message}

Reply with ONLY JSON:
{"route":"cinema"|"avia"|"shopping"|"general",
 "reply":"1-2 friendly sentences in the user's language (Azerbaijani, English or Russian)",
 "cinema":{"cinema_slugs":[],"movies":[],"day":"today"|"tomorrow"},
 "avia":{"origin":"GYD","destination":"IATA or empty","depart":"YYYY-MM-DD or empty","return":"YYYY-MM-DD or empty","adults":1},
 "shopping":{"query":"search words in Azerbaijani or English product terms","max_price":null}}
Include only the key for the chosen route.`;
    const { text } = await generateText({ model: provider.chat(MODEL), prompt, maxOutputTokens: 2000, maxRetries: 1 });
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const plan = JSON.parse(json) as Plan;
    if (!["cinema", "avia", "shopping", "general"].includes(plan.route)) return null;
    return plan;
  } catch (e) {
    console.error("AI router failed, using keywords", e);
    return null;
  }
}

function fallbackPlan(message: string, active: Route | null): Plan {
  const route = keywordRoute(message, active);
  const t = message.toLowerCase();
  if (route === "cinema") {
    const slugs = Object.entries(CINEMAS).filter(([s, c]) => t.includes(c.name.toLowerCase()) || t.includes(s.replace(/-/g, " "))).map(([s]) => s);
    return { route, reply: slugs.length ? "Here's what's on." : "Pick a cinema to see today's sessions.", cinema: { cinema_slugs: slugs, day: /tomorrow|sabah|завтра/.test(t) ? "tomorrow" : "today" } };
  }
  if (route === "avia") {
    const found = Object.keys(CITIES).filter((c) => t.includes(c)).sort((a, b) => t.indexOf(a) - t.indexOf(b)).map((c) => CITIES[c]);
    const dest = found.find((c) => c !== "GYD") ?? "";
    return { route, reply: "Let's find you a flight.", avia: { origin: (found.length > 1 ? found[0] : undefined) ?? "GYD", destination: dest, adults: 1 } };
  }
  if (route === "shopping") return { route, reply: "Here are some picks from Birmarket.", shopping: { query: message, max_price: Number(t.match(/(\d+)\s*(azn|₼|manat)/)?.[1]) || null } };
  return { route: "general", reply: "I can help with CinemaPlus sessions, flights on AviaSales, or shopping on Birmarket. What do you need?" };
}

export const chat = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => chatInput.parse(d))
  .handler(async ({ data }): Promise<ChatResult> => {
    const { bakuDate, getCinemaSessionsAll, movieInfoFor, getBirmarketProducts, searchProducts, searchFlights } = await import("./scrapers.server");
    const today = bakuDate(0).iso;
    const plan = (await aiPlan(data.message, data.history, data.active, today)) ?? fallbackPlan(data.message, data.active);
    const reply = plan.reply || "";

    if (plan.route === "cinema") {
      const slug = (plan.cinema?.cinema_slugs ?? []).find((s) => CINEMAS[s]);
      const day = plan.cinema?.day === "tomorrow" ? "tomorrow" : "today";
      if (!slug) return { route: "cinema", reply, data: { kind: "list" } };
      return { route: "cinema", reply, data: await loadCinema(slug, day, plan.cinema?.movies ?? []) };
    }
    if (plan.route === "avia") {
      const a = plan.avia ?? {};
      const q = {
        origin: toIata(a.origin || "GYD") || "GYD", destination: toIata(a.destination || ""),
        depart: /^\d{4}-\d{2}(-\d{2})?$/.test(a.depart || "") ? a.depart! : "",
        return: /^\d{4}-\d{2}-\d{2}$/.test(a.return || "") ? a.return! : "",
        adults: Math.max(1, Math.min(6, Number(a.adults) || 1)),
      };
      return { route: "avia", reply, data: await searchFlights(q) };
    }
    if (plan.route === "shopping") {
      const query = plan.shopping?.query || data.message;
      try {
        return { route: "shopping", reply, data: { query, products: searchProducts(await getBirmarketProducts(), query, plan.shopping?.max_price ?? null) } };
      } catch (e) {
        console.error("birmarket", e);
        return { route: "shopping", reply, data: { query, products: [], error: "Birmarket is unavailable right now." } };
      }
    }
    return { route: "general", reply, data: null };

    async function loadCinema(s: string, d: "today" | "tomorrow", movies: string[]): Promise<CinemaData> {
      const date = bakuDate(d === "tomorrow" ? 1 : 0).iso;
      try {
        let sessions = (await getCinemaSessionsAll(s)).filter((x) => x.date === date);
        const wanted = movies.map((m) => m.toLowerCase()).filter(Boolean);
        const filtered = wanted.length ? sessions.filter((x) => wanted.some((w) => x.movie.toLowerCase().includes(w))) : [];
        if (filtered.length) sessions = filtered;
        return { kind: "sessions", slug: s, day: d, date, sessions, info: movieInfoFor([...new Set(sessions.map((x) => x.movie))]) };
      } catch (e) {
        console.error("cinema", e);
        return { kind: "sessions", slug: s, day: d, date, sessions: [], info: {}, error: "CinemaPlus is unavailable right now." };
      }
    }
  });

export const cinemaDay = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ slug: z.string().max(40), day: z.enum(["today", "tomorrow"]) }).parse(d))
  .handler(async ({ data }): Promise<CinemaData> => {
    const { bakuDate, getCinemaSessionsAll, movieInfoFor } = await import("./scrapers.server");
    const date = bakuDate(data.day === "tomorrow" ? 1 : 0).iso;
    if (!CINEMAS[data.slug]) return { kind: "list" };
    try {
      const sessions = (await getCinemaSessionsAll(data.slug)).filter((x) => x.date === date);
      return { kind: "sessions", slug: data.slug, day: data.day, date, sessions, info: movieInfoFor([...new Set(sessions.map((x) => x.movie))]) };
    } catch {
      return { kind: "sessions", slug: data.slug, day: data.day, date, sessions: [], info: {}, error: "CinemaPlus is unavailable right now." };
    }
  });

export const flights = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({
    origin: z.string().max(40), destination: z.string().max(40),
    depart: z.string().max(10), return: z.string().max(10), adults: z.number().int().min(1).max(6),
  }).parse(d))
  .handler(async ({ data }) => {
    const { searchFlights } = await import("./scrapers.server");
    return searchFlights({ ...data, origin: toIata(data.origin) || "GYD", destination: toIata(data.destination) });
  });
