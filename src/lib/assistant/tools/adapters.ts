// Tool adapters: registry `adapter` name -> code. Every adapter maps its source to plain JSON for the
// Module Agent (or, for executor: direct, to a ModuleResult) and records the URLs its data came from,
// so code can check every item's source_url (rule 4).
import type { ToolConfig } from "../core/registry";
import type { FilterChip, Item, ModuleResult } from "../core/schemas";
import { t, tn } from "../core/i18n";
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
import { llm, parseJSONObject } from "../core/llm";
import { searchFlightOptions } from "./flights";
import { giftPlan, pickGifts, priceBuckets, rangeValue, type PriceRange } from "./gifts";
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
      .filter((s) => date !== today || s.time >= nowHHMM);
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

/** Price-range chips for a product list: ranges from the found prices; the applied one is marked active. */
export function priceFilters(
  prices: number[],
  min: number | null,
  max: number | null,
  language: string,
): FilterChip[] {
  const label = (r: PriceRange) =>
    r.min == null
      ? tn("price_under", language, r.max!)
      : r.max == null
        ? tn("price_over", language, r.min)
        : `${r.min}–${r.max} ₼`;
  const chip = (r: PriceRange, active: boolean): FilterChip => ({
    label: r.min == null && r.max == null ? t("price_any", language) : label(r),
    event: { type: "select", slot: "price_range", value: rangeValue(r) },
    active,
  });
  const ranges = priceBuckets(prices);
  const chips = ranges.map((r) => chip(r, r.min === min && r.max === max));
  const filtered = min != null || max != null;
  // A range the user typed ("under 80 manat") that is not one of the buckets is still shown as applied.
  if (filtered && !chips.some((c) => c.active)) chips.unshift(chip({ min, max }, true));
  if (filtered) chips.unshift(chip({ min: null, max: null }, false));
  return chips;
}

// Model-picked Birmarket categories per query, for product words no category name matches ("gəzinti üçün şey").
const aiCategoryCache = new Map<string, string[]>();
async function aiBirmarketCategories(query: string, candidates: { slug: string; name: string }[]): Promise<string[]> {
  if (!CONFIG.azure.apiKey() || !query.trim()) return [];
  const key = query.trim().toLowerCase();
  const hit = aiCategoryCache.get(key);
  if (hit) return hit;
  const { birmarketCategoryChoices } = await import("@/lib/scrapers.server");
  const choices = [...new Map([...candidates, ...birmarketCategoryChoices()].map((c) => [c.slug, c])).values()];
  try {
    const out = await llm(
      "orchestrator",
      [
        {
          role: "system",
          content:
            'Pick the Birmarket.az categories where the product would be listed. Reply with ONLY JSON {"slugs":["..."]}: ' +
            "1-2 slugs from the list, most specific first, or [] if none fits.",
        },
        { role: "user", content: `Product: ${query}\nCategories (slug: name):\n${choices.map((c) => `${c.slug}: ${c.name}`).join("\n")}` },
      ],
      { json: true },
    );
    const valid = new Set(choices.map((c) => c.slug));
    const slugs = ((parseJSONObject(out.content) as { slugs?: unknown }).slugs ?? []) as unknown[];
    const picked = slugs.filter((s): s is string => typeof s === "string" && valid.has(s)).slice(0, 2);
    aiCategoryCache.set(key, picked);
    return picked;
  } catch (e) {
    console.error("birmarket category pick failed", e);
    return [];
  }
}

