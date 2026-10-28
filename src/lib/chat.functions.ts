import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CINEMAS, keywordRoute, toIata, lower, CITIES, type ChatResult, type CinemaData, type Route } from "./bir";

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
  shopping?: { query?: string; min_price?: number | null; max_price?: number | null };
};

type Lang = "az" | "en" | "ru";
const LANG_NAME: Record<Lang, string> = { az: "Azerbaijani", en: "English", ru: "Russian" };
// Azerbaijani is often typed without its letters ("isteyiremki", "baxmaq"), so score each word:
// known words, word beginnings and typical endings count for Azerbaijani; common words count for English.
const AZ_EXACT = new Set(["men", "mən", "sen", "sən", "biz", "nə", "ne", "var", "yox", "ki", "və", "ve", "bu", "o", "da", "də", "hə", "bəli", "beli", "sabah", "salam", "olar", "amma", "çox", "cox", "ucuz", "bilet", "kino", "hansi", "hansı"]);
const AZ_PREFIX = ["istəyir", "isteyir", "isdəyir", "isdeyir", "almaq", "alma", "baxma", "baxaq", "necə", "nece", "bugün", "bugun", "harada", "qiymət", "qiymet", "üçün", "ucun", "uçuş", "ucus", "hədiyyə", "hediyye", "zəhmət", "zehmet", "göstər", "goster", "məsləhət", "mesleh", "meshel", "lazım", "lazim", "getmək", "getmek", "gəlmək", "gelmek", "axtar", "tapmaq", "yaxşı", "yaxsi", "təşəkkür", "tesekkur", "sağol", "sagol", "filmlər", "filmler", "kinoteatr", "seans", "telefon", "qorxu", "uşaq", "usaq", "birdə", "birde"];
const AZ_SUFFIX = /(maq|mək|mek|lar|lər|ler|ları|ləri|leri|ıram|iram|irəm|irem|ıq|ük|uk|dır|dir|dur|dür|dan|dən|den)$/;
const EN_WORDS = new Set(["i", "the", "a", "an", "to", "is", "are", "want", "wanna", "need", "find", "show", "me", "my", "please", "yes", "no", "for", "from", "and", "what", "which", "how", "can", "you", "buy", "book", "flight", "movie", "movies", "cinema", "ticket", "tickets", "today", "tomorrow", "cheap", "with", "under", "in", "on", "of", "it", "this", "that", "do", "go", "fly", "hi", "hello", "thanks", "sure", "where", "when"]);
function langOf(text: string): Lang | null {
  if (/[а-яё]/i.test(text)) return "ru";
  let az = (text.match(/[əğışçöü]/gi) ?? []).length ? 2 : 0, en = 0;
  for (const w of lower(text).split(/[^\p{L}]+/u).filter(Boolean)) {
    if (CITIES[w]) continue; // "antalya", "bakıdan" are handled by the flight logic, not language
    if (EN_WORDS.has(w)) en++;
    else if (AZ_EXACT.has(w) || AZ_PREFIX.some((p) => w.startsWith(p)) || (w.length > 4 && AZ_SUFFIX.test(w))) az++;
  }
  if (!az && !en) return null; // numbers, codes or unclear words ("2000", "IST", "hmm")
  return az >= en ? "az" : "en";
}
/** Language of the latest message, or of the last user message that has words. */
function detectLang(message: string, history: z.infer<typeof msgSchema>[]): Lang {
  for (const t of [message, ...history.filter((m) => m.role === "user").map((m) => m.content).reverse()]) {
    const l = langOf(t);
    if (l) return l;
  }
  return "en";
}

const FALLBACK: Record<Lang, Record<"cinemaOn" | "cinemaPick" | "avia" | "shop" | "general", string>> = {
  en: {
    cinemaOn: "Here's what's on.", cinemaPick: "Pick a cinema to see today's sessions.", avia: "Let's find you a flight.",
    shop: "Here are some picks from Birmarket.", general: "I can help with CinemaPlus sessions, flights on AviaSales, or shopping on Birmarket. What do you need?",
  },
  az: {
    cinemaOn: "Budur, seanslar.", cinemaPick: "Bugünkü seansları görmək üçün kinoteatr seçin.", avia: "Gəlin sizə uçuş tapaq.",
    shop: "Birmarket-dən bir neçə təklif.", general: "CinemaPlus seansları, AviaSales-də uçuşlar və ya Birmarket-də alış-veriş üçün kömək edə bilərəm. Nə lazımdır?",
  },
  ru: {
    cinemaOn: "Вот что идёт.", cinemaPick: "Выберите кинотеатр, чтобы увидеть сеансы на сегодня.", avia: "Давайте найдём вам рейс.",
    shop: "Вот несколько вариантов с Birmarket.", general: "Я помогу с сеансами CinemaPlus, авиабилетами на AviaSales или покупками на Birmarket. Что вам нужно?",
  },
};

