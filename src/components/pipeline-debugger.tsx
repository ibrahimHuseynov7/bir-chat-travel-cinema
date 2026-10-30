// Side panel showing one turn's pipeline telemetry: Orchestrator -> Module (tools) -> Responder.
import { useState, type ReactNode } from "react";
import { Brain, Bug, Check, ChevronDown, Clock, Copy, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { TurnTrace } from "@/lib/assistant/core/turn";

export type DebugTurn = { id: number; trace: TurnTrace };

const json = (v: unknown) => JSON.stringify(v, null, 2);
const pre = "max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Copy JSON"
      className="size-7 text-muted-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function Section({
  title,
  icon,
  copy,
  children,
}: {
  title: string;
  icon?: ReactNode;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3">
        <CollapsibleTrigger className="group flex flex-1 items-center gap-2 text-left text-sm font-semibold">
          {icon}
          {title}
          <ChevronDown className="ml-auto size-4 transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        {copy != null && <CopyButton text={copy} />}
      </div>
      <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

const ms = (v: number | null) => (v == null ? "—" : `${v} ms`);

export function PipelineDebugger({
  turns,
  selected,
  onSelect,
  onClose,
}: {
  turns: DebugTurn[];
  selected: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
}) {
  const turn = turns.find((t) => t.id === selected);
  const tr = turn?.trace;
  return (
    <Sheet open={!!turn} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="space-y-0 border-b border-border px-5 py-4 text-left">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-primary">
              <Bug className="size-5" />
            </span>
            <div>
              <SheetTitle className="text-base">Pipeline Debugger</SheetTitle>
              <SheetDescription className="text-xs">
                Multi-agent orchestrator &amp; tool telemetry
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 text-sm">
          <span className="text-muted-foreground">Turn:</span>
          {turns.map((t, i) => (
            <Button
              key={t.id}
              size="sm"
              variant={t.id === selected ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => onSelect(t.id)}
            >
              #{i + 1}
            </Button>
          ))}
        </div>
        {tr && (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Provider / Model
                </div>
                <div className="truncate font-mono text-xs" title={`${tr.provider} / ${tr.model}`}>
                  {tr.provider} / {tr.model}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Retries
                </div>
                <div className="font-mono text-xs">{tr.retries} attempts</div>
              </div>
            </div>
            {tr.error && (
              <div className="rounded-xl border border-destructive/40 p-3 font-mono text-xs text-destructive">
                {tr.error}
              </div>
            )}

            <Section title="Latency Breakdown" icon={<Clock className="size-4 text-primary" />}>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 font-mono text-xs">
                <dt>Orchestrator:</dt>
                <dd className="text-right font-semibold">{ms(tr.latency.orchestrator)}</dd>
                {tr.latency.module != null && (
                  <>
                    <dt>Module:</dt>
                    <dd className="text-right font-semibold">{ms(tr.latency.module)}</dd>
                  </>
                )}
                <dt>Responder:</dt>
                <dd className="text-right font-semibold">{ms(tr.latency.responder)}</dd>
                <dt>Total:</dt>
                <dd className="text-right font-semibold">{ms(tr.latency.total)}</dd>
              </dl>
            </Section>

            {!!tr.llm_calls?.length && (
              <Section
                title={`LLM Calls (${tr.llm_calls.length})`}
                icon={<Brain className="size-4 text-primary" />}
              >
                <div className="flex flex-col gap-2">
                  {tr.llm_calls.map((c, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-border bg-muted p-3 font-mono text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-primary">{c.role}</span>
                        {c.tool_calls > 0 && (
                          <span className="text-muted-foreground">→ {c.tool_calls} tool calls</span>
                        )}
                        <span className="ml-auto font-semibold">{c.ms} ms</span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        in {c.prompt_tokens ?? "?"}
                        {c.cached_tokens ? ` (${c.cached_tokens} cached)` : ""} · out{" "}
                        {c.completion_tokens ?? "?"}
                        {c.reasoning_tokens != null ? ` (${c.reasoning_tokens} reasoning)` : ""} ·
                        effort {c.effort ?? "—"}
                      </div>
                      {(c.attempts > 1 || c.wait_ms > 0) && (
                        <div className="mt-1 text-destructive">
                          {c.attempts} HTTP attempts
                          {c.wait_ms ? `, ${c.wait_ms} ms waiting (rate limit)` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section
              title={`Tool Calls (${tr.tool_calls.length})`}
              icon={<Cpu className="size-4 text-primary" />}
            >
              {tr.tool_calls.length ? (
                <div className="flex flex-col gap-3">
                  {tr.tool_calls.map((c, i) => (
                    <div key={i} className="rounded-lg border border-border bg-muted p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-primary">
                          {c.tool}
                        </span>
                        <span className="ml-auto flex gap-1.5 text-[10px]">
                          {c.items != null && (
                            <span className="rounded-full border border-border bg-background px-2 py-0.5">
                              {c.items} items
                            </span>
                          )}
                          {c.ms != null && (
                            <span className="rounded-full border border-border bg-background px-2 py-0.5">
                              {c.ms} ms
                            </span>
                          )}
                          {!c.ok && (
                            <span className="rounded-full bg-destructive px-2 py-0.5 text-white">
                              failed
                            </span>
                          )}
                        </span>
                      </div>
                      <pre className="overflow-x-auto font-mono text-xs">{c.args}</pre>
                      {c.note && <p className="mt-2 text-xs text-destructive">{c.note}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  No tool calls made in this turn.
                </p>
              )}
            </Section>

            <Section title="Orchestrator Decision" copy={json(tr.decision)}>
              <pre className={pre}>{json(tr.decision)}</pre>
            </Section>
            <Section title="Module Result" copy={json(tr.module_result)}>
              <pre className={pre}>{json(tr.module_result)}</pre>
            </Section>
            <Section title="Responder Output" copy={json(tr.responder)}>
              <pre className={pre}>{json(tr.responder)}</pre>
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
