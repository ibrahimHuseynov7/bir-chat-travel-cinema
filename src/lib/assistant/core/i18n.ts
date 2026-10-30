// The few strings code itself must produce (fallbacks and auto-fixes). Everything else is written by the Responder.
const T = {
  type_my_own: { az: "Özüm yazım", ru: "Напишу сам", en: "Type my own", tr: "Kendim yazayım" },
  check_price: {
    az: "qiyməti saytda yoxlayın",
    ru: "проверьте цену на сайте",
    en: "check price on site",
    tr: "fiyatı sitede kontrol edin",
  },
  fallback: {
    az: "Bağışlayın, bunu indi edə bilmədim. Nə ilə kömək edim?",
    ru: "Извините, сейчас не получилось. Чем могу помочь?",
    en: "Sorry, I couldn't do that right now. What can I help you with?",
    tr: "Üzgünüm, bunu şu an yapamadım. Nasıl yardımcı olabilirim?",
  },
} as const;
export type Lang = "az" | "ru" | "en" | "tr";
export function lang(code: string | null | undefined): Lang {
  const c = (code ?? "").toLowerCase().slice(0, 2);
  return (["az", "ru", "en", "tr"].includes(c) ? c : "en") as Lang;
}
export const t = (key: keyof typeof T, code: string | null | undefined) => T[key][lang(code)];

const MONTHS: Record<Lang, string[]> = {
  az: ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avq", "sen", "okt", "noy", "dek"],
  ru: ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  tr: ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"],
};
/**
 * Chip label for the ISO dates in a value: "2026-12-28/2027-01-03" -> "28 dek – 3 yan",
 * "2026-12-28/2026-12-31" -> "28–31 dek", one date -> "28 dek". null when the value has no ISO date.
 */
export function dateLabel(value: string, code: string | null | undefined): string | null {
  const ds = [...value.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].slice(0, 2);
  if (!ds.length) return null;
  const m = MONTHS[lang(code)];
  const parts = ds.map((d) => ({ day: Number(d[3]), mon: m[Number(d[2]) - 1] }));
  if (parts.some((p) => !p.mon || !p.day)) return null;
  const [a, b] = parts as [{ day: number; mon: string }, { day: number; mon: string }?];
  if (!b) return `${a.day} ${a.mon}`;
  return a.mon === b.mon ? `${a.day}–${b.day} ${a.mon}` : `${a.day} ${a.mon} – ${b.day} ${b.mon}`;
}
