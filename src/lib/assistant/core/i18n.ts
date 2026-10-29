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