export const DIRECT_ADAPTERS: Record<string, DirectAdapter> = {
  // Shopping: live Birmarket listing pages for the query (tags / brand) + the background catalog snapshot.
  // Gift requests without a product ("a present for my mom") get a varied mix of gift ideas for that recipient.
  // Every result carries price-range filter chips. Used until the shopping assistant endpoint exists.
  birmarket_v1: async ({ query, slots, language }) => {
    const {
      getBirmarketProducts,
      searchProducts,
      warmUp,
      birmarketLiveSearch,
      birmarketCategoryMatch,
      birmarketCategoryProducts,
    } = await import("@/lib/scrapers.server");
    warmUp();
    const gift = giftPlan(query, slots["recipient"] ?? "");
    // "hədiyyə ətir" = a perfume as a gift: search the product words; a bare gift request uses gift ideas.
    const productQuery = gift ? gift.rest.join(" ") : query;
    const giftMode = !!gift && !productQuery;
    const searchUrl = birmarketSearchUrl(giftMode ? "hədiyyə" : productQuery);
    const linkItem = (title: string) => ({
      id: "search",
      kind: "product",
      title,
      subtitle: giftMode ? "" : productQuery,
      attributes: {},
      price: { amount: null, currency: null },
      source_url: searchUrl,
      verify: true,
      action: { label: "Open Birmarket", type: "handoff_url" as const, value: searchUrl },
    });
    const snapshot = getBirmarketProducts() ?? [];
    // Live pages for this request, read in parallel: the product's own category listing (matched by name,
    // or picked by the model when no name matches), plus tag / brand pages for model names. This works
    // without the background snapshot, so a cold start still returns real products.
    let categorySlugs: string[] = [];
    const ideaQueries = giftMode ? gift.ideas.map((i) => i.phrases[0]?.join(" ") ?? "").filter(Boolean) : [];
    if (CONFIG.birmarketLive()) {
      if (giftMode) {
        const pick = (q: string) => {
          const m = birmarketCategoryMatch(q);
          return (m.confident[0] ?? m.candidates[0])?.slug;
        };
        categorySlugs = [...new Set(ideaQueries.map(pick).filter((s): s is string => !!s))].slice(0, 6);
      } else {
        // A category whose whole name matches is used directly; otherwise the model picks (cached per query).
        const m = birmarketCategoryMatch(productQuery);
        categorySlugs = m.confident.map((c) => c.slug);
        if (!categorySlugs.length) categorySlugs = await aiBirmarketCategories(productQuery, m.candidates);
        if (!categorySlugs.length) categorySlugs = m.candidates.slice(0, 1).map((c) => c.slug);
      }
    }
    const noLive = { products: [] as Product[], urls: [] as string[] };
    const [live, fromCategories] = await Promise.all([
      CONFIG.birmarketLive() && !giftMode ? birmarketLiveSearch(productQuery).catch(() => noLive) : noLive,
      categorySlugs.length ? birmarketCategoryProducts(categorySlugs).catch(() => [] as Product[]) : [],
    ]);
    // Live listing data first: fresher prices win when a product is in both.
    const all = [
      ...new Map([...snapshot, ...fromCategories, ...live.products].map((p) => [p.id, p])).values(),
    ];
    if (!all.length) {
      return {
        status: "no_results",
        summary: `No Birmarket products found for "${giftMode ? "gift" : productQuery}".`,
        items: [linkItem("Search on Birmarket")],
        suggestions: [],
        need_input: null,
        refinements: ["different words"],
      };
    }
    const min = num(slots["budget_min"]),
      max = num(slots["budget_max"]);
    const range =
      min != null && max != null
        ? ` between ${min} and ${max} AZN`
        : max != null
          ? ` up to ${max} AZN`
          : min != null
            ? ` from ${min} AZN`
            : "";
    const toItem = (p: Product, idea?: string) => ({
      id: `p${p.id}`,
      kind: "product",
      title: p.name,
      subtitle: p.old_price ? `was ${p.old_price} AZN` : "",
      attributes: {
        ...(idea ? { gift_idea: idea } : {}),
        ...(p.image_url ? { image: p.image_url } : {}),
        ...(p.rating != null ? { rating: p.rating, reviews: p.reviews } : {}),
        ...(p.old_price ? { old_price_azn: p.old_price } : {}),
      },
      price: { amount: p.price_azn, currency: p.price_azn == null ? null : "AZN" },
      source_url: p.url,
      verify: false,
      action: { label: "View on Birmarket", type: "handoff_url" as const, value: p.url },
    });

    if (giftMode) {
      const who = gift.recipient || "someone";
      const g = pickGifts(all, gift, min, max);
      const filters = priceFilters(g.prices, min, max, language);
      if (g.picks.length) {
        return {
          status: "ok",
          summary: `Gift ideas for ${who} from Birmarket${range}: ${g.ideasFound.join(", ").toLowerCase()}.`,
          items: g.picks.map((x) => toItem(x.product, x.idea)),
          suggestions: [],
          need_input: null,
          refinements: g.ideasFound.slice(0, 3).map((i) => `more ${i.toLowerCase()} for ${who}`),
          filters,
        };
      }
      return {
        status: "no_results",
        summary: `No Birmarket gift ideas for ${who}${range}.`,
        items: [linkItem("Search gifts on Birmarket")],
        suggestions: [],
        need_input: null,
        refinements: range ? ["any price"] : ["different gift idea"],
        filters,
      };
    }

    let found = searchProducts(all, productQuery, min, max);
    // The product's category listing is relevant even when names use other words ("Səyahət çantası" for
    // çamadan): rank those by the remaining words (colour, size), then rating, within the budget.
    if (!found.products.length && !found.alternatives.length && fromCategories.length) {
      const extra = productQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const score = (p: Product) =>
        extra.filter((w) => p.name.toLowerCase().includes(w)).length * 10 +
        (p.rating ?? 0) * Math.log10(10 + (p.reviews ?? 0));
      const inCats = [...new Map(fromCategories.map((p) => [p.id, p])).values()].filter((p) => p.price_azn != null);
      const inRange = inCats.filter(
        (p) => (min == null || p.price_azn! >= min) && (max == null || p.price_azn! <= max),
      );
      found = {
        products: inRange.sort((a, b) => score(b) - score(a)).slice(0, 6),
        alternatives: [],
        prices: inCats.map((p) => p.price_azn!),
      };
    }
    const filters = priceFilters(found.prices, min, max, language);
    if (found.products.length) {
      return {
        status: "ok",
        summary: `${found.products.length} Birmarket products for "${productQuery}"${range}.`,
        items: found.products.slice(0, 6).map((p) => toItem(p)),
        suggestions: [],
        need_input: null,
        refinements: found.alternatives.length ? ["cheaper options"] : [],
        filters,
      };
    }
    if (found.alternatives.length) {
      return {
        status: "partial",
        summary: `Nothing for "${productQuery}" in the price range; these are cheaper alternatives.`,
        items: found.alternatives.slice(0, 6).map((p) => toItem(p)),
        suggestions: [],
        need_input: null,
        refinements: ["other brands"],
        filters,
      };
    }
    return {
      status: "no_results",
      summary: `No Birmarket products found for "${productQuery}"${range}.`,
      items: [linkItem("Search on Birmarket")],
      suggestions: [],
      need_input: null,
      refinements: ["different words", "other brands"],
      ...(found.prices.length ? { filters } : {}),
    };
  },
};
