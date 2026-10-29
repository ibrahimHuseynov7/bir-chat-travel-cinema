// Client-safe shared contract + keyword router for Bir Chat.
export type Route = "cinema" | "avia" | "shopping" | "general";

export const CINEMAS: Record<string, { name: string; city: string }> = {
  shamakhi: { name: "Shamakhy", city: "Shamakhi" },
  "28-mall": { name: "28 Mall", city: "Baku" },
  "ganjlik-mall": { name: "Ganjlik Mall", city: "Baku" },
  "deniz-mall": { name: "Deniz Mall", city: "Baku" },
  "azerbaijan-cinema": { name: "Azerbaijan Cinema", city: "Baku" },
  "amburan-mall": { name: "Amburan Mall", city: "Baku" },
  sumgayit: { name: "Sumgayit", city: "Sumgayit" },
  "bakixanov-mall": { name: "Bakıxanov Mall", city: "Baku" },
  "ganja-mall": { name: "Ganja Mall", city: "Ganja" },
  khamsapark: { name: "Khamsa Park", city: "Ganja" },
  "sea-breeze": { name: "Sea Breeze", city: "Baku" },
};

export type Session = {
  movie: string;
  movie_url: string | null;
  time: string;
  date: string;
  hall: string;
  format: string | null;
  language: string | null;
  az_subtitles: boolean;
  price_azn: number | null;
};
export type MovieInfo = {
  title: string;
  year: number;
  runtime_min: number;
  vote_average: number;
  age_rating: string;
  overview: string;
  genres: string[];
};
export type CinemaData =
  | { kind: "list" }
  | {
      kind: "sessions";
      slug: string;
      day: "today" | "tomorrow";
      date: string;
      sessions: Session[];
      info: Record<string, MovieInfo>;
      error?: string;
    };
export type Offer = {
  price_usd: number;
  airline: string;
  flight_number: string;
  departure_at: string;
  return_at: string | null;
  transfers: number;
  duration_min: number;
  link: string;
};
export type FlightQuery = {
  origin: string;
  destination: string;
  depart: string;
  return: string;
  adults: number;
};
/** nearby: no cached prices for the exact dates, so offers are the cheapest dates in the same month. */
export type FlightData = FlightQuery & {
  search_url: string | null;
  offers: Offer[];
  nearby?: boolean;
  error?: string;
};
export type Product = {
  id: string;
  name: string;
  price_azn: number | null;
  old_price: number | null;
  rating: number | null;
  reviews: number | null;
  image_url: string | null;
  url: string;
};
export type ShopData = {
  query: string;
  products: Product[];
  alternatives?: Product[];
  error?: string;
};

export type ChatResult =
  | { route: "cinema"; reply: string; data: CinemaData }
  | { route: "avia"; reply: string; data: FlightData }
  | { route: "shopping"; reply: string; data: ShopData }
  | { route: "general"; reply: string; data: null };

