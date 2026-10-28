// Server-only data sources: CinemaPlus HTML tables, Birmarket category pages, Travelpayouts API.
import moviesJson from "@/data/movies.json";
import { CINEMAS, aviasalesSearchUrl, type FlightData, type FlightQuery, type MovieInfo, type Product, type Session } from "./bir";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s?: string | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

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
  return { iso: d.toISOString().slice(0, 10), dmy: `${d.toISOString().slice(8, 10)}.${d.toISOString().slice(5, 7)}.${d.toISOString().slice(0, 4)}` };
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
  const res = await fetch(`https://cinemastercard.az/en/cinema/about-cinemaplus/${slug}/`, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`CinemaPlus answered ${res.status}`);
  return parseCinemaHtml(await res.text());
}

// Usually served from the background refresh; fetches one page on demand only if that hasn't run yet.
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
type RawMovie = { title: string; year: number; runtime_min: number; vote_average: number; age_rating: string; overview: string; genres: { name: string }[] };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яəğıöşüç]+/gi, "");
export function movieInfoFor(titles: string[]): Record<string, MovieInfo> {
  const list = moviesJson as unknown as RawMovie[];
  const out: Record<string, MovieInfo> = {};
  for (const t of titles) {
    const m = list.find((x) => norm(x.title) === norm(t) || (norm(t).length > 4 && norm(x.title).startsWith(norm(t))));
    if (m) out[t] = { title: m.title, year: m.year, runtime_min: m.runtime_min, vote_average: m.vote_average, age_rating: m.age_rating, overview: m.overview, genres: m.genres.map((g) => g.name) };
  }
  return out;
}

// All top-level categories from the birmarket.az home page. robots.txt disallows /search/, so we
// read category listings (?page=N is allowed), plus page 1 of each subcategory they link to.
const BIRMARKET_PAGES = 3;
const CATEGORIES = [
  "2-telefonlar-ve-aksessuarlar", "3-mobil-telefonlar-ve-smartfonlar", "15-noutbuklar-ve-komputer-texnikasi",
  "70-tv-audio-ve-video", "106-meishet-texnikasi", "204-foto-ve-videokameralar", "257-gozellik-ve-saglamliq",
  "516-idman-ve-feal-istirahet", "746-meishet-kimyevi-maddeler", "779-analar-ve-balalar-uchun",
  "937-ev-ve-bag-uchun-mehsullar", "1232-bag-ve-bostan", "1657-ofis-ve-mekteb-levazimatlari",
  "1708-avtomobil-uchun-mehsullar", "2164-ev-heyvanlari-uchun-mehsullar", "2266-aksessuarlar-saatlar-bezek-eshyalari",
  "2492-iri-baglamada-qida-mehsullari", "2627-temir-ve-tikinti", "3003-geyim-ve-ayaqqabi",
  "4835-oyunchular-uchun-mehsullar", "5224-saglamliq",
].map((c) => `https://birmarket.az/categories/${c}`);

export function parseBirmarketHtml(html: string): Product[] {
  const items = new Map<string, Product>();
  for (const m of html.matchAll(/<a[^>]*href="([^"]*\/product\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1] ?? "", id = m[2] ?? "", inner = m[3] ?? "";
    const tag = m[0].slice(0, m[0].indexOf(">") + 1);
    const text = clean(inner);
    const prices = [...text.matchAll(/([\d ]+\.\d{2})\s*₼/g)].map((p) => Number((p[1] ?? "").replace(/\s/g, "")));
    if (!prices.length || items.has(id)) continue;
    const rating = text.match(/(\d\.\d)\s+(\d+)\s+reytinq/);
    const name = clean(tag.match(/aria-label="([^"]+)"/)?.[1] ?? inner.match(/alt="([^"]+)"/)?.[1]);
    // Listing shows current (discounted) price first when a discount badge exists.
    const sorted = [...prices].sort((a, b) => a - b);
    items.set(id, {
      id, name,
      price_azn: sorted[0] ?? null,
      old_price: sorted.length > 1 && sorted[sorted.length - 1] !== sorted[0] ? (sorted[sorted.length - 1] ?? null) : null,
      rating: rating ? Number(rating[1]) : null,
      reviews: rating ? Number(rating[2]) : null,
      image_url: inner.match(/<img[^>]*src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null,
      url: new URL(href, "https://birmarket.az").toString(),
    });
  }
  return [...items.values()];
}

// Birmarket catalog is only ever read from this snapshot; the chat never scrapes while a user waits.
const BIRMARKET_TTL = 6 * 3600_000;
let catalog: { at: number; products: Product[]; complete: boolean } | null = null;

