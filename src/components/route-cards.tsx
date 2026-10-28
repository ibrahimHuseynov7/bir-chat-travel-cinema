import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Star, ExternalLink } from "lucide-react";
import { CINEMAS, CITIES, type CinemaData, type FlightData, type Session, type ShopData } from "@/lib/bir";
import { cinemaDay, flights } from "@/lib/chat.functions";

const btn = "pill inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground hover:opacity-85 transition";
const ghost = "pill px-3 py-1.5 text-sm hover:bg-primary hover:text-primary-foreground transition";
const tag = "rounded-full bg-wash px-2 py-0.5 text-xs";

export function CinemaCard({ data: initial, onPick }: { data: CinemaData; onPick: (text: string) => void }) {
  const [data, setData] = useState(initial);
  const [picked, setPicked] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchDay = useServerFn(cinemaDay);

  if (data.kind === "list") {
    return (
      <div className="route-card grid gap-2 sm:grid-cols-2">
        {Object.entries(CINEMAS).map(([slug, c]) => (
          <button key={slug} onClick={() => onPick(`Show sessions at ${c.name} today`)} className="flex items-center justify-between rounded-xl bg-wash px-3 py-2 text-left text-sm hover:bg-primary hover:text-primary-foreground transition">
            <span className="font-semibold">{c.name}</span><span className="text-xs opacity-70">{c.city}</span>
          </button>
        ))}
      </div>
    );
  }

  const switchDay = async (day: "today" | "tomorrow") => {
    if (day === data.day || loading) return;
    setLoading(true); setPicked(null);
    try { setData(await fetchDay({ data: { slug: data.slug, day } })); } finally { setLoading(false); }
  };
  const byMovie = new Map<string, Session[]>();
  for (const s of data.sessions) byMovie.set(s.movie, [...(byMovie.get(s.movie) ?? []), s]);

  return (
    <div className="route-card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg">{CINEMAS[data.slug]?.name}</h3>
        <div className="flex gap-1">
          {(["today", "tomorrow"] as const).map((d) => (
            <button key={d} onClick={() => void switchDay(d)} className={`${ghost} ${data.day === d ? "bg-primary text-primary-foreground" : ""}`}>{d === "today" ? "Today" : "Tomorrow"}</button>
          ))}
        </div>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading sessions…</p>}
      {data.error && <p className="text-sm text-destructive">{data.error}</p>}
      {!loading && !data.error && !data.sessions.length && <p className="text-sm text-muted-foreground">No sessions found for this day.</p>}
      {[...byMovie.entries()].map(([movie, list]) => {
        const info = data.info[movie];
        const tags = [...new Set(list.flatMap((s) => [s.format, s.language, s.az_subtitles ? "AZ subs" : null]).filter(Boolean))];
        return (
          <div key={movie} className="rounded-xl bg-wash p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{movie}</span>
              {info && <span className="text-xs text-muted-foreground">{info.year} · {info.runtime_min} min · {info.age_rating} · ★ {info.vote_average}</span>}
            </div>
            {info && <p className="mt-1 text-xs text-muted-foreground">{info.genres.join(", ")} — {info.overview}</p>}
            <div className="mt-1 flex flex-wrap gap-1">{tags.map((t) => <span key={t!} className={`${tag} bg-background`}>{t}</span>)}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {list.map((s) => (
                <button key={s.time + s.hall} onClick={() => setPicked(s)} className={`rounded-xl border-[1.5px] border-foreground px-3 py-1 text-left transition hover:bg-primary hover:text-primary-foreground ${picked === s ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                  <div className="font-semibold">{s.time}</div>
                  <div className="text-[11px] opacity-75">{s.hall}{s.format ? `, ${s.format}` : ""}{s.price_azn ? `, ${s.price_azn} ₼` : ""}</div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {picked && (
        <div className="route-card flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm"><b>{picked.movie}</b><br />{data.date} · {picked.time} · {picked.hall}{picked.language ? ` · ${picked.language}` : ""}{picked.price_azn ? ` · ${picked.price_azn} ₼` : ""}</div>
          <a href="https://cinemastercard.az/en/" target="_blank" rel="noreferrer" className={btn}>Pick seats on CinemaPlus <ExternalLink className="size-4" /></a>
        </div>
      )}
    </div>
  );
}

export function AviaCard({ data: initial }: { data: FlightData }) {
  const [data, setData] = useState(initial);
  const [form, setForm] = useState({ origin: initial.origin || "GYD", destination: initial.destination, depart: initial.depart, return: initial.return, adults: initial.adults || 1 });
  const [loading, setLoading] = useState(false);
  const search = useServerFn(flights);
  const input = "w-full rounded-xl border-[1.5px] border-foreground bg-background px-3 py-2 text-sm";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true);
    try { setData(await search({ data: { ...form, depart: form.depart.length === 10 || form.depart.length === 7 ? form.depart : "", return: form.return.length === 10 ? form.return : "" } })); } finally { setLoading(false); }
  };
  return (
    <div className="route-card space-y-4">
      <div className="font-display text-2xl tracking-wide">{data.origin || "GYD"} <span className="text-muted-foreground">- - -</span> {data.destination || "???"}</div>
      <datalist id="bir-cities">{Object.entries(CITIES).map(([c, code]) => <option key={c} value={code}>{c}</option>)}</datalist>
      <form onSubmit={submit} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <label className="text-xs">From<input list="bir-cities" className={input} value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} required /></label>
        <label className="text-xs">To<input list="bir-cities" className={input} value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="IST" required /></label>
        <label className="text-xs">Departure<input type="date" className={input} value={form.depart.length === 10 ? form.depart : ""} onChange={(e) => setForm({ ...form, depart: e.target.value })} /></label>
        <label className="text-xs">Return<input type="date" className={input} value={form.return} onChange={(e) => setForm({ ...form, return: e.target.value })} /></label>
        <label className="text-xs">Passengers<select className={input} value={form.adults} onChange={(e) => setForm({ ...form, adults: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}</select></label>
        <button disabled={loading} className={`${btn} col-span-2 justify-center sm:col-span-5`}>{loading ? "Searching…" : "Update prices"}</button>
      </form>
      {data.error && <p className="text-sm text-destructive">{data.error}</p>}
      {data.offers.length > 0 && (
        <ul className="space-y-2">
          {data.offers.map((o, i) => (
            <li key={i}>
              <a href={o.link} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-wash px-3 py-2 text-sm hover:bg-primary hover:text-primary-foreground transition">
                <span><b>{o.airline} {o.flight_number}</b> · {o.departure_at.slice(0, 10)} {o.departure_at.slice(11, 16)} · {o.transfers === 0 ? "direct" : `${o.transfers} transfer${o.transfers > 1 ? "s" : ""}`}</span>
                <span className="font-display">from ${o.price_usd}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {data.search_url && !data.offers.length && !data.error && <p className="text-sm text-muted-foreground">No cached prices for this route — check live prices on AviaSales.</p>}
      {data.search_url && <a href={data.search_url} target="_blank" rel="noreferrer" className={btn}>Search on AviaSales <ExternalLink className="size-4" /></a>}
      <p className="text-xs text-muted-foreground">Prices are cached "from" prices. Booking and payment happen on aviasales.com.</p>
    </div>
  );
}

export function ShopCard({ data }: { data: ShopData }) {
  if (data.error) return <div className="route-card text-sm text-destructive">{data.error}</div>;
  if (!data.products.length) return <div className="route-card text-sm text-muted-foreground">No matching products found on Birmarket.</div>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {data.products.map((p) => (
        <div key={p.id} className="route-card flex flex-col gap-2 p-3">
          {p.image_url && <img src={p.image_url} alt={p.name} loading="lazy" className="aspect-square w-full rounded-xl bg-card object-contain" />}
          <div className="line-clamp-3 text-sm font-medium">{p.name}</div>
          <div className="mt-auto">
            <span className="font-display">{p.price_azn} ₼</span>{" "}
            {p.old_price && <s className="text-xs text-muted-foreground">{p.old_price} ₼</s>}
          </div>
          {p.rating != null && <div className="flex items-center gap-1 text-xs text-muted-foreground"><Star className="size-3 fill-current" />{p.rating} ({p.reviews})</div>}
          <a href={p.url} target="_blank" rel="noreferrer" className={`${btn} justify-center text-xs`}>View on Birmarket</a>
        </div>
      ))}
    </div>
  );
}