const RX: Record<string, RegExp> = {
  cinema:
    /kino|cinema|cinemaplus|film|movie|seans|session|showtime|4dx|screenx|premiere|sinema|кино|фильм|сеанс/i,
  avia: /flight|fly|plane|avia|uçuş|ucus|reys|aviabilet|airport|təyyarə|авиа|рейс|перел[её]т|самол[её]т/i,
  shopping:
    /buy|shop|price|gift|almaq|qiymət|hədiyyə|mağaza|купить|цена|подар|phone|telefon|laptop|noutbuk|headphone|qulaqlıq/i,
};
export const CITIES: { [k: string]: string } = {
  baku: "GYD",
  bakı: "GYD",
  баку: "GYD",
  istanbul: "IST",
  стамбул: "IST",
  dubai: "DXB",
  dubay: "DXB",
  moscow: "MOW",
  moskva: "MOW",
  москва: "MOW",
  tbilisi: "TBS",
  london: "LON",
  paris: "PAR",
  antalya: "AYT",
  berlin: "BER",
  ankara: "ESB",
  nakhchivan: "NAJ",
  naxçıvan: "NAJ",
  ganja: "KVD",
  gəncə: "KVD",
  tashkent: "TAS",
  almaty: "ALA",
  astana: "NQZ",
  doha: "DOH",
  rome: "ROM",
  milan: "MIL",
  prague: "PRG",
  vienna: "VIE",
  minsk: "MSQ",
  sochi: "AER",
  "tel aviv": "TLV",
  "abu dhabi": "AUH",
  izmir: "ADB",
  batumi: "BUS",
  kazan: "KZN",
  barcelona: "BCN",
  madrid: "MAD",
  amsterdam: "AMS",
  warsaw: "WAW",
  // Azerbaijani, Turkish and Russian spellings (Russian stems also match case forms: "рим" → "из рима")
  baki: "GYD",
  stambul: "IST",
  дубай: "DXB",
  тбилиси: "TBS",
  tiflis: "TBS",
  лондон: "LON",
  париж: "PAR",
  parij: "PAR",
  анталья: "AYT",
  берлин: "BER",
  анкара: "ESB",
  нахчыван: "NAJ",
  гянджа: "KVD",
  daşkənd: "TAS",
  ташкент: "TAS",
  алматы: "ALA",
  астана: "NQZ",
  доха: "DOH",
  roma: "ROM",
  рим: "ROM",
  milano: "MIL",
  милан: "MIL",
  praqa: "PRG",
  прага: "PRG",
  vyana: "VIE",
  wien: "VIE",
  вена: "VIE",
  минск: "MSQ",
  soçi: "AER",
  сочи: "AER",
  "абу-даби": "AUH",
  "abu-dabi": "AUH",
  измир: "ADB",
  batum: "BUS",
  батуми: "BUS",
  казань: "KZN",
  barselona: "BCN",
  барселона: "BCN",
  мадрид: "MAD",
  амстердам: "AMS",
  varşava: "WAW",
  варшава: "WAW",
};
/** Lowercase that also folds Turkish "İ" ("İstanbul" → "istanbul"). */
export const lower = (s: string) => s.toLowerCase().replace(/\u0307/g, "");

export function keywordRoute(text: string, active: Route | null): Route {
  const score: { cinema: number; avia: number; shopping: number; [k: string]: number } = {
    cinema: 0,
    avia: 0,
    shopping: 0,
  };
  for (const k in RX) if (RX[k]!.test(text)) score[k] = (score[k] ?? 0) + 2;
  const t = text.toLowerCase();
  const cities = Object.keys(CITIES).filter((c) => t.includes(c));
  if (cities.length && /\bto\b|from|dan|dən|-|→/.test(t)) score.avia += 2;
  if (/ticket|bilet|билет/.test(t)) {
    if (cities.length) score.avia++;
    else score.cinema++;
  }
  const [best, val] = Object.entries(score).sort((a, b) => b[1] - a[1])[0] ?? ["general", 0];
  if (val === 0) return active || "general";
  if (active && active !== "general" && score[active] === val) return active;
  return best as Route;
}

/** Turn a city name or IATA code into an IATA code ("" if unknown). */
export function toIata(v: string): string {
  const t = lower(v.trim());
  const c = CITIES[t];
  if (c) return c;
  return /^[a-z]{3}$/.test(t) ? t.toUpperCase() : "";
}

export function ddmm(iso?: string | null) {
  return iso && iso.length === 10 ? iso.slice(8, 10) + iso.slice(5, 7) : "";
}

// Links that send the user to the source site, also used when our data for it is unavailable.
export const cinemaPageUrl = (slug: string) =>
  `https://cinemastercard.az/en/cinema/about-cinemaplus/${slug}/`;
export const moviePageUrl = (s: { movie_url: string | null }, slug: string) =>
  s.movie_url ? new URL(s.movie_url, "https://cinemastercard.az").toString() : cinemaPageUrl(slug);
export const birmarketSearchUrl = (q: string) =>
  q.trim()
    ? `https://birmarket.az?search=${encodeURIComponent(q.trim())}`
    : "https://birmarket.az/";

export function aviasalesSearchUrl(q: FlightQuery, marker = "") {
  const path = `/search/${q.origin}${ddmm(q.depart)}${q.destination}${ddmm(q.return)}${q.adults}`;
  return "https://www.aviasales.com" + path + (marker ? `?marker=${marker}` : "");
}
