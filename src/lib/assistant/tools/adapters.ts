// Tool adapters: registry `adapter` name -> code. Every adapter maps its source to plain JSON for the
// Module Agent (or, for executor: direct, to a ModuleResult) and records the URLs its data came from,
// so code can check every item's source_url (rule 4).
import type { ToolConfig } from "../core/registry";
import type { Item, ModuleResult } from "../core/schemas";
import type { Session } from "../core/state";
import { CONFIG, todayISO } from "../config";
import {
  CINEMAS,
  birmarketSearchUrl,
  cinemaPageUrl,
  moviePageUrl,
  type Product,
  type Session as CinemaSession,
} from "@/lib/bir";
import type {
  CatalogProduct,
  CatalogSearchParams,
  CatalogSort,
} from "@/lib/birmarket-catalog.server";
import { searchFlightOptions } from "./flights";
import { convert, loadRates } from "./money";
import { fetchPage, mark, offerItems, type ToolContext, webSearch } from "./web";

type Args = Record<string, unknown>;
export type AgentAdapter = (args: Args, tool: ToolConfig, ctx: ToolContext) => Promise<unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** "HH:MM" in Baku now, to skip sessions that already started today. */
function bakuNowHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Baku",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export const AGENT_ADAPTERS: Record<string, AgentAdapter> = {
  websearch_v1: async (args, tool, ctx) => {
    const query = str(args["query"]);
    if (!query) throw new Error("query is required");
    const given = Array.isArray(args["site_filter"])
      ? (args["site_filter"] as unknown[]).map(String)
      : [];
    return {
      results: await webSearch(query, given.length ? given : tool.default_site_filter, ctx),
    };
  },

  fetch_v1: async (args, _tool, ctx) => {
    const url = str(args["url"]);
    if (!url) throw new Error("url is required");
    return await fetchPage(url, ctx);
  },

  // Flights: Aviasales cached prices (Travelpayouts API). Items (departure + arrival times, stops, duration,
  // price, booking link) are built in code; the agent gets a short list and picks items by ref.
  aviasales_v1: async (args, _tool, ctx) => {
    const origin = str(args["origin"]);
    if (!origin)
      return {
        error:
          "origin is empty: do not guess it. Return status need_input for slot 'origin' (ask for the departure city and airport).",
      };
    let maxPrice: number | null = Number(args["max_price"]) > 0 ? Number(args["max_price"]) : null;
    const cur = str(args["max_price_currency"]).toUpperCase() || "USD";
    if (maxPrice != null && cur !== "USD") {
      await loadRates();
      maxPrice = convert(maxPrice, cur, "USD");
    }
    const r = await searchFlightOptions({
      origin,
      destination: str(args["destination"]),
      depart: str(args["depart"]),
      return: str(args["return"]),
      adults: Number(args["adults"]) || 1,
      direct_only: args["direct_only"] === true,
      depart_after: str(args["depart_after"]) || undefined,
      depart_before: str(args["depart_before"]) || undefined,
      max_price: maxPrice,
    });
    offerItems(ctx, r.items);
    mark(ctx, r.search_url, "fetched");
    // Always offer a plain "search on Aviasales" card (used when there are no cached prices).
    const linkItem: Item = {
      id: "f_search",
      kind: "flight",
      title: "Search on Aviasales",
      subtitle: [r.origin?.code, r.destination?.code].filter(Boolean).join(" → "),
      attributes: {},
      price: { amount: null, currency: null },
      source_url: r.search_url,
      verify: false,
      action: { label: "Open Aviasales", type: "handoff_url", value: r.search_url },
    };
    offerItems(ctx, [linkItem]);
    // Next-step chips computed from the data (code, not the model).
    if (r.origin_airports.length > 1)
      for (const a of r.origin_airports.slice(0, 3))
        ctx.suggestions.push({ label: `From ${a.code}`, value: `fly from ${a.name} (${a.code})` });
    const stops = new Set(r.items.map((i) => i.attributes["stops"] === 0));
    if (stops.size > 1)
      ctx.suggestions.push({ label: "Direct only", value: "direct flights only" });
    return {
      origin: r.origin ? { code: r.origin.code, name: r.origin.name, type: r.origin.type } : null,
      destination: r.destination ? { code: r.destination.code, name: r.destination.name } : null,
      options: r.options,
      search_link_ref: "f_search",
      ...(r.nearby_dates
        ? {
            note: "No cached prices for the exact date; these are the cheapest dates in the same month.",
          }
        : {}),
      ...(r.split_legs
        ? {
            legs_note:
              "No cached round-trip price for these exact dates, so outbound and return are separate one-way options (leg = Outbound / Return). Return refs of BOTH legs.",
          }
        : {}),
      ...(r.filtered_out ? { filtered_out_by_your_filters: r.filtered_out } : {}),
      ...(r.origin_airports.length > 1 ? { origin_city_airports: r.origin_airports } : {}),
      ...(r.error ? { error: r.error } : {}),
      price_note: "price_per_person in USD, cached 'from' prices; booking happens on aviasales.com",
    };
  },

  // Cinema: real sessions from the CineMastercard (CinemaPlus) cinema pages. Movie items are built in code.
  cinemaplus_v1: async (args, _tool, ctx) => {
    const { getCinemaSessionsAll, movieInfoFor } = await import("@/lib/scrapers.server");
    const today = todayISO(),
      tomorrow = todayISO(1);
    const date = str(args["date"]) || today;
    if (date !== today && date !== tomorrow) {
      return {
        error: `Only today (${today}) and tomorrow (${tomorrow}) are published on the cinema site.`,
        date,
      };
    }
    const slugs = cinemaSlugs(args);
    const movieQ = str(args["movie"]).toLowerCase();
    const langQ = str(args["language"]).toLowerCase().slice(0, 2);
    const nowHHMM = bakuNowHHMM();
    // "19.00", "19", "7:30" -> "19:00" / "07:30"; empty when not given.
    const hhmm = (v: unknown) => {
      const m = str(v).match(/(\d{1,2})(?:[:.](\d{2}))?/);
      return m && Number(m[1]) < 24 ? `${m[1]!.padStart(2, "0")}:${m[2] ?? "00"}` : "";
    };
    const afterQ = hhmm(args["time_after"]);
    const beforeQ = hhmm(args["time_before"]);
    const failed: string[] = [];
    const perCinema = await mapLimit(slugs, 4, async (slug) => {
      try {
        const all = await getCinemaSessionsAll(slug);
        mark(ctx, cinemaPageUrl(slug), "fetched");
        return all.filter((s) => s.date === date).map((s) => ({ ...s, slug }));
      } catch (e) {
        failed.push(`${CINEMAS[slug]?.name ?? slug}: ${(e as Error).message}`);
        return [] as (CinemaSession & { slug: string })[];
      }
    });
    const sessions = perCinema
      .flat()
      .filter((s) => !movieQ || s.movie.toLowerCase().includes(movieQ))
      .filter((s) => !langQ || (s.language ?? "").toLowerCase().startsWith(langQ))
      .filter((s) => date !== today || s.time >= nowHHMM)
      .filter((s) => !afterQ || s.time >= afterQ)
      .filter((s) => !beforeQ || s.time <= beforeQ);
    const byMovie = new Map<string, (CinemaSession & { slug: string })[]>();
    for (const s of sessions) byMovie.set(s.movie, [...(byMovie.get(s.movie) ?? []), s]);
    const info = movieInfoFor([...byMovie.keys()]);
    const items: Item[] = [...byMovie.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 15)
      .map(([title, list]) => {
        const sorted = [...list].sort((a, b) => a.time.localeCompare(b.time));
        const movieUrl = moviePageUrl(sorted[0]!, sorted[0]!.slug);
        const i = info[title];
        const prices = sorted.map((s) => s.price_azn).filter((p): p is number => p != null);
        const cinemasShown = [...new Set(sorted.map((s) => CINEMAS[s.slug]?.name ?? s.slug))];
        return {
          id:
            "m_" +
            title
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]+/gu, "-")
              .slice(0, 40),
          kind: "movie",
          title,
          subtitle: [
            i?.genres.slice(0, 2).join(", "),
            i?.runtime_min ? `${i.runtime_min} min` : "",
            i?.age_rating ?? "",
          ]
            .filter(Boolean)
            .join(" · "),
          attributes: {
            genres: i?.genres ?? [],
            cinemas: cinemasShown,
            showtimes: sorted.slice(0, 8).map((s) => ({
              time: s.time,
              cinema: CINEMAS[s.slug]?.name ?? s.slug,
              hall: s.hall,
              format: s.format,
              language: s.language,
              az_subtitles: s.az_subtitles,
              price_azn: s.price_azn,
            })),
            session_count: list.length,
            ...(i?.overview ? { overview: i.overview } : {}),
          },
          price: prices.length
            ? { amount: Math.min(...prices), currency: "AZN" }
            : { amount: null, currency: null },
          source_url: cinemaPageUrl(sorted[0]!.slug),
          verify: false,
          action: { label: "Buy tickets", type: "handoff_url" as const, value: movieUrl },
        };
      });
    offerItems(ctx, items);
    return {
      date,
      cinemas_checked: slugs.map((s) => CINEMAS[s]?.name ?? s),
      ...(failed.length ? { unavailable: failed } : {}),
      movies: items.map((it) => ({
        ref: it.id,
        title: it.title,
        genres: it.attributes["genres"],
        cinemas: it.attributes["cinemas"],
        first_times: (it.attributes["showtimes"] as { time: string }[])
          .slice(0, 4)
          .map((s) => s.time),
        sessions: it.attributes["session_count"],
        from_price_azn: it.price.amount,
      })),
      ...(items.length ? {} : { note: "No sessions found for these filters." }),
    };
  },

  // Cinema list ("which malls / cinemas are there?"): one item per cinema, tap = pick that cinema.
  cinemaplus_list_v1: async (args, _tool, ctx) => {
    const { cachedCinemaSessions } = await import("@/lib/scrapers.server");
    const city = str(args["city"]).toLowerCase();
    const today = todayISO();
    const items: Item[] = Object.entries(CINEMAS)
      .filter(
        ([, c]) =>
          !city || c.city.toLowerCase() === city || (city.startsWith("bak") && c.city === "Baku"),
      )
      .map(([slug, c]) => {
        const todays = (cachedCinemaSessions(slug) ?? []).filter((s) => s.date === today);
        const films = new Set(todays.map((s) => s.movie)).size;
        return {
          id: `c_${slug}`,
          kind: "cinema",
          title: c.name,
          subtitle: [c.city, films ? `${films} films today` : ""].filter(Boolean).join(" · "),
          attributes: {
            city: c.city,
            ...(films ? { films_today: films, sessions_today: todays.length } : {}),
          },
          price: { amount: null, currency: null },
          source_url: cinemaPageUrl(slug),
          verify: false,
          action: { label: "See sessions", type: "select" as const, value: c.name },
        };
      })
      .sort(
        (a, b) =>
          Number(b.attributes["sessions_today"] ?? 0) - Number(a.attributes["sessions_today"] ?? 0),
      );
    offerItems(ctx, items);
    return {
      cinemas: items.map((i) => ({
        ref: i.id,
        name: i.title,
        city: i.attributes["city"],
        films_today: i.attributes["films_today"] ?? null,
      })),
    };
  },
};