async function refreshBirmarket() {
  const all = new Map<string, Product>();
  const queue = CATEGORIES.map((url) => ({ url, pages: BIRMARKET_PAGES }));
  const seen = new Set(CATEGORIES);
  for (const { url, pages } of queue) {
    for (let p = 1; p <= pages; p++) {
      try {
        const res = await fetch(p === 1 ? url : `${url}?page=${p}`, { headers: { "User-Agent": UA, "Accept-Language": "az" } });
        if (!res.ok) { console.error("birmarket", url, p, res.status); break; }
        const html = await res.text();
        for (const it of parseBirmarketHtml(html)) all.set(it.id, it);
        if (p === 1 && pages > 1) {
          for (const m of html.matchAll(/href="\/categories\/(\d+-[a-z0-9-]+)"/g)) {
            const sub = `https://birmarket.az/categories/${m[1]}`;
            if (!seen.has(sub)) { seen.add(sub); queue.push({ url: sub, pages: 1 }); }
          }
        }
      } catch (e) {
        console.error("birmarket", url, p, e);
        break;
      }
      await sleep(1500);
    }
    // On the first run, publish partial results so shopping works before the full pass ends.
    if (!catalog?.complete) catalog = { at: Date.now(), products: [...all.values()], complete: false };
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
  refreshing = Promise.all([cinemasStale ? refreshCinemas() : null, shopStale ? refreshBirmarket() : null])
    .then(() => undefined)
    .finally(() => { refreshing = null; });
}

const STOP = new Set(["the", "a", "for", "me", "i", "want", "buy", "need", "show", "help", "shop", "gift", "under", "cheap", "best", "with", "and", "or", "to", "of", "almaq", "istəyirəm", "üçün"]);
export function searchProducts(all: Product[], query: string, minPrice: number | null, maxPrice: number | null): { products: Product[]; alternatives: Product[] } {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
  // Match from the start of a word, so "top" finds "top"/"topu" but not "laptop". Short words allow
  // only a short suffix, so "top" doesn't match "toplama". "X üçün" means "for X" (an accessory), so it doesn't count.
  const matches = (n: string, w: string) => n.startsWith(w) && (w.length > 3 || n.length - w.length <= 2);
  const scored = all.flatMap((p) => {
    if (p.price_azn == null) return [];
    const nameWords = p.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const hit = (w: string) => nameWords.some((n, i) => matches(n, w) && nameWords[i + 1] !== "üçün");
    const s = words.filter(hit).length;
    // Names start with the product type ("Noutbuk HP ..."), so rank those first.
    const lead = s && words.some((w) => matches(nameWords[0] ?? "", w) && nameWords[1] !== "üçün") ? 0.5 : 0;
    return s ? [{ p, s: s + lead, price: p.price_azn }] : [];
  });
  const quality = (p: Product) => (p.rating ?? 0) * Math.log10(10 + (p.reviews ?? 0));
  const byRelevance = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.s - a.s || quality(b.p) - quality(a.p);

  const products = scored
    .filter((x) => (minPrice == null || x.price >= minPrice) && (maxPrice == null || x.price <= maxPrice))
    .sort(byRelevance).slice(0, 6);

  // Cheaper alternatives: equally relevant products below the cheapest result (or below the requested range),
  // preferring ones that aren't far cheaper, so a 1000 ₼ phone suggests 600-999 ₼ phones rather than 0.13 ₼ pins.
  const ref = products.length ? Math.min(...products.map((x) => x.price)) : minPrice;
  const best = products[0]?.s ?? Math.max(0, ...scored.map((x) => x.s));
  const shown = new Set(products.map((x) => x.p.id));
  const cheaper = ref == null ? [] : scored.filter((x) => x.price < ref && x.s >= Math.floor(best) && !shown.has(x.p.id));
  const near = cheaper.filter((x) => x.price >= ref! * 0.4);
  const alternatives = (near.length >= 2 ? near : cheaper).sort(byRelevance).slice(0, 4);

  return { products: products.map((x) => x.p), alternatives: alternatives.map((x) => x.p) };
}

export async function searchFlights(q: FlightQuery): Promise<FlightData> {
  const marker = process.env["TRAVELPAYOUTS_MARKER"] || "";
  const token = process.env["TRAVELPAYOUTS_TOKEN"];
  const withMarker = (path: string) => "https://www.aviasales.com" + path + (marker ? (path.includes("?") ? "&" : "?") + "marker=" + marker : "");
  // Without a valid route, still send the user to AviaSales to search there.
  if (!/^[A-Z]{3}$/.test(q.destination) || !/^[A-Z]{3}$/.test(q.origin)) return { ...q, search_url: withMarker("/"), offers: [] };
  const search_url = aviasalesSearchUrl(q, marker);
  if (!token) return { ...q, search_url, offers: [], error: "Flight prices are not configured." };
  const run = async (depart: string, ret: string, market?: string) => {
    const params = new URLSearchParams({ origin: q.origin, destination: q.destination, one_way: q.return ? "false" : "true", sorting: "price", currency: "usd", limit: "10", token });
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
      price_usd: Number(f["price"]), airline: String(f["airline"] ?? ""), flight_number: String(f["flight_number"] ?? ""),
      departure_at: String(f["departure_at"] ?? ""), return_at: (f["return_at"] as string) ?? null,
      transfers: Number(f["transfers"] ?? 0), duration_min: Number(f["duration"] ?? 0),
      // Cached links are for 1 passenger: the last digit of the /search/ path is the passenger count.
      link: f["link"] ? withMarker(String(f["link"]).replace(/^(\/search\/[A-Z]{3}\d{4}[A-Z]{3}(?:\d{4})?)\d/, `$1${q.adults}`)) : search_url,
    }));
    return { ...q, search_url, offers, nearby };
  } catch (e) {
    console.error("flights", e);
    return { ...q, search_url, offers: [], error: "Live prices are unavailable right now. Open AviaSales to see current prices." };
  }
}
