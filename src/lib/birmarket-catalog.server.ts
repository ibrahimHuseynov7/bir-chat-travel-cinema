// Server-only: Birmarket MP Catalog API (Umico marketplace), the shopping module's primary product source.
// Ported from the Birmarket shopping assistant (product-service.ts + tools/executor.ts): verified category
// anchoring, sort mapping, integer price bounds, AZ->RU fallback, brand-drop retry and /suggests recovery.
// Page scraping in scrapers.server.ts stays as the fallback when this API is unavailable.
import { CONFIG } from "@/lib/assistant/config";

export class CatalogUnavailableError extends Error {
  constructor(
    public operation: string,
    cause: unknown,
  ) {
    super(
      `Birmarket catalog unavailable (${operation}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "CatalogUnavailableError";
  }
}

export interface CatalogProduct {
  id: string;
  title: string;
  brand: string;
  category: string;
  price: number;
  originalPrice?: number;
  discountPercent?: number;
  availability: "in_stock" | "low_stock" | "out_of_stock";
  imageUrl: string;
  rating?: number;
  reviewCount?: number;
  url: string;
  instalmentMonths?: number;
  sellerName?: string;
}

export type CatalogSort = "relevance" | "price_asc" | "price_desc" | "rating" | "popularity";

export interface CatalogSearchParams {
  query: string;
  categoryId?: number | undefined;
  /** Category name as the user / model wrote it; resolved against /categories/all. */
  category?: string | undefined;
  /** Query before inferCategory() removed the category word; used if the category anchor finds nothing. */
  fullQuery?: string;
  priceMin?: number | null;
  priceMax?: number | null;
  brand?: string | undefined;
  sort?: CatalogSort | undefined;
  withDiscount?: boolean;
  limit?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

// ---------- API client ----------

/** The catalog answered with a 4xx: our parameters are wrong, not an outage. */
const isClientError = (e: unknown) =>
  e instanceof Error &&
  /MP Catalog API error: (?:400|404|405|409|410|413|414|422)\b/.test(e.message);

async function apiGet(path: string, params: Params = {}, language = "az"): Promise<unknown> {
  const base = CONFIG.birmarketCatalog.url().replace(/\/+$/, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = `${base}${path}${qs.size ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { "Accept-Language": language };
  const key = CONFIG.birmarketCatalog.apiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(CONFIG.birmarketCatalog.timeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `MP Catalog API error: ${res.status} ${res.statusText} [${path}?${qs}] ${body}`,
    );
  }
  return res.json();
}

/** Our sort enum -> the values the catalog accepts (anything else is HTTP 400). */
export function mapSort(sort?: string): string {
  switch (sort) {
    case "price_asc":
      return "retail_price_asc";
    case "price_desc":
      return "retail_price_desc";
    case "rating":
      return "rating_desc";
    case "popularity":
      return "search_popular_score";
    default:
      return "boosted_score";
  }
}

// ---------- normalisation ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
/** https://birmarket.az/product/{id}-{slug}; the id alone also works (302 to the canonical URL). */
function productUrl(p: any): string {
  const slug = p?.slugged_name || p?.slugged_name_az || p?.slugged_name_ru || "";
  return slug
    ? `https://birmarket.az/product/${p.id}-${slug}`
    : `https://birmarket.az/product/${p.id}`;
}

export function normalizeProduct(p: any): CatalogProduct {
  const offer = p?.default_offer ?? {};
  const ratings = p?.ratings ?? {};
  const img = p?.main_img ?? {};
  const price = Number(offer.retail_price ?? 0);
  const old = Number(offer.old_price ?? 0);
  // `status` is the only reliable availability signal: default_offer.qty is 0 for many purchasable items.
  let availability: CatalogProduct["availability"] = "in_stock";
  if (p?.status !== "active") availability = "out_of_stock";
  else if (
    offer.qty > 0 &&
    offer.show_stock_qty_threshold &&
    offer.qty <= offer.show_stock_qty_threshold
  )
    availability = "low_stock";
  const brand = typeof p?.brand === "string" ? p.brand : (p?.brand?.name ?? "");
  return {
    id: String(p?.id ?? ""),
    title: p?.name ?? "",
    brand: brand === "No Brand" ? "" : brand,
    category: p?.category?.name ?? "",
    price,
    ...(old > price
      ? { originalPrice: old, discountPercent: Math.round(((old - price) / old) * 100) }
      : {}),
    availability,
    imageUrl: img.medium ?? img.big ?? img.small ?? "",
    ...(ratings.rating_value ? { rating: Number(ratings.rating_value) } : {}),
    ...(ratings.rating_value
      ? { reviewCount: Number(ratings.review_count ?? ratings.session_count ?? 0) }
      : {}),
    url: productUrl(p),
    ...(offer.installment_enabled ? { instalmentMonths: offer.max_installment_months } : {}),
    ...(offer.seller?.marketing_name?.name ? { sellerName: offer.seller.marketing_name.name } : {}),
  };
}

// ---------- categories ----------

export interface CategoryInfo {
  id: number;
  name: string;
  slug: string;
}

let categories: CategoryInfo[] | null = null;
let categoriesAt = 0;
async function getCategories(): Promise<CategoryInfo[]> {
  if (categories && Date.now() - categoriesAt < 3600_000) return categories;
  try {
    const r = (await apiGet("/api/v1/categories/all")) as any;
    const list: any[] = Array.isArray(r) ? r : Array.isArray(r?.categories) ? r.categories : [];
    // Lowest id first: several categories share a name and the lowest is the primary one.
    categories = list
      .map((c) => ({ id: c.id, name: c.name ?? "", slug: c.slugged_name ?? "" }))
      .sort((a, b) => a.id - b.id);
    categoriesAt = Date.now();
  } catch (e) {
    console.error("[Catalog] categories", (e as Error).message);
  }
  return categories ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Intent words that must never anchor a category ("hədiyyə" would match gift wrapping). */
const CATEGORY_STOPWORDS = new Set([
  "hədiyyə",
  "hediyye",
  "gift",
  "present",
  "подарок",
  "подарк",
  "sürpriz",
  "surprise",
  "məhsul",
  "product",
  "item",
  "товар",
  "oyun",
  "oyunlar",
  "oyunları",
]);

/** Turkish / English spellings the model sometimes writes -> the catalog's Azerbaijani words. */
function normalizeToAz(text: string): string {
  return text
    .replace(/ayakkabı/gi, "ayaqqabı")
    .replace(/çorap/gi, "corab")
    .replace(/gömlek/gi, "köynək")
    .replace(/şapka/gi, "papaq")
    .replace(/bilgisayar/gi, "kompüter")
    .replace(/cep telefonu/gi, "telefon")
    .replace(/\bsneakers?\b/gi, "krosovka")
    .replace(/\brunning shoes?\b/gi, "qaçış ayaqqabısı")
    .replace(/\bheadphones?\b/gi, "qulaqlıq")
    .replace(/\bearbuds?\b/gi, "qulaqlıq")
    .replace(/\blaptops?\b/gi, "noutbuk")
    .replace(/\bperfumes?\b/gi, "ətir")
    .replace(/\bwatche?s?\b/gi, "saat")
    .replace(/\bshoes?\b/gi, "ayaqqabı")
    .replace(/\bclothing\b/gi, "geyim")
    .replace(/\btoys?\b/gi, "oyuncaq")
    .replace(/\bgifts?\b/gi, "hədiyyə");
}

/** Category name -> id. Exact name, then partial match for single words only, then slug, then "a/b" parts. */
export function resolveCategoryFromList(name: string, list: CategoryInfo[]): number | undefined {
  const lower = normalizeToAz(name.trim().toLowerCase());
  if (!lower || CATEGORY_STOPWORDS.has(lower)) return undefined;
  const exact = list.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact.id;
  // Multi-word names partial-match the wrong thing ("ps5 oyunları" -> board games).
  if (lower.split(/\s+/).filter((w) => w.length > 1).length <= 1) {
    const partial = list.find(
      (c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()),
    );
    if (partial) return partial.id;
  }
  const slug = list.find((c) => c.slug.toLowerCase() === lower);
  if (slug) return slug.id;
  if (/[/,]/.test(lower))
    for (const part of lower.split(/[/,]/).map((s) => s.trim())) {
      if (part.length < 3 || CATEGORY_STOPWORDS.has(part)) continue;
      const m = list.find(
        (c) => c.name.toLowerCase().includes(part) || part.includes(c.name.toLowerCase()),
      );
      if (m) return m.id;
    }
  return undefined;
}

// The catalog category table verified against /api/v1/categories/all. A bare text query surfaces cases,
// toys and decor above the real thing, so common product types are anchored to their category.
const CAT = {
  phones: 3, // Mobil telefonlar və smartfonlar
  laptops: 16, // Notbuklar
  headphones: 6, // Qulaqlıqlar və qarniturlar
  smartWatches: 4, // Ağıllı saatlar və fitnes qolbaqları
  perfume: 259, // Ətirlər
  menSneakers: 3177, // Kişi krosovkaları və kedləri
  womenSneakers: 3105, // Qadın krosovkaları və kedləri
  menWatches: 4090, // Kişi qol saatları
  womenWatches: 4040, // Qadın qol saatları
};
const CATEGORY_WORDS: [number, string[]][] = [
  [CAT.phones, ["smartfon", "telefon", "смартфон", "телефон", "iphone"]],
  [CAT.laptops, ["noutbuk", "notbuk", "laptop", "ноутбук", "macbook"]],
  [CAT.headphones, ["qulaqlıq", "qulaqliq", "наушник", "airpods"]],
  [CAT.perfume, ["ətir", "etir", "parfüm", "parfum", "духи", "парфюм"]],
];
// Words meaning "an accessory FOR the product": then anchoring to the product category is wrong.
const ACCESSORY_RX =
  /(çexol|cexol|qab[ıi]|keys|şüşə|qoruyucu|plyonka|kabel|adapter|şarj|tutacaq|ştativ|stend|чехол|стекл|кабел|заряд|держател|пленк)/i;
const MEN = /(kişi|kisi|мужск)/i;
const WOMEN = /(qadın|qadin|женск)/i;
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Picks a verified category for a query and removes the category word from it (the query then carries only
 * brand / model / modifiers, as the catalog expects). Returns nothing when the query is an accessory or no
 * table entry fits; the search then runs unanchored.
 */
export function inferCategory(query: string): { categoryId: number; query: string } | null {
  const q = query.toLowerCase();
  if (ACCESSORY_RX.test(q)) return null;
  const ws = words(q);
  const strip = (prefixes: string[]) =>
    ws.filter((w) => !prefixes.some((p) => w.startsWith(p))).join(" ");
  if (
    /(ağıllı|agilli|smart)\s*saat|smart\s*watch|fitnes\s*qolbaq|умные\s*часы|apple\s*watch/.test(q)
  )
    return {
      categoryId: CAT.smartWatches,
      query: strip([
        "ağıllı",
        "agilli",
        "smart",
        "saat",
        "watch",
        "fitnes",
        "qolbaq",
        "умн",
        "час",
      ]),
    };
  if (ws.some((w) => w.startsWith("krosovk") || w.startsWith("кроссовк") || w.startsWith("ked"))) {
    const id = MEN.test(q) ? CAT.menSneakers : WOMEN.test(q) ? CAT.womenSneakers : null;
    if (id)
      return {
        categoryId: id,
        query: strip([
          "krosovk",
          "кроссовк",
          "ked",
          "kişi",
          "kisi",
          "qadın",
          "qadin",
          "мужск",
          "женск",
        ]),
      };
  }
  if (ws.some((w) => w.startsWith("saat") || w.startsWith("часы"))) {
    const id = MEN.test(q) ? CAT.menWatches : WOMEN.test(q) ? CAT.womenWatches : null;
    if (id)
      return {
        categoryId: id,
        query: strip(["saat", "qol", "часы", "kişi", "kisi", "qadın", "qadin", "мужск", "женск"]),
      };
  }
  for (const [id, prefixes] of CATEGORY_WORDS)
    if (ws.some((w) => prefixes.some((p) => w.startsWith(p))))
      // Model names stay in the query ("iphone", "macbook"); only the generic type word goes.
      return {
        categoryId: id,
        query: strip(prefixes.filter((p) => !["iphone", "macbook", "airpods"].includes(p))),
      };
  return null;
}

// ---------- query language ----------

const NON_AZRU_WORDS = new Set([
  "the",
  "for",
  "with",
  "and",
  "under",
  "over",
  "best",
  "cheap",
  "good",
  "buy",
  "find",
  "need",
  "want",
  "looking",
  "search",
  "show",
  "me",
  "please",
  "some",
  "any",
  "this",
  "that",
  "these",
  "those",
  "shoes",
  "laptop",
  "phone",
  "watch",
  "dress",
  "shirt",
  "bag",
  "running",
  "gaming",
  "wireless",
  "headphones",
  "perfume",
  "gift",
  "bilgisayar",
  "ayakkabı",
  "gömlek",
  "hediye",
  "koşu",
  "arıyorum",
  "istiyorum",
  "bana",
  "der",
  "die",
  "das",
  "für",
  "mit",
  "und",
  "kaufen",
  "suche",
  "schuhe",
  "geschenk",
  "ich",
  "les",
  "des",
  "pour",
  "avec",
  "cherche",
  "acheter",
]);

/** True when a multi-word, non-Cyrillic query is mostly English / Turkish / German / French words. */
export function looksNonAzRu(query: string): boolean {
  if (/[Ѐ-ӿ]/.test(query)) return false;
  const ws = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (ws.length <= 1) return false;
  return ws.filter((w) => NON_AZRU_WORDS.has(w)).length / ws.length > 0.4;
}

// Static AZ -> RU dictionary: the catalog's embeddings are stronger in Russian for some categories
// ("idman geyimi" finds nothing, "спортивная одежда" finds plenty).
const AZ_TO_RU: Record<string, string> = {
  "idman geyimi": "спортивная одежда",
  "idman ayaqqabısı": "спортивная обувь",
  "idman şalvarı": "спортивные штаны",
  "idman kostyumu": "спортивный костюм",
  idman: "спорт",
  "qış gödəkçəsi": "зимняя куртка",
  "qış ayaqqabısı": "зимняя обувь",
  "qış geyimi": "зимняя одежда",
  "yay paltarı": "летнее платье",
  "yay geyimi": "летняя одежда",
  "kişi kostyumu": "мужской костюм",
  "kişi geyimi": "мужская одежда",
  "qadın geyimi": "женская одежда",
  "qadın ayaqqabısı": "женская обувь",
  "qadın paltarı": "женское платье",
  "uşaq geyimi": "детская одежда",
  "uşaq ayaqqabısı": "детская обувь",
  "uşaq paltarı": "детское платье",
  "ev geyimi": "домашняя одежда",
  oyun: "игра",
  oyunlar: "игры",
  oyunları: "игры",
  "ps5 oyunları": "игры ps5",
  "ps4 oyunları": "игры ps4",
  "xbox oyunları": "игры xbox",
  "oyun diski": "игровой диск",
  "oyun konsolu": "игровая консоль",
  geyim: "одежда",
  ayaqqabı: "обувь",
  paltar: "платье",
  gödəkçə: "куртка",
  kostyum: "костюм",
  şalvar: "штаны",
  köynək: "рубашка",
  sviter: "свитер",
  pencək: "пиджак",
  corab: "носки",
  papaq: "шапка",
  əlcək: "перчатки",
  kəmər: "ремень",
};

export function translateQueryToRu(query: string): string | undefined {
  const lower = query.toLowerCase().trim();
  if (!lower) return undefined;
  if (AZ_TO_RU[lower]) return AZ_TO_RU[lower];
  const ws = lower.split(/\s+/);
  const out = ws.map((w) => AZ_TO_RU[w] ?? w);
  return out.some((t, i) => t !== ws[i]) ? out.join(" ") : undefined;
}

export function mergeResults(primary: CatalogProduct[], secondary: CatalogProduct[]) {
  const seen = new Set(primary.map((p) => p.id));
  return [...primary, ...secondary.filter((p) => !seen.has(p.id))];
}

const usable = (ps: CatalogProduct[]) => ps.filter((p) => p.availability !== "out_of_stock");

/** AZ first; when it finds fewer than 3 usable products, try the RU translation and keep it only if better. */
export async function applyAzRuFallback(
  params: CatalogSearchParams,
  search: (p: CatalogSearchParams) => Promise<CatalogProduct[]>,
  translate: (q: string) => string | undefined = translateQueryToRu,
): Promise<CatalogProduct[]> {
  const az = await search(params);
  const azCount = usable(az).length;
  if (azCount >= 3) return az;
  const ru = translate(params.query);
  if (!ru) return az;
  try {
    const ruResults = await search({ ...params, query: ru });
    return usable(ruResults).length > azCount ? mergeResults(ruResults, az) : az;
  } catch {
    return az;
  }
}

// ---------- search ----------

async function searchCore(params: CatalogSearchParams): Promise<CatalogProduct[]> {
  let categoryId = params.categoryId;
  if (!categoryId && params.category)
    categoryId = resolveCategoryFromList(params.category, await getCategories());
  // The catalog parses prices with Go ParseInt (decimals are HTTP 400) and drops a one-sided range,
  // so both bounds are always sent together, the lower rounded down and the upper rounded up.
  const hasMin = params.priceMin != null && params.priceMin > 0;
  const hasMax = params.priceMax != null && params.priceMax > 0;
  const priceFrom = hasMin ? Math.floor(params.priceMin!) : hasMax ? 0 : undefined;
  const priceTo = hasMax ? Math.ceil(params.priceMax!) : hasMin ? 10_000_000 : undefined;
  const r = (await apiGet("/api/v1/products", {
    query: params.query,
    category_id: categoryId,
    price_from: priceFrom,
    price_to: priceTo,
    brands: params.brand,
    sort: mapSort(params.sort),
    per_page: Math.min(params.limit ?? 20, 24),
    page: 1,
    ...(params.withDiscount ? { with_discount: true } : {}),
  })) as { products?: unknown[]; meta?: { total?: number } };
  const products = (r?.products ?? []).map(normalizeProduct);
  if (CONFIG.debug())
    console.log(
      `[Catalog] [SEARCH] q="${params.query}" cat_id=${categoryId ?? "none"} total=${r?.meta?.total ?? "?"} returned=${products.length} usable=${usable(products).length}`,
    );
  return products;
}

export interface CatalogSearchResult {
  products: CatalogProduct[];
  /** Brand filter that matched nothing and was dropped ("SD card for a Canon camera"). */
  brandDropped?: string;
  /** True when the category anchor matched nothing and the search was repeated unanchored. */
  categoryDropped?: boolean;
}

/**
 * Catalog search with the assistant's recovery steps: AZ->RU fallback, then (when nothing usable came
 * back) the same search without the brand, then without the inferred category. Price filters are never
 * dropped here; the caller decides how to present out-of-budget alternatives.
 * Throws CatalogUnavailableError on outages and network errors.
 */
export async function searchCatalog(params: CatalogSearchParams): Promise<CatalogSearchResult> {
  const run = (p: CatalogSearchParams) => applyAzRuFallback(p, searchCore);
  try {
    // A query that is mostly English etc. finds little; with a category, the category alone is better.
    if ((params.categoryId || params.category) && looksNonAzRu(params.query))
      params = { ...params, query: "" };
    let products = await run(params);
    let brandDropped: string | undefined;
    let categoryDropped = false;
    if (!usable(products).length && params.brand) {
      const retry = await run({ ...params, brand: undefined });
      if (usable(retry).length) {
        products = retry;
        brandDropped = params.brand;
        params = { ...params, brand: undefined };
      }
    }
    if (!usable(products).length && params.categoryId && params.fullQuery) {
      // The category word was taken out of the query; put it back for the unanchored search.
      const retry = await run({ ...params, categoryId: undefined, query: params.fullQuery });
      if (usable(retry).length) {
        products = retry;
        categoryDropped = true;
      }
    }
    return {
      products,
      ...(brandDropped ? { brandDropped } : {}),
      ...(categoryDropped ? { categoryDropped } : {}),
    };
  } catch (e) {
    if (isClientError(e)) throw e;
    throw new CatalogUnavailableError("search", e);
  }
}

export interface CatalogSuggestions {
  predictedQueries: string[];
  categories: { id: number; name: string }[];
  brands: string[];
}

/** /suggests: spelling corrections, categories and brands for a query that found nothing. Never throws. */
export async function getSuggestions(query: string, limit = 5): Promise<CatalogSuggestions> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await apiGet("/api/v1/suggests", { full_text: query, limit })) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (xs: unknown, pick: (x: any) => unknown) =>
      (Array.isArray(xs) ? xs.map(pick) : []).filter(
        (x): x is string => typeof x === "string" && !!x,
      );
    return {
      predictedQueries: names(r?.predictions?.next_words, (p) => p?.word),
      categories: (Array.isArray(r?.categories) ? r.categories : [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => ({ id: Number(c?.id), name: String(c?.name ?? "") }))
        .filter((c: { id: number; name: string }) => c.id && c.name),
      brands: names(r?.brands, (b) => b?.name),
    };
  } catch (e) {
    console.error("[Catalog] suggests", (e as Error).message);
    return { predictedQueries: [], categories: [], brands: [] };
  }
}

/** Sitewide bestsellers (not filtered by category, brand or price). */
export async function getBestsellers(limit = 6): Promise<CatalogProduct[]> {
  try {
    const r = (await apiGet("/api/v1/products/blocks/bestsellers", {
      per_page: limit,
      page: 1,
    })) as {
      products?: unknown[];
    };
    return (r?.products ?? []).map(normalizeProduct);
  } catch (e) {
    throw new CatalogUnavailableError("bestsellers", e);
  }
}

/** A 404 means "no such product", not an outage. */
const isNotFound = (e: unknown) =>
  e instanceof Error && /MP Catalog API error: 404\b/.test(e.message);
/** Outages become CatalogUnavailableError; a 4xx (our parameters are wrong) is rethrown for the model. */
function rethrow(operation: string, e: unknown): never {
  if (isClientError(e)) throw e;
  throw new CatalogUnavailableError(operation, e);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CatalogProductDetail extends CatalogProduct {
  description: string;
  attributes: { key: string; value: string }[];
  variantCode?: string;
  isRefundable?: boolean;
}

export async function getProductDetails(id: string): Promise<CatalogProductDetail | null> {
  try {
    const p = (await apiGet(`/api/v1/products/${encodeURIComponent(id)}`)) as any;
    if (!p?.id) return null;
    return {
      ...normalizeProduct(p),
      description: String(p.description ?? ""),
      attributes: (Array.isArray(p.custom_fields) ? p.custom_fields : [])
        .filter((cf: any) => Array.isArray(cf?.values))
        .map((cf: any) => ({ key: `field_${cf.master_field_id}`, value: cf.values.join(", ") })),
      ...(typeof p.variant_code === "string" ? { variantCode: p.variant_code } : {}),
      ...(typeof p.is_refundable === "boolean" ? { isRefundable: p.is_refundable } : {}),
    };
  } catch (e) {
    if (isNotFound(e)) return null;
    rethrow("details", e);
  }
}

async function productList(path: string, operation: string): Promise<CatalogProduct[]> {
  try {
    const r = (await apiGet(path)) as any;
    const list = Array.isArray(r) ? r : Array.isArray(r?.products) ? r.products : [];
    return list.map(normalizeProduct);
  } catch (e) {
    if (isNotFound(e)) return [];
    rethrow(operation, e);
  }
}
export const getSimilarProducts = (id: string) =>
  productList(`/api/v1/products/${encodeURIComponent(id)}/similars`, "similar");
export const getComplementaryProducts = (id: string) =>
  productList(`/api/v1/products/${encodeURIComponent(id)}/complementaries`, "complementary");
export const getProductVariations = (variantCode: string) =>
  productList(`/api/v1/products/variation?code=${encodeURIComponent(variantCode)}`, "variations");

export interface CatalogOffer {
  sellerName?: string;
  sellerRating?: number;
  price: number;
  originalPrice?: number;
  discountPercent?: number;
  instalmentMonths?: number;
  instalmentMonthlyPayment?: number;
  available: boolean;
}

export async function getProductOffers(id: string): Promise<CatalogOffer[]> {
  try {
    const r = (await apiGet(`/api/v1/products/${encodeURIComponent(id)}/offers`)) as any;
    return (Array.isArray(r?.offers) ? r.offers : []).map((o: any): CatalogOffer => {
      const price = Number(o?.retail_price ?? 0);
      const old = Number(o?.old_price ?? 0);
      const months = o?.installment_enabled ? Number(o?.max_installment_months ?? 0) || 0 : 0;
      return {
        ...(o?.seller?.marketing_name?.name ? { sellerName: o.seller.marketing_name.name } : {}),
        ...(typeof o?.seller?.rating === "number" ? { sellerRating: o.seller.rating } : {}),
        price,
        ...(old > price
          ? { originalPrice: old, discountPercent: Math.round(((old - price) / old) * 100) }
          : {}),
        ...(months
          ? {
              instalmentMonths: months,
              instalmentMonthlyPayment: Math.round((price / months) * 100) / 100,
            }
          : {}),
        available: Number(o?.qty ?? 0) > 0,
      };
    });
  } catch (e) {
    if (isNotFound(e)) return [];
    rethrow("offers", e);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- untrusted text ----------

// Product titles, descriptions and seller names are written by third parties and reach the model through tool
// results. Text that reads as an instruction to the assistant is replaced before the model sees it; the UI
// cards keep the original text.
export const FILTERED_MARKER = "[filtered: instruction-like text removed]";
const INJECTION_RX = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|earlier|system)\b.{0,30}\b(instructions?|rules?|prompts?|messages?)\b/i,
  /\b(system|developer)\s*prompt\b/i,
  /\byou are now\b|\bact as\b.{0,30}\b(ai|assistant|dan|unfiltered)\b/i,
  /<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?(inst|system)\]|###\s*(system|instruction)/i,
  /^\s*(system|assistant|developer)\s*:/im,
  /(игнорир|забудь).{0,40}(инструкц|правил)|системн\S*\s+промпт/i,
  /(əvvəlki|bütün).{0,30}(təlimat|qayda).{0,30}(unut|nəzərə alma|ignor)/i,
  /(önceki|tüm).{0,30}(talimat|kural).{0,30}(unut|yok say|görmezden)/i,
];
export function neutralizeUntrustedText(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") return "";
  const s = value.normalize("NFKC").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "");
  const capped = s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
  return INJECTION_RX.some((rx) => rx.test(capped)) ? FILTERED_MARKER : capped;
}