/** Cinema slugs from the tool args (names or slugs), else every cinema in the city. */
function cinemaSlugs(args: Args): string[] {
  const asked = (Array.isArray(args["cinemas"]) ? (args["cinemas"] as unknown[]).map(String) : [])
    .map((c) => c.toLowerCase().trim())
    .map((c) =>
      CINEMAS[c]
        ? c
        : (Object.keys(CINEMAS).find(
            (s) =>
              CINEMAS[s]!.name.toLowerCase() === c ||
              c.includes(CINEMAS[s]!.name.toLowerCase()) ||
              CINEMAS[s]!.name.toLowerCase().includes(c),
          ) ?? ""),
    )
    .filter(Boolean);
  if (asked.length) return [...new Set(asked)];
  const city = str(args["city"]).toLowerCase() || "baku";
  return Object.keys(CINEMAS).filter(
    (s) =>
      CINEMAS[s]!.city.toLowerCase() === city ||
      (city.startsWith("bak") && CINEMAS[s]!.city === "Baku"),
  );
}

/** Adapters for executor: direct modules - called once, must return a ModuleResult. */
export type DirectAdapter = (input: {
  query: string;
  slots: Record<string, string>;
  session: Session;
  language: string;
}) => Promise<ModuleResult>;

const num = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return v && Number.isFinite(n) && n > 0 ? n : null;
};

