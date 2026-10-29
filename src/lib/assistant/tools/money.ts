// Budget handling in code: parse the user's budget ("under 300 AZN", "80$ per night", "до 500 манат")
// and drop items above it. Currencies are compared through AZN (live rates, static fallback).

export interface Budget {
  max: number;
  currency: string; // ISO code
  basis: "per_night" | "per_person" | "total" | "any";
}

const CUR: [RegExp, string][] = [
  [/₼|\bazn\b|manat|манат/i, "AZN"],
  [/\$|\busd\b|dollar|доллар/i, "USD"],
  [/€|\beur\b|euro|евро|avro/i, "EUR"],
  [/₺|\btry\b|\btl\b|lira|лир/i, "TRY"],
  [/₽|\brub\b|руб/i, "RUB"],
  [/£|\bgbp\b|pound|фунт/i, "GBP"],
  [/\bgel\b|lari|лари/i, "GEL"],
  [/\baed\b|dirham|дирхам/i, "AED"],
];

/** Parses a budget phrase; null when it has no number. Default currency AZN. */
export function parseBudget(text: string | undefined | null): Budget | null {
  if (!text) return null;
  const t = String(text).replace(/(\d)[\s\u00a0\u202f](?=\d{3}\b)/g, "$1");
  const nums = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(k|к|min)?/gi)]
    .map((m) => Number(m[1]!.replace(",", ".")) * (/^(k|к)$/i.test(m[2] ?? "") ? 1000 : 1))
    .filter((n) => n > 0);
  if (!nums.length) return null;
  const currency = CUR.find(([rx]) => rx.test(t))?.[1] ?? "AZN";
  const basis = /night|gecə|gece|ноч|сутк/i.test(t)
    ? "per_night"
    : /person|nəfər|nefer|человек|чел\b|per ticket|bilet/i.test(t)
      ? "per_person"
      : /total|ümumi|всего|итого/i.test(t)
        ? "total"
        : "any";
  return { max: Math.max(...nums), currency, basis };
}

// AZN per 1 unit. Static fallback (AZN is pegged to USD at 1.70); refreshed from a free rates API.
const STATIC_AZN: Record<string, number> = {
  AZN: 1,
  USD: 1.7,
  EUR: 1.95,
  GBP: 2.25,
  TRY: 0.04,
  RUB: 0.021,
  GEL: 0.62,
  AED: 0.463,
};
let rates: { at: number; azn: Record<string, number> } | null = null;
let loading: Promise<void> | null = null;

export async function loadRates(): Promise<void> {
  if (rates && Date.now() - rates.at < 12 * 3600_000) return;
  loading ??= (async () => {
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/AZN", {
        signal: AbortSignal.timeout(4_000),
      });
      const body = (await res.json()) as { rates?: Record<string, number> };
      if (body.rates?.["USD"]) {
        const azn: Record<string, number> = {};
        for (const [c, perAzn] of Object.entries(body.rates)) if (perAzn > 0) azn[c] = 1 / perAzn;
        rates = { at: Date.now(), azn };
      }
    } catch {
      /* static fallback */
    } finally {
      loading = null;
    }
  })();
  await loading;
}

/** Converts an amount between currencies; null when a currency is unknown. */
export function convert(amount: number, from: string, to: string): number | null {
  const f = (rates?.azn[from.toUpperCase()] ?? STATIC_AZN[from.toUpperCase()]) || null;
  const t = (rates?.azn[to.toUpperCase()] ?? STATIC_AZN[to.toUpperCase()]) || null;
  if (!f || !t) return null;
  return (amount * f) / t;
}

/** true / false, or null when the item has no comparable price. 3% tolerance for exchange-rate noise. */
export function withinBudget(
  price: { amount: number | null; currency: string | null },
  perUnit: number | null,
  b: Budget,
): boolean | null {
  const amount = perUnit ?? price.amount;
  if (amount == null || !price.currency) return null;
  const inBudgetCur = convert(amount, price.currency, b.currency);
  if (inBudgetCur == null) return null;
  return inBudgetCur <= b.max * 1.03;
}
