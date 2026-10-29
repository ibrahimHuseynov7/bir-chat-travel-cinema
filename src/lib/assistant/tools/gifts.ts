// Gift requests ("a present for my mom") have no product word to search for, so code turns them into a
// handful of gift ideas for that kind of recipient, each a set of Azerbaijani product-name phrases that
// Birmarket listings start with ("Ətir ...", "Qadın çantası ..."), and picks a varied mix from the catalog.
// Also: price-range buckets for the filter chips under shopping results.
import type { Product } from "@/lib/bir";

export type RecipientGroup = "female" | "male" | "kid" | "any";
export interface GiftIdea {
  /** Shown on the card ("gift idea") and used for "more X" refinements. */
  label: string;
  /** Each phrase = words that must ALL start a word of the product name; any phrase matches. */
  phrases: string[][];
}
export interface GiftPlan {
  group: RecipientGroup;
  /** Who the gift is for, as the user said it (for the summary). */
  recipient: string;
  ideas: GiftIdea[];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\u0307/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const GIFT_WORDS = new Set([
  "gift",
  "gifts",
  "present",
  "presents",
  "hədiyyə",
  "hədiyyələr",
  "hədiyyəlik",
  "hediyye",
  "hediye",
  "hediyeler",
  "подарок",
  "подарки",
  "подарка",
  "подарочек",
  "idea",
  "ideas",
  "ideya",
  "ideyalar",
  "идея",
  "идеи",
]);
// Words around a gift request that are not a product ("for my mom's birthday").
const FILLER = new Set([
  "for",
  "my",
  "to",
  "the",
  "a",
  "an",
  "some",
  "something",
  "nice",
  "good",
  "buy",
  "find",
  "üçün",
  "ucun",
  "mənim",
  "menim",
  "bir",
  "şey",
  "sey",
  "almaq",
  "для",
  "на",
  "мой",
  "моя",
  "моей",
  "моему",
  "моего",
  "что",
  "нибудь",
  "için",
  "icin",
  "birthday",
  "bday",
  "anniversary",
  "ad",
  "günü",
  "gunu",
  "günün",
  "doğum",
  "dogum",
  "день",
  "дня",
  "рождения",
  "march",
  "mart",
  "марта",
  "8",
  "new",
  "year",
  "yeni",
  "il",
  "новый",
  "год",
  "christmas",
  "valentine",
  "valentines",
  "sevgililər",
]);
const RECIPIENTS: Record<Exclude<RecipientGroup, "any">, string[]> = {
  female: [
    "mom",
    "mother",
    "mum",
    "mommy",
    "mama",
    "mamma",
    "ana",
    "anam",
    "anama",
    "anamın",
    "annə",
    "anne",
    "annem",
    "nənə",
    "nənəm",
    "grandma",
    "grandmother",
    "wife",
    "arvad",
    "arvadım",
    "xanım",
    "xanımım",
    "sister",
    "bacı",
    "bacım",
    "girlfriend",
    "aunt",
    "xala",
    "xalam",
    "bibi",
    "bibim",
    "woman",
    "women",
    "qadın",
    "her",
    "мама",
    "маме",
    "маму",
    "мамы",
    "мамочке",
    "мать",
    "матери",
    "жена",
    "жене",
    "сестра",
    "сестре",
    "бабушка",
    "бабушке",
    "девушка",
    "девушке",
    "тёте",
    "тете",
  ],
  male: [
    "dad",
    "father",
    "daddy",
    "papa",
    "ata",
    "atam",
    "atama",
    "baba",
    "babam",
    "grandpa",
    "grandfather",
    "husband",
    "ər",
    "ərim",
    "brother",
    "qardaş",
    "qardaşım",
    "boyfriend",
    "uncle",
    "dayı",
    "dayım",
    "əmi",
    "əmim",
    "man",
    "men",
    "kişi",
    "him",
    "папа",
    "папе",
    "отец",
    "отцу",
    "муж",
    "мужу",
    "брат",
    "брату",
    "дедушка",
    "дедушке",
    "парень",
    "парню",
    "дяде",
  ],
  kid: [
    "child",
    "children",
    "kid",
    "kids",
    "son",
    "daughter",
    "baby",
    "toddler",
    "boy",
    "girl",
    "nephew",
    "niece",
    "uşaq",
    "uşağa",
    "oğul",
    "oğlum",
    "oğluma",
    "qızım",
    "qızıma",
    "körpə",
    "ребенок",
    "ребёнок",
    "ребенку",
    "ребёнку",
    "сын",
    "сыну",
    "дочь",
    "дочке",
    "дочери",
    "малыш",
    "малышу",
    "племяннику",
    "племяннице",
  ],
};

const FEMALE: GiftIdea[] = [
  { label: "Perfume", phrases: [["ətir"], ["parfüm"], ["parfum"], ["tualet", "suyu"]] },
  {
    label: "Handbag",
    phrases: [
      ["qadın", "çanta"],
      ["əl", "çanta"],
    ],
  },
  { label: "Jewelry", phrases: [["sırğa"], ["boyunbağı"], ["bilərzik"], ["üzük"], ["kulon"]] },
  {
    label: "Beauty",
    phrases: [
      ["saç", "fen"],
      ["saç", "düzləşdirici"],
      ["saç", "ütü"],
      ["epilyator"],
      ["kosmetik", "dəst"],
      ["üz", "krem"],
    ],
  },
  {
    label: "Kitchen",
    phrases: [
      ["blender"],
      ["mikser"],
      ["qəhvə", "maşın"],
      ["qəhvəbişirən"],
      ["çaydan"],
      ["multibişirici"],
      ["aerogril"],
    ],
  },
  {
    label: "Watch",
    phrases: [
      ["qadın", "saat"],
      ["smart", "saat"],
      ["ağıllı", "saat"],
    ],
  },
  { label: "Cozy home", phrases: [["xalat"], ["pled"], ["şal"], ["yaylıq"]] },
  { label: "Massager", phrases: [["masaj"]] },
];
const MALE: GiftIdea[] = [
  {
    label: "Perfume",
    phrases: [
      ["ətir", "kişi"],
      ["kişi", "parfüm"],
      ["kişi", "tualet"],
    ],
  },
  {
    label: "Watch",
    phrases: [
      ["kişi", "saat"],
      ["smart", "saat"],
      ["ağıllı", "saat"],
    ],
  },
  { label: "Grooming", phrases: [["trimmer"], ["ülgüc"], ["təraş"], ["saqqal"]] },
  { label: "Wallet & belt", phrases: [["pul", "kisəsi"], ["pulqabı"], ["portmone"], ["kəmər"]] },
  { label: "Audio", phrases: [["qulaqlıq"], ["portativ", "dinamik"]] },
  { label: "Tools", phrases: [["alət", "dəst"], ["drel"], ["vintaçan"]] },
  { label: "Thermos", phrases: [["termos"], ["termokruj"]] },
];
const KID: GiftIdea[] = [
  { label: "Toys", phrases: [["oyuncaq"], ["kukla"], ["konstruktor"], ["lego"]] },
  { label: "Ride-ons", phrases: [["velosiped"], ["samokat"], ["skuter"]] },
  { label: "Games & puzzles", phrases: [["stolüstü", "oyun"], ["pazl"]] },
  { label: "Creative", phrases: [["rəsm", "dəst"], ["plastilin"], ["flomaster"]] },
];
const ANY: GiftIdea[] = [
  { label: "Audio", phrases: [["qulaqlıq"], ["portativ", "dinamik"]] },
  {
    label: "Smart watch",
    phrases: [
      ["smart", "saat"],
      ["ağıllı", "saat"],
    ],
  },
  { label: "Perfume", phrases: [["ətir"], ["parfüm"]] },
  { label: "Thermos & mugs", phrases: [["termos"], ["termokruj"], ["fincan"]] },
  { label: "Cozy home", phrases: [["pled"], ["ətirli", "şam"], ["diffuzor"]] },
  { label: "Power bank", phrases: [["powerbank"], ["power", "bank"]] },
];
const IDEAS: Record<RecipientGroup, GiftIdea[]> = {
  female: FEMALE,
  male: MALE,
  kid: KID,
  any: ANY,
};
// Products for someone else are skipped (no kids' perfume for mom, no women's watch for dad).
const EXCLUDE: Record<RecipientGroup, string[]> = {
  female: ["uşaq", "kişi", "oyuncaq"],
  male: ["uşaq", "qadın", "oyuncaq"],
  kid: [],
  any: ["uşaq", "oyuncaq"],
};
// Lead words of accessory listings ("Çexol ...", "Kabel ...") never make a gift card.
const ACCESSORY = ["çexol", "cexol", "qoruyucu", "kabel", "adapter", "qayış", "plyonka", "üçün"];

// Exact word, or a longer form of a stem of 5+ letters ("grandmas"), so "girl" never matches "girlfriend".
const hitWord = (w: string, k: string) => w === k || (k.length >= 5 && w.startsWith(k));
// "X üçün" = "for X": an accessory for X ("Saat üçün qayış"), except "for women / men / kids" labels.
const FOR_WHOM = ["qadın", "kişi", "uşaq"];

/**
 * A gift plan when the query (or the recipient slot) is a gift request with no concrete product,
 * else null (the normal product search runs). `rest` holds product words, e.g. "hədiyyə ətir" -> ["ətir"].
 */
export function giftPlan(
  query: string,
  recipientSlot = "",
): (GiftPlan & { rest: string[] }) | null {
  const qw = words(query);
  const rw = words(recipientSlot);
  const isGift = qw.some((w) => GIFT_WORDS.has(w)) || rw.length > 0;
  if (!isGift) return null;
  const all = [...rw, ...qw];
  let group: RecipientGroup = "any";
  let recipient = recipientSlot.trim();
  for (const g of ["kid", "female", "male"] as const) {
    const w = all.find((x) => RECIPIENTS[g].some((k) => hitWord(x, k)));
    if (w) {
      group = g;
      recipient ||= w;
      break;
    }
  }
  const isRecipient = (w: string) =>
    Object.values(RECIPIENTS).some((list) => list.some((k) => hitWord(w, k)));
  const rest = qw.filter(
    (w) => !GIFT_WORDS.has(w) && !FILLER.has(w) && !isRecipient(w) && !/^\d+$/.test(w),
  );
  return { group, recipient, ideas: IDEAS[group], rest };
}

/** True when every word of the phrase starts a word of the product name (not an "X üçün" = "for X" accessory). */
function phraseMatches(nameWords: string[], phrase: string[]): boolean {
  return phrase.every((p) =>
    nameWords.some(
      (n, i) =>
        n.startsWith(p) &&
        (p.length > 3 || n.length - p.length <= 2) &&
        (nameWords[i + 1] !== "üçün" || FOR_WHOM.includes(p)),
    ),
  );
}

const quality = (p: Product) => (p.rating ?? 0) * Math.log10(10 + (p.reviews ?? 0));

/**
 * A varied mix: the best-rated product of each idea first (round robin), within the price range.
 * `prices` = prices of every matching product before the price filter (for the filter buckets).
 */
export function pickGifts(
  all: Product[],
  plan: GiftPlan,
  min: number | null,
  max: number | null,
  total = 6,
): { picks: { product: Product; idea: string }[]; prices: number[]; ideasFound: string[] } {
  const exclude = EXCLUDE[plan.group];
  const used = new Set<string>();
  const prices: number[] = [];
  const perIdea = plan.ideas.map((idea) => {
    const list = all.filter((p) => {
      if (p.price_azn == null || used.has(p.id)) return false;
      const nw = words(p.name);
      if (ACCESSORY.some((a) => (nw[0] ?? "").startsWith(a))) return false;
      if (nw.some((w) => exclude.some((x) => w.startsWith(x)))) return false;
      return idea.phrases.some((ph) => phraseMatches(nw, ph));
    });
    for (const p of list) {
      used.add(p.id);
      prices.push(p.price_azn!);
    }
    const inRange = list
      .filter((p) => (min == null || p.price_azn! >= min) && (max == null || p.price_azn! <= max))
      .sort((a, b) => quality(b) - quality(a));
    return { idea: idea.label, list: inRange };
  });
  const picks: { product: Product; idea: string }[] = [];
  for (let round = 0; picks.length < total; round++) {
    let added = false;
    for (const { idea, list } of perIdea) {
      const p = list[round];
      if (!p || picks.length >= total) continue;
      picks.push({ product: p, idea });
      added = true;
    }
    if (!added) break;
  }
  return {
    picks,
    prices,
    ideasFound: perIdea.filter((x) => x.list.length).map((x) => x.idea),
  };
}

// ---------- price filter buckets ----------
const NICE = [
  5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 400, 500, 600, 750, 1000,
  1200, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000,
];
const nice = (n: number) =>
  NICE.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), NICE[0]!);

