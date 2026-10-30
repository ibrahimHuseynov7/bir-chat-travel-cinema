// Flights: Travelpayouts (Aviasales) Data API, turned into ready-to-show flight items in code.
// - Any city or airport name (any language) or IATA code is resolved with the Aviasales autocomplete API.
// - Departure AND arrival local times (arrival in the destination airport's time zone), duration, stops.
// - Direct and transit options are both fetched; filters for earlier/later, direct only, max price.
// All values on an item come from the API response; nothing is written by the model.
import { CITIES, lower } from "@/lib/bir";
import { CONFIG } from "../config";
import type { Item } from "../core/schemas";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

// ---------- small TTL cache ----------
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

// ---------- reference data (airports with time zones, airline names) ----------
type Airport = { code: string; name: string; city_code: string; country_code: string; tz: string };
let airportsP: Promise<Map<string, Airport>> | null = null;
let airlinesP: Promise<Map<string, string>> | null = null;

function airports(): Promise<Map<string, Airport>> {
  airportsP ??= (async () => {
    const res = await fetch("https://api.travelpayouts.com/data/en/airports.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`airports.json ${res.status}`);
    const rows = (await res.json()) as Record<string, unknown>[];
    const m = new Map<string, Airport>();
    for (const r of rows) {
      const code = String(r["code"] ?? "");
      if (!/^[A-Z]{3}$/.test(code)) continue;
      if (r["iata_type"] && r["iata_type"] !== "airport") continue;
      m.set(code, {
        code,
        name: String(r["name"] ?? code),
        city_code: String(r["city_code"] ?? code),
        country_code: String(r["country_code"] ?? ""),
        tz: String(r["time_zone"] ?? ""),
      });
    }
    return m;
  })().catch((e) => {
    airportsP = null; // try again next time
    throw e;
  });
  return airportsP;
}
function airlines(): Promise<Map<string, string>> {
  airlinesP ??= (async () => {
    const res = await fetch("https://api.travelpayouts.com/data/en/airlines.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`airlines.json ${res.status}`);
    const rows = (await res.json()) as Record<string, unknown>[];
    const m = new Map<string, string>();
    for (const r of rows) {
      const code = String(r["code"] ?? "");
      const tr = r["name_translations"] as Record<string, string> | undefined;
      const name = String(r["name"] ?? tr?.["en"] ?? "");
      if (code && name) m.set(code, name);
    }
    return m;
  })().catch((e) => {
    airlinesP = null;
    throw e;
  });
  return airlinesP;
}

/** Loads the reference lists in the background so the first flight search of a server instance needn't wait. */
export function warmFlightData() {
  airports().catch(() => {});
  airlines().catch(() => {});
}

// ---------- place resolution ----------
export type Place = {
  code: string;
  type: "city" | "airport";
  name: string;
  city_code: string;
  city_name: string;
  country_code: string;
};

async function autocomplete(term: string): Promise<Place[]> {
  return cached(`ac:${lower(term)}`, 24 * 3600_000, async () => {
    const url =
      "https://autocomplete.travelpayouts.com/places2?locale=en&types[]=city&types[]=airport&term=" +
      encodeURIComponent(term);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`autocomplete ${res.status}`);
    const rows = (await res.json()) as Record<string, unknown>[];
    return rows
      .filter((r) => r["type"] === "city" || r["type"] === "airport")
      .map((r) => ({
        code: String(r["code"] ?? ""),
        type: r["type"] as "city" | "airport",
        name: String(r["name"] ?? ""),
        city_code: String(r["city_code"] ?? r["code"] ?? ""),
        city_name: String(r["city_name"] ?? r["name"] ?? ""),
        country_code: String(r["country_code"] ?? ""),
      }))
      .filter((p) => /^[A-Z]{3}$/.test(p.code));
  });
}

/** City or airport name in any language, or an IATA code -> Place. null when unknown. */
export async function resolvePlace(raw: string): Promise<Place | null> {
  const v = raw.trim().replace(/\s*\(([A-Z]{3})\)\s*$/, " $1"); // "Milan Malpensa (MXP)" -> "... MXP"
  if (!v) return null;
  const code = v.match(/\b([A-Z]{3})\b/)?.[1];
  const term = code ?? v;
  const found = await withTimeout(autocomplete(term), 6_000, [] as Place[]);
  if (code) {
    const exact = found.find((p) => p.code === code);
    if (exact) return exact;
    const ap = (await withTimeout(airports(), 4_000, new Map<string, Airport>())).get(code);
    if (ap)
      return {
        code,
        type: "airport",
        name: ap.name,
        city_code: ap.city_code,
        city_name: ap.city_code,
        country_code: ap.country_code,
      };
    return { code, type: "city", name: code, city_code: code, city_name: code, country_code: "" };
  }
  if (found[0]) {
    // An airport word in the text ("Malpensa", "airport") -> prefer the airport match.
    const wantsAirport = /airport|aeroport|аэропорт|hava limanı|havalimanı/i.test(v);
    const ap = found.find((p) => p.type === "airport");
    return wantsAirport && ap ? ap : found[0];
  }
  const local = CITIES[lower(v)];
  return local
    ? { code: local, type: "city", name: v, city_code: local, city_name: v, country_code: "" }
    : null;
}

/** Airports with flights in a city (for "which airport?" chips). */
export async function cityAirports(cityCode: string): Promise<{ code: string; name: string }[]> {
  const all = await withTimeout(airports(), 4_000, new Map<string, Airport>());
  return [...all.values()]
    .filter((a) => a.city_code === cityCode)
    .map((a) => ({ code: a.code, name: a.name }));
}

// ---------- time helpers ----------
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (t: string) => {
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const durationLabel = (min: number) =>
  min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : "";

/** "2026-11-14T06:40:00+04:00" -> local date/time exactly as the airline publishes it. */
function localParts(iso: string): { date: string; time: string; offsetMin: number } | null {
  const m = iso.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|([+-])(\d{2}):?(\d{2}))?$/,
  );
  if (!m) return null;
  const offsetMin =
    !m[4] || m[4] === "Z" ? 0 : (m[5] === "-" ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7]));
  return { date: m[1]!, time: `${m[2]}:${m[3]}`, offsetMin };
}
/** Local date/time of an instant in an IANA time zone. */
function inZone(ms: number, tz: string): { date: string; time: string } | null {
  try {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ms));
    const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
    return {
      date: `${g("year")}-${g("month")}-${g("day")}`,
      time: `${g("hour").replace("24", "00")}:${g("minute")}`,
    };
  } catch {
    return null;
  }
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ---------- search ----------
export interface FlightSearch {
  origin: string;
  destination: string;
  depart: string; // YYYY-MM-DD, YYYY-MM or "" (flexible)
  return: string; // YYYY-MM-DD or ""
  adults: number;
  direct_only?: boolean | undefined;
  depart_after?: string | undefined; // HH:MM local
  depart_before?: string | undefined; // HH:MM local
  max_price?: number | null | undefined; // per person, in `currency`
}
type Row = Record<string, unknown>;