// ---------- follow-up chips ----------

const PRICE_BANDS: { label: string; min: number | null; max: number | null }[] = [
  { label: "Under 500 AZN", min: null, max: 500 },
  { label: "500–1500 AZN", min: 500, max: 1500 },
  { label: "1500–3000 AZN", min: 1500, max: 3000 },
  { label: "3000+ AZN", min: 3000, max: null },
];

/**
 * Refinement chips from the results: top brands when the results mix brands, else price bands that would
 * actually split them, else a price-sort toggle. Active filters are skipped so chips never loop.
 */
export function refinementChips(
  products: CatalogProduct[],
  active: {
    brand?: string | undefined;
    priceMin?: number | null;
    priceMax?: number | null;
    sort?: CatalogSort | undefined;
    /** Brands already named in the query get no chip. */
    query?: string;
  },
): { label: string; value: string }[] {
  const counts = new Map<string, number>();
  for (const p of products) if (p.brand) counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
  const brands = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([b]) => b)
    .filter(
      (b) =>
        b.toLowerCase() !== (active.brand ?? "").toLowerCase() &&
        !(active.query ?? "").toLowerCase().includes(b.toLowerCase()),
    );
  if (!active.brand && brands.length >= 2)
    return brands.slice(0, 3).map((b) => ({ label: b, value: `only ${b}` }));
  const bands = PRICE_BANDS.filter(
    (b) =>
      !(b.min === (active.priceMin ?? null) && b.max === (active.priceMax ?? null)) &&
      products.some(
        (p) => (b.min == null || p.price >= b.min) && (b.max == null || p.price <= b.max),
      ),
  );
  if (bands.length >= 2 && active.priceMin == null && active.priceMax == null)
    return bands.map((b) => ({
      label: b.label,
      value:
        b.min == null
          ? `under ${b.max} AZN`
          : b.max == null
            ? `over ${b.min} AZN`
            : `from ${b.min} to ${b.max} AZN`,
    }));
  return [
    active.sort !== "price_asc" ? { label: "Cheapest first", value: "cheapest first" } : null,
    active.sort !== "price_desc"
      ? { label: "Most expensive first", value: "most expensive first" }
      : null,
  ].filter((c): c is { label: string; value: string } => !!c);
}