export type PriceRange = { min: number | null; max: number | null };

/** 3-4 price ranges that split the found products roughly into quarters, on round numbers. */
export function priceBuckets(prices: number[]): PriceRange[] {
  const sorted = [...prices].filter((p) => p > 0).sort((a, b) => a - b);
  let cuts: number[];
  if (sorted.length < 4) cuts = [50, 100, 200];
  else {
    const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
    cuts = [...new Set([q(0.25), q(0.5), q(0.75)].map(nice))].filter(
      (c) => c > sorted[0]! && c < sorted.at(-1)!,
    );
    if (!cuts.length) cuts = [nice(q(0.5))];
  }
  const out: PriceRange[] = [{ min: null, max: cuts[0]! }];
  for (let i = 1; i < cuts.length; i++) out.push({ min: cuts[i - 1]!, max: cuts[i]! });
  out.push({ min: cuts.at(-1)!, max: null });
  return out;
}

/** "50-100", "-50", "300-", "" (any) - the value a price filter chip sends back. */
export const rangeValue = (r: PriceRange) =>
  r.min == null && r.max == null ? "" : `${r.min ?? ""}-${r.max ?? ""}`;

export function parseRange(v: string | null | undefined): PriceRange {
  const m = String(v ?? "").match(/^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/);
  if (!m) return { min: null, max: null };
  let min = m[1] ? Number(m[1]) : null,
    max = m[2] ? Number(m[2]) : null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min: min || null, max: max || null };
}