function aviasalesPath(o: string, d: string, depart: string, ret: string, adults: number) {
  const ddmm = (iso: string) => (iso.length === 10 ? iso.slice(8, 10) + iso.slice(5, 7) : "");
  return `/search/${o}${ddmm(depart)}${d}${ddmm(ret)}${adults}`;
}
const withMarker = (path: string) => {
  const marker = process.env["TRAVELPAYOUTS_MARKER"] || "";
  return (
    "https://www.aviasales.com" +
    path +
    (marker ? (path.includes("?") ? "&" : "?") + "marker=" + marker : "")
  );
};

async function pricesForDates(p: {
  origin: string;
  destination: string;
  depart: string;
  ret: string;
  direct: boolean;
  market?: string | undefined;
  limit: number;
}): Promise<Row[]> {
  const token = process.env["TRAVELPAYOUTS_TOKEN"];
  if (!token) throw new Error("TRAVELPAYOUTS_TOKEN is not set");
  const params = new URLSearchParams({
    origin: p.origin,
    destination: p.destination,
    one_way: p.ret ? "false" : "true",
    direct: p.direct ? "true" : "false",
    sorting: "price",
    currency: CONFIG.flights.currency,
    limit: String(p.limit),
    token,
  });
  if (p.depart) params.set("departure_at", p.depart);
  if (p.ret) params.set("return_at", p.ret);
  if (p.market) params.set("market", p.market);
  const url = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`;
  return cached(`tp:${url.replace(/token=[^&]+/, "")}`, CONFIG.flights.cacheMs, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Aviasales answered ${r.status}`);
    const body = (await r.json()) as { data?: Row[] };
    return body.data ?? [];
  });
}

