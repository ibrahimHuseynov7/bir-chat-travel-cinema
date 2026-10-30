// Tool adapters: registry `adapter` name -> code. Every adapter maps its source to plain JSON for the
// Module Agent (or, for executor: direct, to a ModuleResult) and records the URLs its data came from,
// so code can check every item's source_url (rule 4).
import type { RegistryEntry, ToolConfig } from "../core/registry";
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
import { resolvePlace, searchFlightOptions } from "./flights";
import { convert, loadRates } from "./money";
import { fetchPage, mark, offerItems, prefetchPages, type ToolContext, webSearch } from "./web";

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

/**
 * Started right after the Orchestrator, while the Module Agent's first model call runs: resolves the
 * trip's cities (cached lookups the flight tool repeats) and the exchange rates. Same data, just earlier.
 */
export function prewarmTools(entry: RegistryEntry, slots: Record<string, string>) {
  if (!entry.tools.some((t) => t.adapter === "aviasales_v1")) return;
  for (const k of ["origin", "destination_or_criteria"])
    if (slots[k]) resolvePlace(slots[k]).catch(() => {});
  if (slots["budget"]) void loadRates();
}

export const AGENT_ADAPTERS: Record<string, AgentAdapter> = {
  websearch_v1: async (args, tool, ctx) => {
    const query = str(args["query"]);
    if (!query) throw new Error("query is required");
    const given = Array.isArray(args["site_filter"])
      ? (args["site_filter"] as unknown[]).map(String)
      : [];
    const results = await webSearch(query, given.length ? given : tool.default_site_filter, ctx);
    prefetchPages(results, ctx);
    return { results };
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

  // ---- Shopping: the Birmarket shopping assistant's catalog tools (same names and parameters). ----
  // Products become ready-made cards (offerItems); the model sees a trimmed, sanitised view and picks
  // products by ref, so prices, images and links always come from the catalog.

  birmarket_search_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const sort = str(args["sort"]);
    const params: CatalogSearchParams = {
      query: str(args["query"]),
      category: str(args["category"]) || undefined,
      priceMin: numArg(args["price_min"]) ?? null,
      priceMax: numArg(args["price_max"]) ?? null,
      brand: str(args["brand"]) || undefined,
      sort: CATALOG_SORTS.has(sort) ? (sort as CatalogSort) : undefined,
      withDiscount: args["with_discount"] === true,
      limit: numArg(args["limit"]) ?? 20,
    };
    try {
      const r = await cat.searchCatalog(params);
      const inStock = r.products.filter((p) => p.availability !== "out_of_stock");
      if (!ctx.suggestions.length)
        ctx.suggestions.push(
          ...cat.refinementChips(inStock, {
            brand: r.brandDropped ? undefined : params.brand,
            priceMin: params.priceMin ?? null,
            priceMax: params.priceMax ?? null,
            sort: params.sort,
          }),
        );
      return {
        ...(r.brandDropped
          ? {
              notice: `No in-stock "${r.brandDropped}" products matched, so the search was repeated without the brand filter. These products are NOT necessarily ${r.brandDropped}.`,
            }
          : {}),
        ...productsForModel(cat, ctx, r.products),
      };
    } catch (e) {
      if (!(e instanceof cat.CatalogUnavailableError))
        return { error: (e as Error).message.slice(0, 300) };
      // Catalog outage: the birmarket.az listing pages still give real products (fewer details).
      const items = await birmarketPagesFallback(params).catch(() => [] as Item[]);
      if (!items.length) return { error: "catalog_unavailable" };
      offerItems(ctx, items);
      return {
        note: "Catalog API unavailable; these products come from the birmarket.az listing pages.",
        products: items.map((i) => ({
          ref: i.id,
          title: cat.neutralizeUntrustedText(i.title, 160),
          price: i.price.amount,
          currency: "AZN",
        })),
      };
    }
  },

  birmarket_details_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const id = str(args["product_id"]).replace(/^p/, "");
    if (!id) return { error: "product_id is required" };
    const d = await catalogCall(cat, () => cat.getProductDetails(id));
    if (!d || "error" in d) return d ?? { error: `product ${id} not found` };
    offerItems(ctx, [catalogItem(d)]);
    return {
      ...trimProduct(cat, d),
      description: cat.neutralizeUntrustedText(d.description, 800),
      attributes: d.attributes
        .slice(0, 15)
        .map((a) => ({ key: a.key, value: cat.neutralizeUntrustedText(a.value, 120) })),
      ...(d.variantCode ? { variantCode: d.variantCode } : {}),
      ...(d.isRefundable != null ? { isRefundable: d.isRefundable } : {}),
      ...(d.instalmentMonths
        ? {
            instalment: `${Math.round((d.price / d.instalmentMonths) * 100) / 100} AZN x ${d.instalmentMonths} months (Birbank)`,
          }
        : {}),
    };
  },

  birmarket_similar_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const id = str(args["product_id"]).replace(/^p/, "");
    const r = await catalogCall(cat, () => cat.getSimilarProducts(id));
    return Array.isArray(r) ? productsForModel(cat, ctx, r) : r;
  },

  birmarket_complementary_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const id = str(args["product_id"]).replace(/^p/, "");
    const r = await catalogCall(cat, () => cat.getComplementaryProducts(id));
    return Array.isArray(r) ? productsForModel(cat, ctx, r) : r;
  },

  birmarket_bestsellers_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const r = await catalogCall(cat, () =>
      cat.getBestsellers(Math.min(numArg(args["limit"]) ?? 5, 20)),
    );
    return Array.isArray(r) ? productsForModel(cat, ctx, r) : r;
  },

  birmarket_suggestions_v1: async (args) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const s = await cat.getSuggestions(str(args["query"]), numArg(args["limit"]) ?? 5);
    const clean = (xs: string[]) => xs.map((x) => cat.neutralizeUntrustedText(x, 80));
    return {
      predictedQueries: clean(s.predictedQueries),
      categories: clean(s.categories.map((c) => c.name)),
      brands: clean(s.brands),
    };
  },

  birmarket_offers_v1: async (args) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const id = str(args["product_id"]).replace(/^p/, "");
    const r = await catalogCall(cat, () => cat.getProductOffers(id));
    if (!Array.isArray(r)) return r;
    return {
      offers: r.map((o) => ({
        ...o,
        ...(o.sellerName ? { sellerName: cat.neutralizeUntrustedText(o.sellerName, 80) } : {}),
        currency: "AZN",
      })),
    };
  },

  birmarket_variations_v1: async (args, _tool, ctx) => {
    const cat = await import("@/lib/birmarket-catalog.server");
    const code = str(args["variant_code"]);
    if (!code) return { error: "variant_code is required (call get_product_details first)" };
    const r = await catalogCall(cat, () => cat.getProductVariations(code));
    return Array.isArray(r) ? productsForModel(cat, ctx, r) : r;
  },
};