/** Sends a prompt to the company model and returns the first JSON object in its answer, or null. */
async function askModel<T>(prompt: string): Promise<T | null> {
  const key = process.env["COMPANY_AI_KEY"];
  if (!key) return null;
  const { createAzure } = await import("@ai-sdk/azure");
  const { generateText } = await import("ai");
  const provider = createAzure({ resourceName: "ai-ds-coe-resource", apiKey: key });
  const { text } = await generateText({ model: provider.chat(MODEL), prompt, maxOutputTokens: 2000, maxRetries: 1 });
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  return json ? (JSON.parse(json) as T) : null;
}

const PLAN_SHAPE = `{"route":"cinema"|"avia"|"shopping"|"general",
 "reply":"1-2 friendly sentences",
 "cinema":{"cinema_slugs":[],"movies":[],"day":"today"|"tomorrow"},
 "avia":{"origin":"IATA","destination":"IATA or empty","depart":"YYYY-MM-DD or empty","return":"YYYY-MM-DD or empty","adults":1},
 "shopping":{"query":"product search words","min_price":null,"max_price":null}}`;

async function aiPlan(message: string, history: z.infer<typeof msgSchema>[], active: Route | null, today: string, lang: Lang, movies: string): Promise<Plan | null> {
  try {
    const cinemaList = Object.entries(CINEMAS).map(([s, c]) => `${s} (${c.name}, ${c.city})`).join("; ");
    const prompt = `You are the router of "Bir Chat", which combines three services:
CinemaPlus (cinemas in Azerbaijan), AviaSales (flights, we redirect to aviasales.com before payment),
and a Shopping Assistant (products from Birmarket).
Today is ${today}. The active service is ${active ?? "none"}; keep it unless the user clearly asks for something else.
Cinemas (slug (name, city)): ${cinemaList}.
Films showing now (title [genres]): ${movies || "unknown"}.
Questions about which films to watch, film genres or recommendations go to "cinema": name fitting films from this list
in the reply and put them in cinema.movies.
Default departure airport: GYD (Baku). Use IATA codes.
Never invent showtimes, prices or products: the app fetches real data after you route.

Conversation:
${history.map((m) => `${m.role}: ${m.content}`).join("\n")}
user: ${message}

Reply with ONLY JSON:
{"route":"cinema"|"avia"|"shopping"|"general",
 "reply":"1-2 friendly sentences in ${LANG_NAME[lang]}",
 "cinema":{"cinema_slugs":[],"movies":[],"day":"today"|"tomorrow"},
 "avia":{"origin":"GYD","destination":"IATA or empty","depart":"YYYY-MM-DD or empty","return":"YYYY-MM-DD or empty","adults":1},
 "shopping":{"query":"product search words","min_price":null,"max_price":null}}
Birmarket product names are in Azerbaijani, so shopping.query must contain the Azerbaijani product words
(e.g. phone/smartphone -> "smartfon", ball -> "top", headphones -> "qulaqlıq", laptop -> "noutbuk", toy -> "oyuncaq")
plus any brand names. Use "telefon" only for landline phones. Put budgets in min_price/max_price (AZN numbers).
Include only the key for the chosen route.
The user is writing in ${LANG_NAME[lang]}: "reply" MUST be in ${LANG_NAME[lang]}, even though product search words are Azerbaijani.`;
    const plan = await askModel<Plan>(prompt);
    if (!plan || !["cinema", "avia", "shopping", "general"].includes(plan.route)) return null;
    return plan;
  } catch (e) {
    console.error("AI router failed, using keywords", e);
    return null;
  }
}