export interface FlightSearchResult {
  origin: Place | null;
  destination: Place | null;
  search_url: string;
  items: Item[];
  /** Short list for the Module Agent: refs + key facts (the full items stay in code). */
  options: Record<string, unknown>[];
  nearby_dates: boolean;
  /** No cached round trip: outbound and return are separate one-way options. */
  split_legs?: boolean;
  filtered_out: number;
  origin_airports: { code: string; name: string }[];
  error?: string;
}

export async function searchFlightOptions(q: FlightSearch): Promise<FlightSearchResult> {
  const [o, d] = await Promise.all([resolvePlace(q.origin), resolvePlace(q.destination)]);
  const adults = Math.max(1, Math.min(9, Math.round(q.adults) || 1));
  const depart = /^\d{4}-\d{2}(-\d{2})?$/.test(q.depart) ? q.depart : "";
  const ret = /^\d{4}-\d{2}-\d{2}$/.test(q.return) ? q.return : "";
  const empty = (error: string, url = withMarker("/")): FlightSearchResult => ({
    origin: o,
    destination: d,
    search_url: url,
    items: [],
    options: [],
    nearby_dates: false,
    filtered_out: 0,
    origin_airports: [],
    error,
  });
  if (!o) return empty(`Unknown origin "${q.origin}". Ask the user for the departure city.`);
  if (!d) return empty(`Unknown destination "${q.destination}".`);
  const searchUrl = withMarker(aviasalesPath(o.code, d.code, depart, ret, adults));

  // Reference data loads in parallel with the price query (never blocks for long).
  const refData = Promise.all([
    withTimeout(airports(), 5_000, new Map<string, Airport>()),
    withTimeout(airlines(), 5_000, new Map<string, string>()),
  ]);

  let legs: LegRows[];
  try {
    if (ret) {
      // 1) Exact round trip. 2) Not cached -> each direction as a one-way search (much better cache coverage).
      const round = await legRows(o, d, depart, ret, false);
      legs = round.rows.length
        ? [{ ...round, leg: "round" }]
        : await Promise.all([
            legRows(o, d, depart, "", true).then((r) => ({ ...r, leg: "outbound" as const })),
            legRows(d, o, ret, "", true).then((r) => ({ ...r, leg: "return" as const })),
          ]);
    } else {
      legs = [{ ...(await legRows(o, d, depart, "", true)), leg: "oneway" }];
    }
  } catch (e) {
    console.error("flights", e);
    return empty(
      "Live prices are unavailable right now; offer the Aviasales search link.",
      searchUrl,
    );
  }
  const [aps, als] = await refData;
  const originAirports = o.type === "city" ? await cityAirports(o.code) : [];

  const max = CONFIG.flights.maxOptions;
  const perLeg = legs.length > 1 ? { outbound: 4, return: 3 } : null;
  let filteredOut = 0;
  const items: Item[] = [];
  for (const L of legs) {
    const opts = buildOptions(L, { adults, searchUrl, aps, als, ret: L.leg === "round" });
    // Time-of-day filters apply to the outbound flight; direct-only and budget to every leg.
    const timed = L.leg !== "return";
    const after = timed && q.depart_after ? toMin(q.depart_after) : null;
    const before = timed && q.depart_before ? toMin(q.depart_before) : null;
    const kept = opts.filter(
      (x) =>
        (!q.direct_only || x.stops === 0) &&
        (after == null || x.depMin >= after) &&
        (before == null || x.depMin <= before) &&
        (q.max_price == null || x.price <= q.max_price),
    );
    filteredOut += opts.length - kept.length;
    const limit = perLeg ? (L.leg === "return" ? perLeg.return : perLeg.outbound) : max;
    items.push(...pickVaried(kept, limit, L.leg));
  }
  const nearby = legs.some((l) => l.nearby);
  const splitLegs = legs.length > 1;

  return {
    origin: o,
    destination: d,
    search_url: searchUrl,
    items,
    options: items.map((it) => ({
      ref: it.id,
      ...(it.attributes["leg"] ? { leg: it.attributes["leg"] } : {}),
      date: it.attributes["departure_date"],
      dep: it.attributes["departure_time"],
      arr: it.attributes["arrival_time"],
      stops: it.attributes["stops_label"],
      duration: it.attributes["duration"],
      airline: it.attributes["airline"],
      from: it.attributes["from_airport"],
      to: it.attributes["to_airport"],
      price_per_person: it.attributes["price_per_person"],
      ...(it.attributes["tags"] ? { tags: it.attributes["tags"] } : {}),
    })),
    nearby_dates: nearby,
    split_legs: splitLegs,
    filtered_out: filteredOut,
    origin_airports: originAirports.length > 1 ? originAirports : [],
  };
}

