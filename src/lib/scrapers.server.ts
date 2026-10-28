// Server-only data sources: CinemaPlus HTML tables, Birmarket category pages, Travelpayouts API.
import moviesJson from "@/data/movies.json";
import { CINEMAS, aviasalesSearchUrl, type FlightData, type FlightQuery, type MovieInfo, type Product, type Session } from "./bir";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
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
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 6) continue;
    const fmt = clean(tds[4]);
    const [dd, mm, yyyy] = m[1].split(".");
    const s: Session = {
      movie: clean(tds[0]),
      movie_url: tds[0].match(/href="([^"]+)"/)?.[1] ?? null,
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

export function getCinemaSessionsAll(slug: string): Promise<Session[]> {
  if (!CINEMAS[slug]) throw new Error("Unknown cinema");
  return cached(`cinema:${slug}`, 30 * 60_000, async () => {
    const res = await fetch(`https://cinemastercard.az/en/cinema/about-cinemaplus/${slug}/`, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    if (!res.ok) throw new Error(`CinemaPlus answered ${res.status}`);
    return parseCinemaHtml(await res.text());
  });
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

const CATEGORIES = [
  { url: "https://birmarket.az/categories/3-mobil-telefonlar-ve-smartfonlar", label: "Phones", pages: 2 },
  { url: "https://birmarket.az/categories/2-telefonlar-ve-aksessuarlar", label: "Phones & accessories", pages: 2 },
];

export function parseBirmarketHtml(html: string): Product[] {
  const items = new Map<string, Product>();
  for (const m of html.matchAll(/<a[^>]*href="([^"]*\/product\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const [, href, id, inner] = m;
    const tag = m[0].slice(0, m[0].indexOf(">") + 1);
    const text = clean(inner);
    const prices = [...text.matchAll(/([\d ]+\.\d{2})\s*₼/g)].map((p) => Number(p[1].replace(/\s/g, "")));
    if (!prices.length || items.has(id)) continue;
    const rating = text.match(/(\d\.\d)\s+(\d+)\s+reytinq/);
    const name = clean(tag.match(/aria-label="([^"]+)"/)?.[1] ?? inner.match(/alt="([^"]+)"/)?.[1]);
    // Listing shows current (discounted) price first when a discount badge exists.
    const sorted = [...prices].sort((a, b) => a - b);
    items.set(id, {
      id, name,
      price_azn: sorted[0],
      old_price: sorted.length > 1 && sorted[sorted.length - 1] !== sorted[0] ? sorted[sorted.length - 1] : null,
      rating: rating ? Number(rating[1]) : null,
      reviews: rating ? Number(rating[2]) : null,
      image_url: inner.match(/<img[^>]*src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null,
      url: new URL(href, "https://birmarket.az").toString(),
    });
  }
  return [...items.values()];
}

export function getBirmarketProducts(): Promise<Product[]> {
  return cached("birmarket", 6 * 3600_000, async () => {
    const all = new Map<string, Product>();
    for (const cat of CATEGORIES) {
      for (let p = 1; p <= cat.pages; p++) {
        const res = await fetch(p === 1 ? cat.url : `${cat.url}?page=${p}`, { headers: { "User-Agent": UA, "Accept-Language": "az" } });
        if (!res.ok) break;
        for (const it of parseBirmarketHtml(await res.text())) all.set(it.id, it);
      }
    }
    if (!all.size) throw new Error("Birmarket returned no products");
    return [...all.values()];
  });
}

const STOP = new Set(["the", "a", "for", "me", "i", "want", "buy", "need", "show", "help", "shop", "gift", "under", "cheap", "best", "with", "and", "or", "to", "of", "almaq", "istəyirəm", "üçün"]);
export function searchProducts(all: Product[], query: string, maxPrice: number | null): Product[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
  const pool = all.filter((p) => maxPrice == null || (p.price_azn ?? Infinity) <= maxPrice);
  const scored = pool.map((p) => ({ p, s: words.filter((w) => p.name.toLowerCase().includes(w)).length }));
  const hits = scored.filter((x) => x.s > 0);
  const base = hits.length ? hits : scored;
  return base
    .sort((a, b) => b.s - a.s || (b.p.rating ?? 0) - (a.p.rating ?? 0) || (b.p.reviews ?? 0) - (a.p.reviews ?? 0))
    .slice(0, 6).map((x) => x.p);
}

export async function searchFlights(q: FlightQuery): Promise<FlightData> {
  const marker = process.env["TRAVELPAYOUTS_MARKER"] || "";
  const token = process.env["TRAVELPAYOUTS_TOKEN"];
  if (!/^[A-Z]{3}$/.test(q.destination) || !/^[A-Z]{3}$/.test(q.origin)) return { ...q, search_url: null, offers: [] };
  const search_url = aviasalesSearchUrl(q, marker);
  const withMarker = (path: string) => "https://www.aviasales.com" + path + (marker ? (path.includes("?") ? "&" : "?") + "marker=" + marker : "");
  if (!token) return { ...q, search_url, offers: [], error: "Flight prices are not configured." };
  const run = async (market?: string) => {
    const params = new URLSearchParams({ origin: q.origin, destination: q.destination, one_way: q.return ? "false" : "true", sorting: "price", currency: "usd", limit: "10", token });
    if (q.depart) params.set("departure_at", q.depart);
    if (q.return) params.set("return_at", q.return);
    if (market) params.set("market", market);
    const r = await fetch(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`);
    if (!r.ok) throw new Error(`Aviasales answered ${r.status}`);
    const body = (await r.json()) as { data?: Record<string, unknown>[] };
    return body.data ?? [];
  };
  try {
    let rows = await run();
    if (!rows.length) rows = await run("ru");
    const offers = rows.slice(0, 5).map((f) => ({
      price_usd: Number(f.price), airline: String(f.airline ?? ""), flight_number: String(f.flight_number ?? ""),
      departure_at: String(f.departure_at ?? ""), return_at: (f.return_at as string) ?? null,
      transfers: Number(f.transfers ?? 0), duration_min: Number(f.duration ?? 0),
      link: f.link ? withMarker(String(f.link)) : search_url,
    }));
    return { ...q, search_url, offers };
  } catch (e) {
    console.error("flights", e);
    return { ...q, search_url, offers: [], error: "Live prices are unavailable right now." };
  }
}