// ---------- shopping helpers ----------

type CatalogModule = typeof import("@/lib/birmarket-catalog.server");
const CATALOG_SORTS = new Set(["relevance", "price_asc", "price_desc", "rating", "popularity"]);
const numArg = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The model-facing view of a product (the Birmarket assistant's trimProduct): no images or URLs. */
function trimProduct(cat: CatalogModule, p: CatalogProduct) {
  return {
    ref: `p${p.id}`,
    title: cat.neutralizeUntrustedText(p.title, 160),
    ...(p.brand ? { brand: cat.neutralizeUntrustedText(p.brand, 60) } : {}),
    ...(p.category ? { category: cat.neutralizeUntrustedText(p.category, 80) } : {}),
    price: p.price,
    currency: "AZN",
    ...(p.originalPrice ? { originalPrice: p.originalPrice } : {}),
    ...(p.discountPercent ? { discountPercent: p.discountPercent } : {}),
    availability: p.availability,
    ...(p.rating ? { rating: p.rating } : {}),
    ...(p.sellerName ? { sellerName: cat.neutralizeUntrustedText(p.sellerName, 80) } : {}),
  };
}

/** Out-of-stock products are never offered as cards; the rest become refs the model can pick. */
function productsForModel(cat: CatalogModule, ctx: ToolContext, products: CatalogProduct[]) {
  const usable = products.filter((p) => p.availability !== "out_of_stock");
  offerItems(ctx, usable.map(catalogItem));
  return {
    products: usable.map((p) => trimProduct(cat, p)),
    ...(products.length > usable.length
      ? { out_of_stock_hidden: products.length - usable.length }
      : {}),
  };
}

/** Runs a catalog call; an outage becomes {error: "catalog_unavailable"}, a 4xx the API's message. */
async function catalogCall<T>(
  cat: CatalogModule,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return {
      error:
        e instanceof cat.CatalogUnavailableError
          ? "catalog_unavailable"
          : (e as Error).message.slice(0, 300),
    };
  }
}

/** birmarket.az tag / brand listing pages + the background snapshot, used only when the catalog API is down. */
async function birmarketPagesFallback(params: CatalogSearchParams): Promise<Item[]> {
  const { getBirmarketProducts, searchProducts, warmUp, birmarketLiveSearch } =
    await import("@/lib/scrapers.server");
  warmUp();
  const query = [params.category, params.brand, params.query].filter(Boolean).join(" ");
  if (!query) return [];
  const live = CONFIG.birmarketLive()
    ? await birmarketLiveSearch(query).catch(() => ({ products: [] as Product[], urls: [] }))
    : { products: [] as Product[], urls: [] };
  const all = [
    ...new Map(
      [...(getBirmarketProducts() ?? []), ...live.products].map((p) => [p.id, p]),
    ).values(),
  ];
  return searchProducts(all, query, params.priceMin ?? null, params.priceMax ?? null)
    .products.slice(0, 10)
    .map((p) => ({
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
    }));
}

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