const CATALOG_SORTS: [RegExp, CatalogSort][] = [
  [/cheap|price_asc|ucuz|дешев/i, "price_asc"],
  [/expensive|price_desc|baha|дорог/i, "price_desc"],
  [/rat|reyting|рейтинг/i, "rating"],
  [/popular|bestsell|populyar|популяр/i, "popularity"],
];
const BESTSELLER_RX =
  /^(ən çox satılan|en cox satilan|bestseller|populyar|хиты? продаж|популярн\S*)( məhsul\S*| товар\S*)?$/i;

const catalogItem = (p: CatalogProduct): Item => ({
  id: `p${p.id}`,
  kind: "product",
  title: p.title,
  subtitle: p.originalPrice ? `was ${p.originalPrice} AZN` : "",
  attributes: {
    ...(p.imageUrl ? { image: p.imageUrl } : {}),
    ...(p.rating != null ? { rating: p.rating, reviews: p.reviewCount ?? 0 } : {}),
    ...(p.originalPrice ? { old_price_azn: p.originalPrice } : {}),
  },
  price: { amount: p.price || null, currency: p.price ? "AZN" : null },
  source_url: p.url,
  verify: false,
  action: { label: "View on Birmarket", type: "handoff_url", value: p.url },
});

/**
 * Shopping on the Birmarket catalog API (the Birmarket shopping assistant's search logic): category anchoring,
 * brand / sort / discount filters, out-of-budget alternatives and /suggests recovery. Throws when the API is
 * unavailable so the caller can fall back to the listing pages.
 */