/** Short description of what the user is about to see, for the checker. */
function describe(r: ChatResult): string {
  if (r.route === "avia") {
    const d = r.data, cheapest = d.offers[0];
    return `Flight search ${d.origin || "(no origin)"} -> ${d.destination || "(no destination)"}, depart ${d.depart || "any"}, return ${d.return || "none"}, ${d.adults} passenger(s). ` +
      (cheapest ? `${d.offers.length} offers${d.nearby ? " for nearby dates" : ""}, cheapest $${cheapest.price_usd} per person on ${cheapest.departure_at.slice(0, 10)}.` : "No prices found.");
  }
  if (r.route === "shopping") {
    const d = r.data, list = (ps: typeof d.products) => ps.map((p) => `${p.name} (${p.price_azn} AZN)`).join("; ") || "none";
    return `Birmarket search "${d.query}". Products: ${list(d.products)}. Cheaper alternatives: ${list(d.alternatives ?? [])}.${d.error ? " Error: " + d.error : ""}`;
  }
  if (r.route === "cinema") {
    const d = r.data;
    if (d.kind === "list") return "List of all CinemaPlus cinemas (no cinema chosen).";
    return `Sessions at ${CINEMAS[d.slug]?.name} for ${d.day} (${d.date}): ${[...new Set(d.sessions.map((s) => s.movie))].join(", ") || "none"}.${d.error ? " Error: " + d.error : ""}`;
  }
  return "General answer with no data card.";
}

type Review = { ok: boolean; problem?: string; fix?: Plan };
/** Second pass: the model checks the finished answer against the request and returns a corrected plan if needed. */
async function aiReview(message: string, history: z.infer<typeof msgSchema>[], lang: Lang, today: string, plan: Plan, result: ChatResult): Promise<Review | null> {
  try {
    const prompt = `You check answers of "Bir Chat" (CinemaPlus cinemas in Azerbaijan, AviaSales flights, Birmarket shopping) before the user sees them.
Today is ${today}. Default departure airport is GYD (Baku) only when the user names no origin.

Conversation:
${history.map((m) => `${m.role}: ${m.content}`).join("\n")}
user: ${message}

Answer about to be shown:
reply: ${result.reply}
card: ${describe(result)}
plan used: ${JSON.stringify(plan)}

Check that the service is right and the card matches what the user asked: cities and direction (origin vs destination),
IATA codes, dates, passengers, price range, that products are the kind of item requested (not accessories or unrelated items),
cinema, movie and day. Questions about which films to watch or film genres belong to "cinema".
The reply must be in ${LANG_NAME[lang]} and must not contradict the card.
Birmarket product names are Azerbaijani, so shopping.query must use Azerbaijani product words (phone -> "smartfon").

Reply with ONLY JSON. If everything is right: {"ok":true}
Otherwise: {"ok":false,"problem":"short reason","fix":${PLAN_SHAPE}}
The fix is a complete corrected plan (include only the key for its route); its reply must be in ${LANG_NAME[lang]}.`;
    return await askModel<Review>(prompt);
  } catch (e) {
    console.error("AI review failed", e);
    return null;
  }
}

function fallbackPlan(message: string, active: Route | null, lang: Lang): Plan {
  const route = keywordRoute(message, active);
  const say = FALLBACK[lang];
  const t = message.toLowerCase();
  if (route === "cinema") {
    const slugs = Object.entries(CINEMAS).filter(([s, c]) => t.includes(c.name.toLowerCase()) || t.includes(s.replace(/-/g, " "))).map(([s]) => s);
    return { route, reply: slugs.length ? say.cinemaOn : say.cinemaPick, cinema: { cinema_slugs: slugs, day: /tomorrow|sabah|завтра/.test(t) ? "tomorrow" : "today" } };
  }
  if (route === "avia") {
    const found = Object.keys(CITIES).filter((c) => t.includes(c)).sort((a, b) => t.indexOf(a) - t.indexOf(b)).map((c) => CITIES[c]);
    const dest = found.find((c) => c !== "GYD") ?? "";
    return { route, reply: say.avia, avia: { origin: (found.length > 1 ? found[0] : undefined) ?? "GYD", destination: dest, adults: 1 } };
  }
  if (route === "shopping") {
    const range = t.match(/(\d+)\s*(?:azn|₼|manat)?\s*(?:-|–|to|dan|dən)\s*(\d+)\s*(?:azn|₼|manat)/);
    const max = t.match(/(\d+)\s*(?:azn|₼|manat)/);
    const query = message.replace(/\b(phones?|smartphones?|telefon(lar)?)\b/gi, "smartfon");
    return { route, reply: say.shop, shopping: { query, min_price: range ? Number(range[1]) : null, max_price: Number(range?.[2] ?? max?.[1]) || null } };
  }
  return { route: "general", reply: say.general };
}