// ---------- per-leg data ----------
type LegName = "round" | "oneway" | "outbound" | "return";
interface LegRows {
  rows: Row[];
  nearby: boolean;
  leg: LegName;
  from: Place;
  to: Place;
}

/** Same query in the markets where Baku/Europe routes are cached; direct and all-stops in parallel. */
async function queryMarkets(from: string, to: string, dep: string, rt: string): Promise<Row[]> {
  const attempt = async (markets: (string | undefined)[]) => {
    const settled = await Promise.allSettled(
      markets.flatMap((market) => [
        pricesForDates({
          origin: from,
          destination: to,
          depart: dep,
          ret: rt,
          direct: false,
          market,
          limit: 30,
        }),
        pricesForDates({
          origin: from,
          destination: to,
          depart: dep,
          ret: rt,
          direct: true,
          market,
          limit: 15,
        }),
      ]),
    );
    const out: Row[] = [];
    for (const x of settled) if (x.status === "fulfilled") out.push(...x.value);
    const failed = settled.find((x) => x.status === "rejected") as
      PromiseRejectedResult | undefined;
    if (!out.length && failed && settled.every((x) => x.status === "rejected")) throw failed.reason;
    return out;
  };
  const rows = await attempt(["az", undefined]);
  return rows.length ? rows : attempt(["ru"]);
}

