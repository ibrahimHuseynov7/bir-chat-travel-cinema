// Server-only data sources: CinemaPlus HTML tables, Birmarket category pages, Travelpayouts API.
import moviesJson from "@/data/movies.json";
import birmarketCategories from "@/data/birmarket-categories.json";
import {
  CINEMAS,
  aviasalesSearchUrl,
  type FlightData,
  type FlightQuery,
  type MovieInfo,
  type Product,
  type Session,
} from "./bir";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s?: string | null) =>
  (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;|\u00a0|\u202f|\u2009/gi, " ")
    .replace(/&#8380;|&#x20bc;/gi, "₼")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// Best-effort per-instance cache so repeat questions don't re-hit the sites.
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** dd.mm.yyyy in Baku time for an offset of days from today. */
export function bakuDate(offsetDays = 0) {
  const d = new Date(Date.now() + 4 * 3600_000 + offsetDays * 86400_000);
  return {
    iso: d.toISOString().slice(0, 10),
    dmy: `${d.toISOString().slice(8, 10)}.${d.toISOString().slice(5, 7)}.${d.toISOString().slice(0, 4)}`,
  };
}

export function parseCinemaHtml(html: string): Session[] {
  const out: Session[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<tr[^>]*data-date="([\d.]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...(m[2] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1] ?? "");
    if (tds.length < 6) continue;
    const fmt = clean(tds[4]);
    const [dd, mm, yyyy] = (m[1] ?? "").split(".");
    const s: Session = {
      movie: clean(tds[0]),
      movie_url: (tds[0] ?? "").match(/href="([^"]+)"/)?.[1] ?? null,
      time: clean(tds[1]),
      date: `${yyyy}-${mm}-${dd}`,
      hall: clean(tds[3]),
      format: fmt.match(/format:\s*(\w+)/i)?.[1] ?? null,
      language: fmt.match(/language:\s*(\w+)/i)?.[1] ?? null,
      az_subtitles: /subtitles/i.test(fmt),
      price_azn: Number(clean(tds[5]).match(/([\d.]+)\s*AZN/)?.[1]) || null,
    };
    const key = `${s.date}|${s.movie}|${s.time}|${s.hall}`;
    if (!s.movie || seen.has(key)) continue; // the page repeats its table
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

const CINEMA_TTL = 3 * 3600_000;
async function fetchCinema(slug: string): Promise<Session[]> {
  const res = await fetch(`https://cinemastercard.az/en/cinema/about-cinemaplus/${slug}/`, {
    headers: { "User-Agent": UA, "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`CinemaPlus answered ${res.status}`);
  return parseCinemaHtml(await res.text());
}

// Usually served from the background refresh; fetches one page on demand only if that hasn't run yet.
/** Sessions already in memory for a cinema (no fetching), or null. */
export function cachedCinemaSessions(slug: string): Session[] | null {
  return (cache.get(`cinema:${slug}`)?.value as Session[] | undefined) ?? null;
}

export function getCinemaSessionsAll(slug: string): Promise<Session[]> {
  if (!CINEMAS[slug]) throw new Error("Unknown cinema");
  return cached(`cinema:${slug}`, CINEMA_TTL, () => fetchCinema(slug));
}

/** Films in the cinema data we already hold (no fetching), with genres from the movie list when known. */
export function showingMovies(): { title: string; genres: string[] }[] {
  const titles = new Set<string>();
  for (const slug of Object.keys(CINEMAS)) {
    const hit = cache.get(`cinema:${slug}`)?.value as Session[] | undefined;
    for (const s of hit ?? []) titles.add(s.movie);
  }
  const info = movieInfoFor([...titles]);
  return [...titles].sort().map((title) => ({ title, genres: info[title]?.genres ?? [] }));
}

async function refreshCinemas() {
  for (const slug of Object.keys(CINEMAS)) {
    try {
      cache.set(`cinema:${slug}`, { at: Date.now(), value: await fetchCinema(slug) });
    } catch (e) {
      console.error("cinema refresh", slug, e);
    }
    await sleep(3000); // be polite: one cinema every 3 seconds
  }
}

// Movie pages are JSON-only behind a block, so movie details come from local mock data.
type RawMovie = {
  title: string;
  year: number;
  runtime_min: number;
  vote_average: number;
  age_rating: string;
  overview: string;
  genres: { name: string }[];
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яəğıöşüç]+/gi, "");
export function movieInfoFor(titles: string[]): Record<string, MovieInfo> {
  const list = moviesJson as unknown as RawMovie[];
  const out: Record<string, MovieInfo> = {};
  for (const t of titles) {
    const m = list.find(
      (x) => norm(x.title) === norm(t) || (norm(t).length > 4 && norm(x.title).startsWith(norm(t))),
    );
    if (m)
      out[t] = {
        title: m.title,
        year: m.year,
        runtime_min: m.runtime_min,
        vote_average: m.vote_average,
        age_rating: m.age_rating,
        overview: m.overview,
        genres: m.genres.map((g) => g.name),
      };
  }
  return out;
}

// All top-level categories from the birmarket.az home page. robots.txt disallows /search/, so we
// read category listings (?page=N is allowed), plus page 1 of each subcategory they link to.
const BIRMARKET_PAGES = 3;
const CATEGORIES = [
  "2-telefonlar-ve-aksessuarlar",
  "3-mobil-telefonlar-ve-smartfonlar",
  "15-noutbuklar-ve-komputer-texnikasi",
  "70-tv-audio-ve-video",
  "106-meishet-texnikasi",
  "204-foto-ve-videokameralar",
  "257-gozellik-ve-saglamliq",
  "516-idman-ve-feal-istirahet",
  "746-meishet-kimyevi-maddeler",
  "779-analar-ve-balalar-uchun",
  "937-ev-ve-bag-uchun-mehsullar",
  "1232-bag-ve-bostan",
  "1657-ofis-ve-mekteb-levazimatlari",
  "1708-avtomobil-uchun-mehsullar",
  "2164-ev-heyvanlari-uchun-mehsullar",
  "2266-aksessuarlar-saatlar-bezek-eshyalari",
  "2492-iri-baglamada-qida-mehsullari",
  "2627-temir-ve-tikinti",
  "3003-geyim-ve-ayaqqabi",
  "4835-oyunchular-uchun-mehsullar",
  "5224-saglamliq",
].map((c) => `https://birmarket.az/categories/${c}`);

// Prices look like "1 799.00 ₼" (thousands separated by a space, which can be a non-breaking space).
// The strict pattern keeps a number at the end of a product name ("... Series 11 GPS 42") out of the price.
const PRICE_RX = /(?<![\d.])(\d{1,3}(?: \d{3})*\.\d{2})\s*₼/g;

export function parseBirmarketHtml(html: string): Product[] {
  const items = new Map<string, Product>();
  for (const m of html.matchAll(
    /<a[^>]*href="([^"]*\/product\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
  )) {
    const href = m[1] ?? "",
      id = m[2] ?? "",
      inner = m[3] ?? "";
    const tag = m[0].slice(0, m[0].indexOf(">") + 1);
    const text = clean(inner);
    const prices = [...text.matchAll(PRICE_RX)].map((p) => Number((p[1] ?? "").replace(/\s/g, "")));
    if (!prices.length || items.has(id)) continue;
    const rating = text.match(/(\d(?:\.\d)?)\s+(\d+)\s+reytinq/);
    let name = clean(tag.match(/aria-label="([^"]+)"/)?.[1] ?? inner.match(/alt="([^"]+)"/)?.[1]);
    if (!name) {
      // Fallback: the text after the last price is the product name (then rating / seller badges).
      name = clean(
        text
          .split("₼")
          .pop()!
          .replace(/\d(?:\.\d)?\s+\d+\s+reytinq.*$/, "")
          .replace(/Rəsmi satıcı.*$/, ""),
      );
    }
    if (!name) continue;
    // Listing shows current (discounted) price first when a discount badge exists.
    const sorted = [...prices].sort((a, b) => a - b);
    items.set(id, {
      id,
      name,
      price_azn: sorted[0] ?? null,
      old_price:
        sorted.length > 1 && sorted[sorted.length - 1] !== sorted[0]
          ? (sorted[sorted.length - 1] ?? null)
          : null,
      rating: rating ? Number(rating[1]) : null,
      reviews: rating ? Number(rating[2]) : null,
      image_url: inner.match(/<img[^>]*src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null,
      url: new URL(href, "https://birmarket.az").toString(),
    });
  }
  return [...items.values()];
}

// Background Birmarket snapshot. Shopping also reads the matching category pages live (birmarketCategoryProducts).
const BIRMARKET_TTL = 6 * 3600_000;
let catalog: { at: number; products: Product[]; complete: boolean } | null = null;

async function refreshBirmarket() {
  const all = new Map<string, Product>();
  const queue = CATEGORIES.map((url) => ({ url, pages: BIRMARKET_PAGES }));
  const seen = new Set(CATEGORIES);
  for (const { url, pages } of queue) {
    for (let p = 1; p <= pages; p++) {
      try {
        const res = await fetch(p === 1 ? url : `${url}?page=${p}`, {
          headers: { "User-Agent": UA, "Accept-Language": "az" },
        });
        if (!res.ok) {
          console.error("birmarket", url, p, res.status);
          break;
        }
        const html = await res.text();
        for (const it of parseBirmarketHtml(html)) all.set(it.id, it);
        if (p === 1 && pages > 1) {
          for (const m of html.matchAll(/href="\/categories\/(\d+-[a-z0-9-]+)"/g)) {
            const sub = `https://birmarket.az/categories/${m[1]}`;
            if (!seen.has(sub)) {
              seen.add(sub);
              queue.push({ url: sub, pages: 1 });
            }
          }
        }
      } catch (e) {
        console.error("birmarket", url, p, e);
        break;
      }
      await sleep(1500);
    }
    // On the first run, publish partial results so shopping works before the full pass ends.
    if (!catalog?.complete)
      catalog = { at: Date.now(), products: [...all.values()], complete: false };
  }
  if (all.size) catalog = { at: Date.now(), products: [...all.values()], complete: true };
}

/** Current catalog snapshot, or null while the first refresh hasn't produced anything yet. */
export function getBirmarketProducts(): Product[] | null {
  return catalog?.products.length ? catalog.products : null;
}

let refreshing: Promise<void> | null = null;
let lastCinemaRefresh = 0;
/** Starts a background refresh of cinemas and Birmarket when their data is stale. Safe to call often. */
export function warmUp() {
  if (refreshing) return;
  const now = Date.now();
  const cinemasStale = now - lastCinemaRefresh > CINEMA_TTL;
  const shopStale = !catalog?.complete || now - catalog.at > BIRMARKET_TTL;
  if (!cinemasStale && !shopStale) return;
  if (cinemasStale) lastCinemaRefresh = now;
  refreshing = Promise.all([
    cinemasStale ? refreshCinemas() : null,
    shopStale ? refreshBirmarket() : null,
  ])
    .then(() => undefined)
    .finally(() => {
      refreshing = null;
    });
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "for",
  "me",
  "i",
  "want",
  "buy",
  "need",
  "show",
  "help",
  "shop",
  "gift",
  "under",
  "cheap",
  "best",
  "with",
  "and",
  "or",
  "to",
  "of",
  "new",
  "please",
  "almaq",
  "istəyirəm",
  "isteyirem",
  "lazımdır",
  "lazimdir",
  "üçün",
  "ucun",
  "mənə",
  "bir",
  "yeni",
  "ucuz",
  "azn",
  "manat",
  "₼",
]);
// Lead words of accessory listings ("Çexol Apple iPhone 16", "Qoruyucu şüşə ..."). When the user asks for a
// device ("iphone 16"), these rank below the device itself unless the query asks for the accessory.
const ACCESSORY = [
  "çexol",
  "cexol",
  "qoruyucu",
  "şüşə",
  "suse",
  "kabel",
  "adapter",
  "enerji",
  "şəbəkə",
  "stilus",
  "qayış",
  "qayis",
  "tutacaq",
  "plyonka",
  "örtük",
  "ortuk",
  "üzlük",
  "uzluk",
  "brelok",
  "linza",
  "pult",
  "dok",
  "stend",
  "kontakt",
];
const isAccessoryWord = (w: string) => ACCESSORY.some((a) => w.startsWith(a));
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\u0307/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export function searchProducts(
  all: Product[],
  query: string,
  minPrice: number | null,
  maxPrice: number | null,
): { products: Product[]; alternatives: Product[]; prices: number[] } {
  const qWords = words(query).filter((w) => w.length > 1 && !STOP.has(w));
  const wantsAccessory = qWords.some(isAccessoryWord);
  // Match from the start of a word, so "top" finds "top"/"topu" but not "laptop". Short words allow
  // only a short suffix, so "top" doesn't match "toplama". "X üçün" means "for X" (an accessory), so it doesn't count.
  const matches = (n: string, w: string) =>
    n.startsWith(w) && (w.length > 3 || n.length - w.length <= 2);
  const seen = new Set<string>();
  const scored = all.flatMap((p) => {
    if (p.price_azn == null || seen.has(p.id)) return [];
    seen.add(p.id);
    const nameWords = words(p.name);
    const hit = (w: string) =>
      nameWords.some((n, i) => matches(n, w) && nameWords[i + 1] !== "üçün");
    const matched = qWords.filter(hit).length;
    if (!matched) return [];
    // Names start with the product type ("Smartfon Apple ...", "Noutbuk HP ..."), so a matching type word ranks first.
    const lead = qWords.some((w) => matches(nameWords[0] ?? "", w) && nameWords[1] !== "üçün")
      ? 0.5
      : 0;
    const accessoryPenalty = !wantsAccessory && isAccessoryWord(nameWords[0] ?? "") ? 1.5 : 0;
    // All query words present (e.g. "iphone" + "16") beats a partial match.
    const complete = matched === qWords.length ? 0.75 : 0;
    return [{ p, s: matched + lead + complete - accessoryPenalty, price: p.price_azn }];
  });
  const quality = (p: Product) => (p.rating ?? 0) * Math.log10(10 + (p.reviews ?? 0));
  const byRelevance = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    b.s - a.s || quality(b.p) - quality(a.p);
  const top = Math.max(0, ...scored.map((x) => x.s));
  // Keep only results close to the best match, so "iphone 16" doesn't list every smartphone.
  const relevant = scored.filter((x) => x.s >= top - 1 && x.s > 0);

  const products = relevant
    .filter(
      (x) => (minPrice == null || x.price >= minPrice) && (maxPrice == null || x.price <= maxPrice),
    )
    .sort(byRelevance)
    .slice(0, 6);

  // Cheaper alternatives: equally relevant products below the cheapest result (or below the requested range),
  // preferring ones that aren't far cheaper, so a 1000 ₼ phone suggests 600-999 ₼ phones rather than 0.13 ₼ pins.
  const ref = products.length ? Math.min(...products.map((x) => x.price)) : (minPrice ?? maxPrice);
  const shown = new Set(products.map((x) => x.p.id));
  // Alternatives may be a little less specific (iPhone 15 when iPhone 16 is over budget), never accessories.
  const looser = scored.filter((x) => x.s >= top - 2 && x.s > 0.5);
  const cheaper = ref == null ? [] : looser.filter((x) => x.price < ref && !shown.has(x.p.id));
  const near = cheaper.filter((x) => x.price >= ref! * 0.4);
  const alternatives = (near.length >= 2 ? near : cheaper).sort(byRelevance).slice(0, 4);

  return {
    products: products.map((x) => x.p),
    alternatives: alternatives.map((x) => x.p),
    // Prices of every relevant product before the price filter, for the price-range filter chips.
    prices: relevant.map((x) => x.price),
  };
}

// ---------- live Birmarket lookups (tag and brand listing pages) ----------
// The background snapshot covers only the first pages of each category, so a specific model (e.g. an iPhone)
// is often missing. Birmarket has server-rendered listing pages per tag (/tags/iphone-16) and per brand
// (/brands/APPLE) that robots.txt allows (the /search/ path is disallowed and never used). One query reads
// at most a few of these pages, in parallel, cached for 30 minutes.
const BRANDS = [
  "apple",
  "samsung",
  "xiaomi",
  "redmi",
  "poco",
  "huawei",
  "honor",
  "oppo",
  "vivo",
  "realme",
  "tecno",
  "infinix",
  "nokia",
  "motorola",
  "google",
  "oneplus",
  "sony",
  "lg",
  "jbl",
  "marshall",
  "hp",
  "lenovo",
  "asus",
  "acer",
  "dell",
  "msi",
  "philips",
  "bosch",
  "tefal",
  "braun",
  "dyson",
  "rowenta",
  "beko",
  "nike",
  "adidas",
  "puma",
  "samsonite",
  "lego",
  "canon",
  "nikon",
  "garmin",
  "anker",
  "logitech",
  "playstation",
  "nintendo",
  "dji",
  "gopro",
];
const TYPE_WORDS = new Set([
  "smartfon",
  "smartfonlar",
  "telefon",
  "telefonlar",
  "mobil",
  "noutbuk",
  "notbuk",
  "planşet",
  "planset",
  "qulaqlıq",
  "qulaqliq",
  "saat",
  "televizor",
  "çamadan",
  "camadan",
]);
const LIVE_TTL = 30 * 60_000;
const slugify = (ws: string[]) => ws.join("-").replace(/[^a-z0-9-]/g, "");

async function fetchListing(url: string): Promise<Product[]> {
  return cached(`bm:${url}`, LIVE_TTL, async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "az" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return [];
      return parseBirmarketHtml(await res.text());
    } catch {
      return [];
    }
  });
}

/** Listing URLs worth reading for a query: tag pages from the model words, then the brand page. */
export function birmarketLiveUrls(query: string): string[] {
  const ws = words(query).filter((w) => !STOP.has(w) && !TYPE_WORDS.has(w));
  const ascii = ws.filter((w) => /^[a-z0-9]+$/.test(w));
  if (!ascii.length) return [];
  const brand = ascii.find((w) => BRANDS.includes(w));
  const model = ascii.filter((w) => w !== brand);
  const tags: string[] = [];
  for (let n = Math.min(model.length, 3); n >= 1; n--) tags.push(slugify(model.slice(0, n)));
  if (brand && model.length) tags.push(slugify([brand, ...model.slice(0, 2)]));
  if (!model.length && brand) tags.push(brand);
  const urls = [...new Set(tags.filter(Boolean))]
    .slice(0, 3)
    .map((t) => `https://birmarket.az/tags/${t}`);
  if (brand) urls.push(`https://birmarket.az/brands/${brand.toUpperCase()}`);
  return urls;
}

/** Products from live listing pages for this query (empty when disabled or nothing found). */
export async function birmarketLiveSearch(
  query: string,
): Promise<{ products: Product[]; urls: string[] }> {
  const urls = birmarketLiveUrls(query);
  if (!urls.length) return { products: [], urls: [] };
  const lists = await Promise.all(urls.map(fetchListing));
  const used = urls.filter((_, i) => lists[i]!.length);
  return { products: lists.flat(), urls: used };
}

// Category index (slug, Azerbaijani name, parent) built once from birmarket.az ?view=categories pages, which
// robots.txt allows. Lets any product word go straight to its category listing, without the catalog snapshot.
export type BirmarketCategory = { slug: string; name: string; parent: string | null };
export const BIRMARKET_CATEGORIES = birmarketCategories as BirmarketCategory[];
/** Folds Azerbaijani letters and Birmarket's slug spelling to one form: "çamadan", "camadan", "chamadan" -> "camadan". */
const fold = (w: string) =>
  w
    .replace(/ç/g, "c").replace(/ş/g, "s").replace(/ə/g, "e").replace(/ı/g, "i")
    .replace(/ö/g, "o").replace(/ü/g, "u").replace(/ğ/g, "g").replace(/ch/g, "c").replace(/sh/g, "s").replace(/ou/g, "o"); // "noutbuk" = "notbuk"
const catDepth = (() => {
  const parent = new Map(BIRMARKET_CATEGORIES.map((c) => [c.slug, c.parent]));
  const depth = (slug: string, n = 0): number => (n > 6 || !parent.get(slug) ? n : depth(parent.get(slug)!, n + 1));
  return new Map(BIRMARKET_CATEGORIES.map((c) => [c.slug, depth(c.slug)]));
})();
const CAT_FILLER = new Set(["ve", "vs", "ile", "diger", "her", "sey"]);
const CAT_WORDS = BIRMARKET_CATEGORIES.map((c) => {
  const slugWs = c.slug.replace(/^\d+-/, "").split("-").map(fold);
  const nameWs = words(c.name).map(fold);
  // "X üçün" (for X) marks an accessory category ("Notbuklar üçün çantalar"); X itself is not what it sells.
  const forWhat = new Set([slugWs, nameWs].flatMap((ws) => ws.filter((w, i) => ws[i + 1] === "ucun")));
  const keep = (ws: string[]) => [...new Set(ws)].filter((w) => w.length > 1 && !CAT_FILLER.has(w) && w !== "ucun");
  return { c, slugWs: keep(slugWs), nameWs: keep(nameWs), forWhat };
});
/** Same word allowing Azerbaijani endings on either side: "camadan" ~ "camadanlari", "telefonlar" ~ "telefon". */
// Endings are at most 5 letters, so a compound ("qəhvəüyüdənləri", coffee grinders) is not "qəhvə" + ending.
const sameStem = (a: string, b: string) => {
  const short = Math.min(a.length, b.length);
  if (Math.abs(a.length - b.length) > 5) return false;
  let i = 0;
  while (i < short && a[i] === b[i]) i++;
  return i >= 4 && i >= short - 2; // "maşını" ~ "maşınları", "telefon" ~ "telefonlar"
};

/**
 * Categories for product words. `confident`: categories whose whole name is covered by the words
 * ("çamadan" -> "Çamadanlar"), safe to use directly. `candidates`: the closest partial matches, for the
 * model to choose from. Accessory categories ("... üçün çexollar") only count when the words ask for one.
 */
export function birmarketCategoryMatch(query: string): {
  confident: BirmarketCategory[];
  candidates: BirmarketCategory[];
} {
  const qs = words(query).filter((w) => w.length > 2 && !STOP.has(w)).map(fold);
  if (!qs.length) return { confident: [], candidates: [] };
  const wantsAccessory = words(query).some(isAccessoryWord) || qs.includes("ucun");
  const scored = CAT_WORDS.flatMap(({ c, slugWs, nameWs, forWhat }) => {
    const hitQ = qs.filter((q) => [...slugWs, ...nameWs].some((w) => sameStem(q, w)));
    if (!hitQ.length) return [];
    if (!wantsAccessory && hitQ.every((q) => [...forWhat].some((w) => sameStem(q, w)))) return [];
    // The display name says what the category sells (slugs are sometimes stale), so coverage uses the name.
    const ws = nameWs.length ? nameWs : slugWs;
    const coverage = ws.filter((w) => qs.some((q) => sameStem(q, w))).length / ws.length;
    const depth = catDepth.get(c.slug) ?? 0;
    return [{ c, hits: hitQ.length, full: coverage === 1, s: hitQ.length / qs.length + coverage + depth * 0.05 }];
  });
  scored.sort((a, b) => b.s - a.s);
  // Confident only if no other category explains more of the words ("qəhvə maşını" is not just "Qəhvə").
  const maxHits = Math.max(0, ...scored.map((x) => x.hits));
  const full = scored.filter((x) => x.full && x.hits === maxHits);
  const bestFull = Math.max(0, ...full.map((x) => x.s));
  return {
    confident: full.filter((x) => x.s >= bestFull - 0.01).slice(0, 2).map((x) => x.c),
    candidates: scored.slice(0, 40).map((x) => x.c),
  };
}

/** Categories up to `maxDepth` levels deep, for the model to choose from when no category name matches. */
export function birmarketCategoryChoices(maxDepth = 1): BirmarketCategory[] {
  return BIRMARKET_CATEGORIES.filter((c) => (catDepth.get(c.slug) ?? 0) <= maxDepth && c.name);
}

/** Products from the first listing page of each category (fetched in parallel, cached 30 min). */
export async function birmarketCategoryProducts(slugs: string[]): Promise<Product[]> {
  const lists = await Promise.all(slugs.map((s) => fetchListing(`https://birmarket.az/categories/${s}`)));
  return lists.flat();
}

export async function searchFlights(q: FlightQuery): Promise<FlightData> {
  const marker = process.env["TRAVELPAYOUTS_MARKER"] || "";
  const token = process.env["TRAVELPAYOUTS_TOKEN"];
  const withMarker = (path: string) =>
    "https://www.aviasales.com" +
    path +
    (marker ? (path.includes("?") ? "&" : "?") + "marker=" + marker : "");
  // Without a valid route, still send the user to AviaSales to search there.
  if (!/^[A-Z]{3}$/.test(q.destination) || !/^[A-Z]{3}$/.test(q.origin))
    return { ...q, search_url: withMarker("/"), offers: [] };
  const search_url = aviasalesSearchUrl(q, marker);
  if (!token) return { ...q, search_url, offers: [], error: "Flight prices are not configured." };
  const run = async (depart: string, ret: string, market?: string) => {
    const params = new URLSearchParams({
      origin: q.origin,
      destination: q.destination,
      one_way: q.return ? "false" : "true",
      sorting: "price",
      currency: "usd",
      limit: "10",
      token,
    });
    if (depart) params.set("departure_at", depart);
    if (ret) params.set("return_at", ret);
    if (market) params.set("market", market);
    const r = await fetch(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`);
    if (!r.ok) throw new Error(`Aviasales answered ${r.status}`);
    const body = (await r.json()) as { data?: Record<string, unknown>[] };
    return body.data ?? [];
  };
  try {
    // The cache is per market; exact dates from Baku are usually only cached in the "az" market.
    let rows: Record<string, unknown>[] = [];
    for (const market of ["az", undefined, "ru"]) {
      rows = await run(q.depart, q.return, market);
      if (rows.length) break;
    }
    // Nothing for the exact dates: show the cheapest dates in the same month(s) instead.
    let nearby = false;
    if (!rows.length && (q.depart.length === 10 || q.return.length === 10)) {
      rows = await run(q.depart.slice(0, 7), q.return.slice(0, 7), "az");
      nearby = rows.length > 0;
    }
    const offers = rows.slice(0, 5).map((f) => ({
      price_usd: Number(f["price"]),
      airline: String(f["airline"] ?? ""),
      flight_number: String(f["flight_number"] ?? ""),
      departure_at: String(f["departure_at"] ?? ""),
      return_at: (f["return_at"] as string) ?? null,
      transfers: Number(f["transfers"] ?? 0),
      duration_min: Number(f["duration"] ?? 0),
      // Cached links are for 1 passenger: the last digit of the /search/ path is the passenger count.
      link: f["link"]
        ? withMarker(
            String(f["link"]).replace(
              /^(\/search\/[A-Z]{3}\d{4}[A-Z]{3}(?:\d{4})?)\d/,
              `$1${q.adults}`,
            ),
          )
        : search_url,
    }));
    return { ...q, search_url, offers, nearby };
  } catch (e) {
    console.error("flights", e);
    return {
      ...q,
      search_url,
      offers: [],
      error: "Live prices are unavailable right now. Open AviaSales to see current prices.",
    };
  }
}