export const chat = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => chatInput.parse(d))
  .handler(async ({ data }): Promise<ChatResult> => {
    const { bakuDate, getCinemaSessionsAll, movieInfoFor, getBirmarketProducts, searchProducts, searchFlights, warmUp, showingMovies } = await import("./scrapers.server");
    warmUp();
    const today = bakuDate(0).iso;
    const lang = detectLang(data.message, data.history);
    const movies = showingMovies().map((m) => (m.genres.length ? `${m.title} [${m.genres.join(", ")}]` : m.title)).join("; ");
    const plan = (await aiPlan(data.message, data.history, data.active, today, lang, movies)) ?? fallbackPlan(data.message, data.active, lang);
    const result = await execute(plan);

    // Let the model check the finished answer once; rebuild it from the corrected plan if it found a problem.
    const review = await aiReview(data.message, data.history, lang, today, plan, result);
    if (review && !review.ok && review.fix && ["cinema", "avia", "shopping", "general"].includes(review.fix.route)) {
      console.info("answer corrected:", review.problem);
      return execute({ ...review.fix, reply: review.fix.reply || plan.reply });
    }
    return result;

    async function execute(plan: Plan): Promise<ChatResult> {
      const reply = plan.reply || "";

      if (plan.route === "cinema") {
        const slug = (plan.cinema?.cinema_slugs ?? []).find((s) => CINEMAS[s]);
        const day = plan.cinema?.day === "tomorrow" ? "tomorrow" : "today";
        if (!slug) return { route: "cinema", reply, data: { kind: "list" } };
        return { route: "cinema", reply, data: await loadCinema(slug, day, plan.cinema?.movies ?? []) };
      }
      if (plan.route === "avia") {
        const a = plan.avia ?? {};
        // Cities named in this message win over the AI's guess (which can drift to earlier messages).
        const t = lower(data.message);
        const named = Object.keys(CITIES).filter((c) => new RegExp(`(^|[^\\p{L}])${c}`, "u").test(t))
          .sort((x, y) => t.indexOf(x) - t.indexOf(y)).map((c) => CITIES[c]!);
        if (named.length) {
          // "from Baku", "из Баку", "Bakıdan"
          const from = Object.keys(CITIES).find((c) => new RegExp(`(from|из)\\s+${c}|${c}n?(dan|dən|den)`, "u").test(t));
          if (from) a.origin = CITIES[from]!;
          const dest = named.find((c) => c !== toIata(a.origin || "GYD"));
          if (dest && !named.includes(toIata(a.destination || ""))) a.destination = dest;
        }
        // An origin we can't resolve stays empty (the checker or the form fixes it) instead of silently becoming Baku.
        const q = {
          origin: toIata(a.origin || "GYD"), destination: toIata(a.destination || ""),
          depart: /^\d{4}-\d{2}(-\d{2})?$/.test(a.depart || "") ? a.depart! : "",
          return: /^\d{4}-\d{2}-\d{2}$/.test(a.return || "") ? a.return! : "",
          adults: Math.max(1, Math.min(6, Number(a.adults) || 1)),
        };
        return { route: "avia", reply, data: await searchFlights(q) };
      }
      if (plan.route === "shopping") {
        const query = plan.shopping?.query || data.message;
        const all = getBirmarketProducts();
        if (!all) return { route: "shopping", reply, data: { query, products: [], error: "The Birmarket catalog is still loading. Please try again in a minute." } };
        const { min_price, max_price } = plan.shopping ?? {};
        const min = Number(min_price) || null, max = Number(max_price) || null;
        let found = searchProducts(all, query, min, max);
        // If the AI's search words miss, retry with the user's own words.
        if (!found.products.length && !found.alternatives.length) {
          const own = fallbackPlan(data.message, data.active, lang).shopping?.query ?? data.message;
          found = searchProducts(all, own, min, max);
        }
        return { route: "shopping", reply, data: { query, ...found } };
      }
      return { route: "general", reply, data: null };
    }

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
