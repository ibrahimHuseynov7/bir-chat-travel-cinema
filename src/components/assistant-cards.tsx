// Renders the UI JSON contract: cards (one action each) and quick-reply chips. Taps send the event object back.
import { Fragment, useState } from "react";
import { ExternalLink, Star, CalendarDays } from "lucide-react";
import type { Card, UI, UIEvent } from "@/lib/assistant/core/schemas";

const btn =
  "pill inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground hover:opacity-85 transition";
const chip =
  "pill px-3 py-1.5 text-sm hover:bg-primary hover:text-primary-foreground transition disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground";
const tag = "rounded-full bg-wash px-2 py-0.5 text-xs";

type Showtime = {
  time?: string;
  cinema?: string;
  hall?: string;
  format?: string | null;
  language?: string | null;
  az_subtitles?: boolean;
  price_azn?: number | null;
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const plain = (v: unknown): string =>
  Array.isArray(v)
    ? v.map(plain).filter(Boolean).join(", ")
    : isObj(v)
      ? ""
      : v == null || v === ""
        ? ""
        : String(v);
const HIDDEN = new Set([
  "image",
  "showtimes",
  "genres",
  "rating",
  "reviews",
  "old_price_azn",
  "overview",
  "price_basis",
  "cinemas",
  "session_count",
  "tags",
]);
const money = (amount: number, currency?: string | null) =>
  currency === "AZN"
    ? `${amount} ₼`
    : currency === "USD"
      ? `$${amount}`
      : `${amount} ${currency ?? ""}`;

function Price({ card }: { card: Card }) {
  const p = card.price;
  const amount = p?.from ?? p?.amount;
  if (amount == null) return null;
  const basis = card.attributes?.["price_basis"];
  return (
    <span className="font-display">
      {card.verify ? "from " : ""}
      {money(amount, p?.currency)}
      {typeof basis === "string" && basis && (
        <span className="ml-1 font-sans text-xs text-muted-foreground">{basis}</span>
      )}
    </span>
  );
}

/** Flight option: departure and arrival times are the anchor, so "earlier / later" is easy to judge. */
function FlightBody({ card }: { card: Card }) {
  const a = card.attributes ?? {};
  const s = (k: string) => (a[k] == null ? "" : String(a[k]));
  if (!s("departure_time")) return null; // "Search on Aviasales" link card
  const tags = Array.isArray(a["tags"]) ? (a["tags"] as unknown[]).map(String) : [];
  const offset = Number(a["arrival_day_offset"] ?? 0);
  const pax = Number(a["passengers"] ?? 1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        <span className={`${tag} ${a["stops"] === 0 ? "bg-primary text-primary-foreground" : ""}`}>
          {s("stops_label")}
        </span>
        {tags.map((t) => (
          <span key={t} className={tag}>
            {t}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2">
        <div>
          <div className="font-display text-xl leading-none">{s("departure_time")}</div>
          <div className="mt-1 text-xs text-muted-foreground" title={s("from_airport_name")}>
            {s("from_airport")}
          </div>
        </div>
        <div className="mb-4 flex flex-col items-center text-[11px] text-muted-foreground">
          <span>{s("duration")}</span>
          <span className="h-px w-full bg-foreground/40" />
        </div>
        <div className="text-right">
          <div className="font-display text-xl leading-none">
            {s("arrival_time") || "–"}
            {offset > 0 && <sup className="ml-0.5 font-sans text-[10px]">+{offset}</sup>}
          </div>
          <div className="mt-1 text-xs text-muted-foreground" title={s("to_airport_name")}>
            {s("to_airport")}
          </div>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {s("departure_date")} · {s("airline")} {s("flight_number") && `(${s("flight_number")})`}
      </div>
      {s("return_date") && (
        <div className="rounded-lg bg-wash px-2 py-1 text-xs">
          Return {s("return_date")} · {s("return_departure_time")}
          {s("return_arrival_time") && ` → ${s("return_arrival_time")}`} · {s("return_stops_label")}
        </div>
      )}
      {s("price_note") && (
        <div className="text-[11px] text-muted-foreground">Price is {s("price_note")}</div>
      )}
      {pax > 1 && (
        <div className="text-[11px] text-muted-foreground">Total for {pax} passengers</div>
      )}
    </div>
  );
}

function Action({
  card,
  onEvent,
  disabled,
}: {
  card: Card;
  onEvent: (e: UIEvent, label: string) => void;
  disabled: boolean;
}) {
  const { label, event } = card.action;
  if (event.type === "handoff_url" && event.value) {
    return (
      <a href={event.value} target="_blank" rel="noreferrer" className={`${btn} text-xs`}>
        {label} <ExternalLink className="size-3.5" />
      </a>
    );
  }
  return (
    <button
      disabled={disabled}
      onClick={() => onEvent(event, label)}
      className={`${btn} text-xs disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export function AssistantCard({
  card,
  onEvent,
  disabled,
}: {
  card: Card;
  onEvent: (e: UIEvent, label: string) => void;
  disabled: boolean;
}) {
  const a = card.attributes ?? {};
  const image = typeof a["image"] === "string" ? a["image"] : null;
  const showtimes = Array.isArray(a["showtimes"]) ? (a["showtimes"] as Showtime[]) : [];
  const genres = Array.isArray(a["genres"]) ? (a["genres"] as unknown[]).map(String) : [];
  const isFlight = card.kind === "flight";
  const extra = isFlight
    ? []
    : Object.entries(a)
        .filter(([k, v]) => !HIDDEN.has(k) && plain(v))
        .slice(0, 5);
  return (
    <div className="route-card flex w-[260px] shrink-0 snap-start flex-col gap-2 p-3">
      {image && (
        <img
          src={image}
          alt={card.title}
          loading="lazy"
          className="aspect-square w-full rounded-xl bg-card object-contain"
        />
      )}
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {card.kind.replace(/_/g, " ")}
      </div>
      {isFlight && a["departure_time"] ? (
        <FlightBody card={card} />
      ) : (
        <>
          <div className="line-clamp-3 font-semibold leading-snug">{card.title}</div>
          {card.subtitle && (
            <div className="line-clamp-3 text-xs text-muted-foreground">{card.subtitle}</div>
          )}
        </>
      )}
      {isFlight && a["departure_time"] && card.verify && (
        <div className="text-[11px] text-muted-foreground">{card.subtitle.split(" · ").pop()}</div>
      )}
      {genres.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {genres.slice(0, 3).map((g) => (
            <span key={g} className={tag}>
              {g}
            </span>
          ))}
        </div>
      )}
      {showtimes.length > 0 && (
        <div className="flex flex-col gap-1">
          {showtimes.slice(0, 6).map((s, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 rounded-lg bg-wash px-2 py-1 text-xs"
            >
              <span>
                <b>{s.time}</b> · {s.cinema}
                {s.hall ? `, ${s.hall}` : ""}
              </span>
              <span className="whitespace-nowrap opacity-75">
                {[s.language, s.format, s.az_subtitles ? "AZ subs" : null]
                  .filter(Boolean)
                  .join(" · ")}
                {s.price_azn ? ` · ${s.price_azn} ₼` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {extra.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
          {extra.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k.replace(/_/g, " ")}</dt>
              <dd className="truncate">{plain(v)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {typeof a["rating"] === "number" && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Star className="size-3 fill-current" />
          {String(a["rating"])} ({plain(a["reviews"])})
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-col">
          <Price card={card} />
          {typeof a["old_price_azn"] === "number" && (
            <s className="text-xs text-muted-foreground">{String(a["old_price_azn"])} ₼</s>
          )}
        </div>
      </div>
      <Action card={card} onEvent={onEvent} disabled={disabled} />
      {card.source_url && (
        <a
          href={card.source_url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-[11px] text-muted-foreground underline"
        >
          Source: {hostname(card.source_url)}
        </a>
      )}
    </div>
  );
}
const hostname = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

function DatePicker({
  slot,
  label,
  onEvent,
  disabled,
}: {
  slot: string;
  label: string;
  onEvent: (e: UIEvent, label: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  if (!open)
    return (
      <button disabled={disabled} onClick={() => setOpen(true)} className={chip}>
        <CalendarDays className="mr-1 inline size-3.5" />
        {label}
      </button>
    );
  return (
    <div className="pill flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
      <input
        type="date"
        min={today}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="bg-transparent"
        aria-label="From date"
      />
      <span>→</span>
      <input
        type="date"
        min={from || today}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="bg-transparent"
        aria-label="To date"
      />
      <button
        disabled={!from || disabled}
        onClick={() => {
          const v = to && to !== from ? `${from} to ${to}` : from;
          onEvent({ type: "date_picker", slot, value: v }, v);
          setOpen(false);
        }}
        className="rounded-full bg-primary px-3 py-0.5 text-primary-foreground disabled:opacity-40"
      >
        OK
      </button>
    </div>
  );
}

export function AssistantReply({
  ui,
  onEvent,
  onTypeOwn,
  live,
}: {
  ui: UI;
  onEvent: (e: UIEvent, label: string) => void;
  onTypeOwn: () => void;
  live: boolean;
}) {
  return (
    <>
      {ui.cards.length > 0 && (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
          {ui.cards.map((c) => (
            <AssistantCard key={c.id} card={c} onEvent={onEvent} disabled={!live} />
          ))}
        </div>
      )}
      {ui.quick_replies.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ui.quick_replies.map((q, i) => {
            const e = q.event;
            if (e.type === "date_picker")
              return (
                <DatePicker
                  key={i}
                  slot={e.slot ?? "dates"}
                  label={q.label}
                  onEvent={onEvent}
                  disabled={!live}
                />
              );
            if (e.type === "handoff_url" && e.value)
              return (
                <a key={i} href={e.value} target="_blank" rel="noreferrer" className={chip}>
                  {q.label} <ExternalLink className="inline size-3" />
                </a>
              );
            if (e.type === "free_text")
              return (
                <button key={i} disabled={!live} onClick={onTypeOwn} className={`${chip} italic`}>
                  {q.label}
                </button>
              );
            return (
              <button key={i} disabled={!live} onClick={() => onEvent(e, q.label)} className={chip}>
                {q.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
