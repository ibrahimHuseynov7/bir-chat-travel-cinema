import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { BirLogo } from "@/components/bir-logo";
import { AviaCard, CinemaCard, ShopCard } from "@/components/route-cards";
import { chat } from "@/lib/chat.functions";
import type { ChatResult, Route as R } from "@/lib/bir";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bir Chat — movies, flights and shopping in one chat" },
      { name: "description", content: "Find CinemaPlus sessions, AviaSales flights and Birmarket products by just typing what you need." },
      { property: "og:title", content: "Bir Chat" },
      { property: "og:description", content: "Movies, flights and shopping in one chat." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Msg = { id: number; role: "user" | "assistant"; text: string; result?: ChatResult };
const NAMES: Record<R, string> = { cinema: "CinemaPlus", avia: "AviaSales", shopping: "Shopping Assistant", general: "Bir Chat" };

function Index() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [active, setActive] = useState<R | null>(null);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const send = useServerFn(chat);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, waiting]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const sendMessage = async (value: string) => {
    const text = value.trim();
    if (!text || waiting) return;
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.text.slice(0, 4000) }));
    setMessages((m) => [...m, { id: Date.now(), role: "user", text }]);
    setInput(""); setError(null); setWaiting(true);
    try {
      const result = await send({ data: { message: text.slice(0, 2000), history, active } });
      setActive(result.route === "general" ? active : result.route);
      setMessages((m) => [...m, { id: Date.now(), role: "assistant", text: result.reply || NAMES[result.route], result }]);
    } catch {
      setError("Sorry, I couldn't get a reply. Please try again.");
    } finally {
      setWaiting(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="border-b-2 border-foreground">
        <div className="mx-auto flex max-w-[820px] items-center gap-2 px-4 py-3">
          <button onClick={() => { setMessages([]); setActive(null); }} className="flex items-center gap-2">
            <BirLogo active={active} className="h-[34px] w-[21px]" />
            <span className="font-display text-xl">bir chat</span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5 px-4 py-6">
          {!messages.length && (
            <div className="flex flex-col items-center gap-5 py-16 text-center">
              <BirLogo className="h-[128px] w-[80px]" />
              <h1 className="font-display max-w-md text-3xl sm:text-4xl">Movies, flights and shopping in one chat</h1>
              <p className="text-muted-foreground">Type what you need.</p>
            </div>
          )}
          {messages.map((m) => m.role === "user" ? (
            <div key={m.id} className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">{m.text}</div>
          ) : (
            <div key={m.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <BirLogo active={m.result?.route ?? null} className="h-[16px] w-[10px] text-foreground" /> Routed to <b className="text-foreground">{NAMES[m.result?.route ?? "general"]}</b>
              </div>
              <div className="w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-wash px-4 py-2 text-sm">{m.text}</div>
              {m.result?.route === "cinema" && <CinemaCard data={m.result.data} onPick={(t) => void sendMessage(t)} />}
              {m.result?.route === "avia" && <AviaCard data={m.result.data} />}
              {m.result?.route === "shopping" && <ShopCard data={m.result.data} />}
            </div>
          ))}
          {waiting && (
            <div role="status" aria-label="Bir Chat is typing" className="flex w-fit gap-1 rounded-2xl bg-wash px-4 py-3">
              {[0, 1, 2].map((i) => <span key={i} className="typing-dot size-2 rounded-full bg-foreground" style={{ animationDelay: `${i * 0.15}s` }} />)}
            </div>
          )}
          {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
          <div ref={endRef} />
        </div>
      </main>

      <form onSubmit={(e) => { e.preventDefault(); void sendMessage(input); }} className="px-4 pb-4 pt-2">
        <div className="mx-auto max-w-[820px]">
          <div className="pill flex items-center gap-2 py-1.5 pl-5 pr-1.5">
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} aria-label="Message"
              placeholder="Movies tonight at 28 Mall? Flight to Istanbul? A gift under 100 ₼?" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            <button aria-label="Send" disabled={waiting || !input.trim()} className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"><ArrowUp className="size-4" /></button>
          </div>
          <div className="mt-1.5 text-right">
            <button type="button" onClick={() => { setMessages([]); setActive(null); setError(null); }} className="text-xs underline">New chat</button>
          </div>
        </div>
      </form>
    </div>
  );
}
