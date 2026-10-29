import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { BirLogo } from "@/components/bir-logo";
import { AssistantReply } from "@/components/assistant-cards";
import { assistantModules, assistantTurn } from "@/lib/chat.functions";
import type { Route as LogoCell } from "@/lib/bir";
import type { UI, UIEvent } from "@/lib/assistant/core/schemas";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bir Chat — trips, movies and shopping in one chat" },
      {
        name: "description",
        content:
          "Plan trips, find CinemaPlus sessions and Birmarket products by just typing what you need.",
      },
      { property: "og:title", content: "Bir Chat" },
      { property: "og:description", content: "Trips, movies and shopping in one chat." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Lang = "az" | "ru" | "en";
type Msg = {
  id: number;
  role: "user" | "assistant";
  text: string;
  ui?: UI;
  module?: string | null;
};
// Logo highlight per module (cosmetic only; unknown modules simply show the full logo).
const LOGO: Record<string, LogoCell> = {
  travel_planner: "avia",
  cinema: "cinema",
  shopping_assistant: "shopping",
};
const T: Record<
  Lang,
  {
    title: string;
    sub: string;
    hint: string;
    error: string;
    newChat: string;
    retry: string;
    stages: [string, string, string];
  }
> = {
  az: {
    title: "Səyahət, kino və alış-veriş bir çatda",
    sub: "Nə lazımdırsa yazın və ya seçin.",
    hint: "Novruzda vizasız hara gedim? Bu axşam kinoda nə var?",
    error: "Cavab ala bilmədim.",
    newChat: "Yeni çat",
    retry: "Yenidən cəhd et",
    stages: ["Düşünürəm…", "Məlumat axtarıram…", "Cavabı hazırlayıram…"],
  },
  ru: {
    title: "Поездки, кино и покупки в одном чате",
    sub: "Напишите или выберите, что нужно.",
    hint: "Куда поехать без визы? Что идёт в кино сегодня?",
    error: "Не удалось получить ответ.",
    newChat: "Новый чат",
    retry: "Повторить",
    stages: ["Думаю…", "Ищу данные…", "Готовлю ответ…"],
  },
  en: {
    title: "Trips, movies and shopping in one chat",
    sub: "Type or tap what you need.",
    hint: "Where can I go visa-free? What's on at the cinema tonight?",
    error: "Sorry, I couldn't get a reply.",
    newChat: "New chat",
    retry: "Try again",
    stages: ["Thinking…", "Looking things up…", "Putting it together…"],
  },
};

function Index() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [state, setState] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("az");
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState<{ message?: string; event?: UIEvent; label: string } | null>(
    null,
  );
  const [modules, setModules] = useState<{ id: string; display_name: string }[]>([]);
  const [stage, setStage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const turn = useServerFn(assistantTurn);
  const listModules = useServerFn(assistantModules);
  const t = T[lang];
  const lastUi = [...messages].reverse().find((m) => m.role === "assistant")?.ui;
  const activeModule = [...messages].reverse().find((m) => m.module)?.module ?? null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, waiting]);
  // Progress text while a turn runs: routing -> data lookup -> writing the reply.
  useEffect(() => {
    if (!waiting) return setStage(0);
    const a = setTimeout(() => setStage(1), 2500);
    const b = setTimeout(() => setStage(2), 9000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [waiting]);
  useEffect(() => {
    inputRef.current?.focus();
    void listModules()
      .then(setModules)
      .catch(() => setModules([]));
  }, [listModules]);

  const run = async (req: { message?: string; event?: UIEvent }, label: string) => {
    if (waiting) return;
    setMessages((m) => [...m, { id: Date.now(), role: "user", text: label }]);
    setInput("");
    setFailed(null);
    setWaiting(true);
    try {
      const res = await turn({
        data: { state, ...req, user: { language: lang, citizenship: "AZ", home_city: "Baku" } },
      });
      setState(res.state);
      if (res.ui)
        setMessages((m) => [
          ...m,
          {
            id: Date.now() + 1,
            role: "assistant",
            text: res.ui!.text,
            ui: res.ui!,
            module: res.meta.module,
          },
        ]);
    } catch {
      setFailed({ ...req, label });
    } finally {
      setWaiting(false);
      inputRef.current?.focus();
    }
  };
  const sendText = (v: string) => {
    const text = v.trim().slice(0, 2000);
    if (text) void run({ message: text }, text);
  };
  const sendEvent = (event: UIEvent, label: string) => {
    if (event.type === "handoff_url") {
      if (event.value) window.open(event.value, "_blank", "noopener");
      return;
    }
    if (event.type === "free_text") {
      inputRef.current?.focus();
      return;
    }
    void run({ event }, label);
  };
  const reset = () => {
    setMessages([]);
    setState(null);
    setFailed(null);
    setInput("");
  };

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="border-b-2 border-foreground">
        <div className="mx-auto flex max-w-[820px] items-center gap-2 px-4 py-3">
          <button onClick={reset} className="flex items-center gap-2">
            <BirLogo
              active={activeModule ? (LOGO[activeModule] ?? null) : null}
              className="h-[34px] w-[21px]"
            />
            <span className="font-display text-xl">bir chat</span>
          </button>
          <select
            aria-label="Language"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            className="pill ml-auto bg-background px-3 py-1 text-sm"
          >
            <option value="az">AZ</option>
            <option value="ru">RU</option>
            <option value="en">EN</option>
          </select>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[820px] flex-col gap-5 px-4 py-6">
          {!messages.length && (
            <div className="flex flex-col items-center gap-5 py-16 text-center">
              <BirLogo className="h-[128px] w-[80px]" />
              <h1 className="font-display max-w-md text-3xl sm:text-4xl">{t.title}</h1>
              <p className="text-muted-foreground">{t.sub}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {modules.map((m) => (
                  <button
                    key={m.id}
                    onClick={() =>
                      sendEvent(
                        { type: "select", slot: "module", value: m.display_name },
                        m.display_name,
                      )
                    }
                    className="pill px-4 py-2 text-sm hover:bg-primary hover:text-primary-foreground transition"
                  >
                    {m.display_name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div
                key={m.id}
                className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground"
              >
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-3">
                <div className="flex items-start gap-2">
                  <BirLogo
                    active={m.module ? (LOGO[m.module] ?? null) : null}
                    className="mt-1 h-[22px] w-[14px] shrink-0 text-foreground"
                  />
                  <div className="w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-wash px-4 py-2 text-sm">
                    {m.text}
                  </div>
                </div>
                {m.ui && (
                  <AssistantReply
                    ui={m.ui}
                    onEvent={sendEvent}
                    onTypeOwn={() => inputRef.current?.focus()}
                    live={m.ui === lastUi && !waiting}
                    lang={lang}
                  />
                )}
              </div>
            ),
          )}
          {waiting && (
            <div
              role="status"
              aria-label="Bir Chat is typing"
              className="flex w-fit items-center gap-3 rounded-2xl bg-wash px-4 py-3"
            >
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="typing-dot size-2 rounded-full bg-foreground"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </span>
              <span className="text-xs text-muted-foreground">{t.stages[stage]}</span>
            </div>
          )}
          {failed && (
            <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
              {t.error}
              <button
                onClick={() => {
                  const f = failed;
                  setMessages((m) => m.slice(0, -1));
                  void run(
                    f.event ? { event: f.event } : { message: f.message ?? f.label },
                    f.label,
                  );
                }}
                className="underline"
              >
                {t.retry}
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendText(input);
        }}
        className="px-4 pb-4 pt-2"
      >
        <div className="mx-auto max-w-[820px]">
          <div className="pill flex items-center gap-2 py-1.5 pl-5 pr-1.5">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={2000}
              aria-label="Message"
              placeholder={lastUi?.input_hint || t.hint}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              aria-label="Send"
              disabled={waiting || !input.trim()}
              className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
          <div className="mt-1.5 text-right">
            <button type="button" onClick={reset} className="text-xs underline">
              {t.newChat}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