/** Cheapest cached one-way price per day of a month (Travelpayouts grouped_prices). */
async function pricesByDay(
  from: string,
  to: string,
  month: string,
  market?: string,
): Promise<Row[]> {
  const token = process.env["TRAVELPAYOUTS_TOKEN"];
  if (!token) throw new Error("TRAVELPAYOUTS_TOKEN is not set");
  const params = new URLSearchParams({
    origin: from,
    destination: to,
    departure_at: month,
    group_by: "departure_at",
    currency: CONFIG.flights.currency,
    token,
  });
  if (market) params.set("market", market);
  const url = `https://api.travelpayouts.com/aviasales/v3/grouped_prices?${params}`;
  return cached(`tpg:${url.replace(/token=[^&]+/, "")}`, CONFIG.flights.cacheMs, async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Aviasales answered ${r.status}`);
    const body = (await r.json()) as { data?: Record<string, Row> | Row[] };
    return Array.isArray(body.data) ? body.data : Object.values(body.data ?? {});
  });
}

const monthsAround = (date: string) => {
  const d = new Date(date + "T00:00:00Z");
  const m = new Set([date.slice(0, 7)]);
  for (const k of [-3, 3]) m.add(new Date(d.getTime() + k * 86_400_000).toISOString().slice(0, 7));
  return [...m];
};

/**
 * Rows for one direction (or a round trip when `rt` is set), most specific first:
 * exact date -> the airport's whole city (kept to that airport when possible) -> nearest cached dates (±3 days).
 */
async function legRows(
  from: Place,
  to: Place,
  dep: string,
  rt: string,
  allowNearby: boolean,
): Promise<Omit<LegRows, "leg">> {
  const base = { from, to, nearby: false };
  let rows = await queryMarkets(from.code, to.code, dep, rt);
  // An airport (e.g. FCO) has thinner cache than its city (ROM): query the city, keep that airport's flights.
  const fromCity = from.type === "airport" && from.city_code && from.city_code !== from.code;
  const toCity = to.type === "airport" && to.city_code && to.city_code !== to.code;
  if (!rows.length && (fromCity || toCity)) {
    const wide = await queryMarkets(
      fromCity ? from.city_code : from.code,
      toCity ? to.city_code : to.code,
      dep,
      rt,
    );
    const exact = wide.filter(
      (r) =>
        (!fromCity || r["origin_airport"] === from.code) &&
        (!toCity || r["destination_airport"] === to.code),
    );
    rows = exact.length ? exact : wide;
  }
  if (rows.length || !allowNearby || dep.length !== 10) return { ...base, rows };

  // Nothing on that exact day: cheapest cached flight per day, nearest days first (max ±3 days, 4 dates).
  const days: Row[] = [];
  const settled = await Promise.allSettled(
    monthsAround(dep).flatMap((m) => [
      pricesByDay(from.code, to.code, m, "az"),
      pricesByDay(from.code, to.code, m),
    ]),
  );
  for (const x of settled) if (x.status === "fulfilled") days.push(...x.value);
  const target = Date.parse(dep + "T00:00:00Z");
  const near = days
    .map((r) => ({
      r,
      gap:
        Math.abs(Date.parse(String(r["departure_at"] ?? "").slice(0, 10) + "T00:00:00Z") - target) /
        86_400_000,
    }))
    .filter((x) => Number.isFinite(x.gap) && x.gap <= 3)
    .sort((a, b) => a.gap - b.gap || Number(a.r["price"]) - Number(b.r["price"]));
  const byDate = new Map<string, Row>();
  for (const x of near) {
    const day = String(x.r["departure_at"]).slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, x.r);
  }
  return { ...base, rows: [...byDate.values()].slice(0, 4), nearby: byDate.size > 0 };
}

type Opt = { item: Item; depMin: number; price: number; dur: number; stops: number };

function buildOptions(
  L: LegRows,
  c: {
    adults: number;
    searchUrl: string;
    aps: Map<string, Airport>;
    als: Map<string, string>;
    ret: boolean;
  },
): Opt[] {
  const { adults, aps, als } = c;
  const seen = new Set<string>();
  const opts: Opt[] = [];
  const legLabel = L.leg === "outbound" ? "Outbound" : L.leg === "return" ? "Return" : "";
  for (const f of L.rows) {
    const depIso = String(f["departure_at"] ?? "");
    const dep = localParts(depIso);
    const price = Number(f["price"]);
    if (!dep || !Number.isFinite(price)) continue;
    const airline = String(f["airline"] ?? "");
    const num = String(f["flight_number"] ?? "");
    const key = `${airline}${num}|${depIso}|${f["return_at"] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stops = Number(f["transfers"] ?? 0);
    const durTo = Number(f["duration_to"] ?? 0) || (c.ret ? 0 : Number(f["duration"] ?? 0));
    const fromAp = String(f["origin_airport"] ?? L.from.code);
    const toAp = String(f["destination_airport"] ?? L.to.code);
    // Arrival = departure instant + flight time, shown in the destination airport's time zone.
    let arrival: { date: string; time: string } | null = null;
    let arrivalApprox = false;
    if (durTo > 0) {
      const ms = Date.parse(depIso) + durTo * 60_000;
      const tz = aps.get(toAp)?.tz;
      arrival = tz ? inZone(ms, tz) : null;
      if (!arrival) {
        const local = ms + dep.offsetMin * 60_000;
        arrival = {
          date: new Date(local).toISOString().slice(0, 10),
          time: new Date(local).toISOString().slice(11, 16),
        };
        arrivalApprox = true;
      }
    }
    const stopsLabel = stops === 0 ? "Direct" : stops === 1 ? "1 stop" : `${stops} stops`;
    const fallbackUrl = withMarker(aviasalesPath(L.from.code, L.to.code, dep.date, "", adults));
    const link = f["link"]
      ? withMarker(
          String(f["link"]).replace(
            /^(\/search\/[A-Z]{3}\d{4}[A-Z]{3}(?:\d{4})?)\d/,
            `$1${adults}`,
          ),
        )
      : L.leg === "round" || L.leg === "oneway"
        ? c.searchUrl
        : fallbackUrl;
    const attrs: Record<string, unknown> = {
      ...(legLabel ? { leg: legLabel } : {}),
      departure_date: dep.date,
      departure_time: dep.time,
      ...(arrival ? { arrival_date: arrival.date, arrival_time: arrival.time } : {}),
      ...(arrival && dayDiff(dep.date, arrival.date) > 0
        ? { arrival_day_offset: dayDiff(dep.date, arrival.date) }
        : {}),
      ...(arrivalApprox ? { arrival_time_note: "origin time zone" } : {}),
      ...(L.nearby ? { nearby_date: true } : {}),
      from_airport: fromAp,
      to_airport: toAp,
      ...(aps.get(fromAp) ? { from_airport_name: aps.get(fromAp)!.name } : {}),
      ...(aps.get(toAp) ? { to_airport_name: aps.get(toAp)!.name } : {}),
      duration: durationLabel(durTo),
      stops,
      stops_label: stopsLabel,
      airline: als.get(airline) ?? airline,
      flight_number: `${airline} ${num}`.trim(),
      price_per_person: price,
      passengers: adults,
      ...(legLabel ? { price_note: "one-way price" } : {}),
    };
    const retIso = String(f["return_at"] ?? "");
    const retDep = retIso && c.ret ? localParts(retIso) : null;
    if (retDep) {
      const back = Number(f["duration_back"] ?? 0);
      attrs["return_date"] = retDep.date;
      attrs["return_departure_time"] = retDep.time;
      const rs = Number(f["return_transfers"] ?? 0);
      attrs["return_stops_label"] = rs === 0 ? "Direct" : rs === 1 ? "1 stop" : `${rs} stops`;
      if (back > 0) {
        const tz = aps.get(fromAp)?.tz;
        const a = tz ? inZone(Date.parse(retIso) + back * 60_000, tz) : null;
        if (a) attrs["return_arrival_time"] = a.time;
        attrs["return_duration"] = durationLabel(back);
      }
    }
    const id = `f_${legLabel ? legLabel[0]!.toLowerCase() + "_" : ""}${airline}${num}_${dep.date.slice(5)}_${dep.time.replace(":", "")}${retDep ? "_r" + retDep.date.slice(5) : ""}`;
    opts.push({
      depMin: toMin(dep.time) ?? 0,
      price,
      dur: durTo || 99_999,
      stops,
      item: {
        id,
        kind: "flight",
        title: `${dep.time} → ${arrival?.time ?? "?"} · ${als.get(airline) ?? airline}`,
        subtitle: [
          legLabel,
          `${fromAp} → ${toAp}`,
          stopsLabel,
          durationLabel(durTo),
          L.nearby || legLabel ? dep.date : "",
        ]
          .filter(Boolean)
          .join(" · "),
        attributes: attrs,
        price: {
          amount: Math.round(price * adults * 100) / 100,
          currency: CONFIG.flights.currency.toUpperCase(),
        },
        source_url: link,
        verify: true, // cached "from" prices
        action: { label: "Book on Aviasales", type: "handoff_url", value: link },
      },
    });
  }
  return opts;
}

/** A varied set: cheapest, cheapest direct, fastest, cheapest with stops, then spread over the day. */
function pickVaried(kept: Opt[], max: number, leg: LegName): Item[] {
  const picked = new Map<string, Opt>();
  const add = (x?: Opt) => x && picked.size < max && picked.set(x.item.id, x);
  const byPrice = [...kept].sort((a, b) => a.price - b.price || a.dur - b.dur);
  add(byPrice[0]);
  add(byPrice.find((x) => x.stops === 0));
  add([...kept].sort((a, b) => a.dur - b.dur || a.price - b.price)[0]);
  add(byPrice.find((x) => x.stops > 0));
  const byTime = [...kept].sort((a, b) => a.depMin - b.depMin);
  const step = Math.max(1, Math.floor(byTime.length / Math.max(1, max)));
  for (let i = 0; picked.size < max && i < byTime.length; i++)
    add(byTime[(i * step) % byTime.length]);
  for (const x of byPrice) add(x);
  const cheapest = byPrice[0]?.item.id;
  const fastest = [...kept].sort((a, b) => a.dur - b.dur)[0]?.item.id;
  const legTag = leg === "outbound" ? "Outbound" : leg === "return" ? "Return" : "";
  return [...picked.values()]
    .sort(
      (a, b) =>
        (a.item.attributes["departure_date"] as string).localeCompare(
          b.item.attributes["departure_date"] as string,
        ) || a.depMin - b.depMin,
    )
    .map((x) => {
      const tags = [
        legTag,
        x.item.id === cheapest ? "Cheapest" : "",
        x.item.id === fastest ? "Fastest" : "",
        x.item.attributes["nearby_date"] ? "Nearby date" : "",
      ].filter(Boolean);
      return tags.length ? { ...x.item, attributes: { ...x.item.attributes, tags } } : x.item;
    });
}

export const _test = { localParts, inZone, cache };