async function birmarketCatalogResult(
  query: string,
  slots: Record<string, string>,
  linkItem: (title: string) => Item,
): Promise<ModuleResult> {
  const cat = await import("@/lib/birmarket-catalog.server");
  const inStock = (ps: CatalogProduct[]) => ps.filter((p) => p.availability !== "out_of_stock");
  if (BESTSELLER_RX.test(query.trim())) {
    const best = inStock(await cat.getBestsellers(6));
    if (best.length)
      return {
        status: "ok",
        summary: "Birmarket bestsellers right now (all categories).",
        items: best.map(catalogItem),
        suggestions: [],
        need_input: null,
        refinements: [],
      };
  }
  const min = num(slots["budget_min"]),
    max = num(slots["budget_max"]);
  const brand = (slots["brand"] ?? "").trim() || undefined;
  const sort = CATALOG_SORTS.find(([rx]) => rx.test(slots["sort"] ?? ""))?.[1];
  const withDiscount = /^(true|yes|1)$/i.test((slots["discount_only"] ?? "").trim());
  const inferred = cat.inferCategory(query);
  const base: CatalogSearchParams = {
    query: inferred?.query ?? query,
    ...(inferred ? { categoryId: inferred.categoryId, fullQuery: query } : {}),
    brand,
    sort,
    withDiscount,
  };
  const range = `${min ? ` from ${min} AZN` : ""}${max ? ` up to ${max} AZN` : ""}`;
  const r = await cat.searchCatalog({ ...base, priceMin: min, priceMax: max });
  const found = inStock(r.products);
  if (found.length) {
    return {
      status: "ok",
      summary:
        `${found.length} Birmarket products for "${query}"${range}${withDiscount ? ", discounted only" : ""}.` +
        (r.brandDropped
          ? ` Nothing from ${r.brandDropped} matched, so other brands are shown.`
          : ""),
      items: found.slice(0, 6).map(catalogItem),
      suggestions: cat.refinementChips(found, {
        brand: r.brandDropped ? undefined : brand,
        priceMin: min,
        priceMax: max,
        sort,
        query,
      }),
      need_input: null,
      refinements: [],
    };
  }
  // Nothing within the budget: show the closest products outside it instead of a dead end.
  if (min || max) {
    const wide = inStock((await cat.searchCatalog(base)).products).sort((a, b) =>
      max ? a.price - b.price : b.price - a.price,
    );
    if (wide.length)
      return {
        status: "partial",
        summary: `Nothing for "${query}"${range}; these are the closest prices.`,
        items: wide.slice(0, 6).map(catalogItem),
        suggestions: [],
        need_input: null,
        refinements: ["other brands"],
      };
  }
  // Nothing at all: spelling corrections, categories and brands from /suggests.
  const s = await cat.getSuggestions(query);
  return {
    status: "no_results",
    summary: `No Birmarket products found for "${query}".`,
    items: [linkItem("Search on Birmarket")],
    suggestions: [
      ...s.predictedQueries.slice(0, 3).map((w) => ({ label: w, value: w })),
      ...s.categories.slice(0, 2).map((c) => ({ label: c.name, value: c.name })),
      ...s.brands.slice(0, 2).map((b) => ({ label: b, value: `only ${b}` })),
    ].slice(0, 4),
    need_input: null,
    refinements: ["different words", "other brands"],
  };
}

export const DIRECT_ADAPTERS: Record<string, DirectAdapter> = {
  // Shopping: live Birmarket listing pages for the query (tags / brand) + the background catalog snapshot.
  // Used until the shopping assistant endpoint exists.
  birmarket_v1: async ({ query, slots }) => {
    const {
      getBirmarketProducts,
      searchProducts,
      warmUp,
      birmarketLiveSearch,
      birmarketGiftIdeas,
      GIFT_RX,
      isGiftRecipient,
    } = await import("@/lib/scrapers.server");
    warmUp();
    // Gift without a product ("something for my mom's birthday"): best-rated products from categories that suit
    // the person, read live. A named product ("perfume for mom") keeps the normal search below.
    const forWhom = slots["gift_for"] ?? "";
    // Words left after removing gift / person / filler words: none -> nothing concrete was asked for.
    const FILLER = new Set([
      // en
      "gift",
      "gifts",
      "present",
      "idea",
      "ideas",
      "for",
      "my",
      "me",
      "i",
      "im",
      "wanna",
      "want",
      "would",
      "like",
      "to",
      "buy",
      "get",
      "need",
      "some",
      "smth",
      "sth",
      "something",
      "anything",
      "a",
      "an",
      "the",
      "birthday",
      "please",
      "what",
      "should",
      "can",
      "you",
      "suggest",
      "her",
      "him",
      "mom",
      "mother",
      "mum",
      "dad",
      "father",
      "wife",
      "husband",
      "sister",
      "brother",
      "friend",
      "s",
      // az
      "üçün",
      "ucun",
      "ana",
      "anam",
      "anama",
      "anamın",
      "ata",
      "atam",
      "atama",
      "ad",
      "günü",
      "gunu",
      "bir",
      "şey",
      "sey",
      "nəsə",
      "nese",
      "hədiyyə",
      "hediyye",
      "almaq",
      "istəyirəm",
      "isteyirem",
      "mənə",
      "mene",
      "lazımdır",
      "lazimdir",
      // ru
      "подарок",
      "для",
      "мамы",
      "маме",
      "мама",
      "папы",
      "папе",
      "хочу",
      "купить",
      "что",
      "то",
      "нибудь",
    ]);
    const productWords = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !FILLER.has(w) && !GIFT_RX.test(w))
      .join(" ");
    if ((forWhom || GIFT_RX.test(query) || isGiftRecipient(query)) && productWords.length < 3) {
      const maxGift = num(slots["budget_max"]);
      const minGift = num(slots["budget_min"]);
      const gift = await birmarketGiftIdeas(forWhom || query, maxGift, 6, minGift);
      if (gift.products.length) {
        return {
          status: "ok",
          summary: `Gift ideas from Birmarket${forWhom ? ` for ${forWhom}` : ""}: best-rated in ${gift.categories.map((c) => c.label).join(", ")}${minGift ? `, from ${minGift} AZN` : ""}${maxGift ? `, up to ${maxGift} AZN` : ""}.`,
          items: gift.products.map((p) => ({
            id: `p${p.id}`,
            kind: "product",
            title: p.name,
            subtitle: p.old_price ? `was ${p.old_price} AZN` : "",
            attributes: {
              ...(p.image_url ? { image: p.image_url } : {}),
              ...(p.rating != null ? { rating: p.rating, reviews: p.reviews } : {}),
              ...(p.old_price ? { old_price_azn: p.old_price } : {}),
            },
            price: { amount: p.price_azn, currency: "AZN" },
            source_url: p.url,
            verify: false,
            action: { label: "View on Birmarket", type: "handoff_url" as const, value: p.url },
          })),
          // Chips to narrow down: one per category shown.
          suggestions: gift.categories.map((c) => ({ label: c.label, value: c.refine })),
          need_input: null,
          refinements: ["cheaper gifts", "other ideas"],
        };
      }
    }
    const searchUrl = birmarketSearchUrl(query);
    const linkItem = (title: string) => ({
      id: "search",
      kind: "product",
      title,
      subtitle: query,
      attributes: {},
      price: { amount: null, currency: null },
      source_url: searchUrl,
      verify: true,
      action: { label: "Open Birmarket", type: "handoff_url" as const, value: searchUrl },
    });
    // Primary source: the Birmarket catalog API. The page scraping below runs only when it is down.
    if (CONFIG.birmarketCatalog.enabled()) {
      try {
        return await birmarketCatalogResult(query, slots, linkItem);
      } catch (e) {
        console.error("[Catalog] UNAVAILABLE, using Birmarket pages:", (e as Error).message);
      }
    }
    const live = CONFIG.birmarketLive()
      ? await birmarketLiveSearch(query).catch(() => ({ products: [] as Product[], urls: [] }))
      : { products: [] as Product[], urls: [] };
    const snapshot = getBirmarketProducts() ?? [];
    // Live listing data first: fresher prices win when a product is in both.
    const all = [...new Map([...snapshot, ...live.products].map((p) => [p.id, p])).values()];
    if (!all.length) {
      return {
        status: "partial",
        summary: "The Birmarket catalog is still loading; only a search link is available.",
        items: [linkItem("Search on Birmarket")],
        suggestions: [],
        need_input: null,
        refinements: ["search again"],
      };
    }
    const min = num(slots["budget_min"]),
      max = num(slots["budget_max"]);
    const found = searchProducts(all, query, min, max);
    const toItem = (p: Product) => ({
      id: `p${p.id}`,
      kind: "product",
      title: p.name,
      subtitle: p.old_price ? `was ${p.old_price} AZN` : "",
      attributes: {
        ...(p.image_url ? { image: p.image_url } : {}),
        ...(p.rating != null ? { rating: p.rating, reviews: p.reviews } : {}),
        ...(p.old_price ? { old_price_azn: p.old_price } : {}),
      },
      price: { amount: p.price_azn, currency: p.price_azn == null ? null : "AZN" },
      source_url: p.url,
      verify: false,
      action: { label: "View on Birmarket", type: "handoff_url" as const, value: p.url },
    });
    if (found.products.length) {
      return {
        status: "ok",
        summary: `${found.products.length} Birmarket products for "${query}"${max ? ` up to ${max} AZN` : ""}.`,
        items: found.products.slice(0, 6).map(toItem),
        suggestions: [],
        need_input: null,
        refinements: found.alternatives.length ? ["cheaper options"] : [],
      };
    }
    if (found.alternatives.length) {
      return {
        status: "partial",
        summary: `Nothing for "${query}" in the price range; these are cheaper alternatives.`,
        items: found.alternatives.slice(0, 6).map(toItem),
        suggestions: [],
        need_input: null,
        refinements: ["other brands"],
      };
    }
    return {
      status: "no_results",
      summary: `No Birmarket products found for "${query}".`,
      items: [linkItem("Search on Birmarket")],
      suggestions: [],
      need_input: null,
      refinements: ["different words", "other brands"],
    };
  },
};
