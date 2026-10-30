// Server functions called by the chat UI. All AI calls, scraping and secrets stay on the server.
import { createServerFn } from "@tanstack/react-start";
import { RequestSchema } from "./assistant/core/schemas";

/** One assistant turn: Orchestrator -> Module Agent / direct adapter -> Responder (see src/lib/assistant). */
export const assistantTurn = createServerFn({ method: "POST" })
  .validator((d: unknown) => RequestSchema.parse(d))
  .handler(async ({ data }) => {
    const { warmUp } = await import("./scrapers.server");
    warmUp(); // keep the cinema / Birmarket snapshots fresh in the background
    const { warmFlightData } = await import("./assistant/tools/flights");
    warmFlightData(); // airports / airlines lists download while the Orchestrator runs
    const { handleTurn } = await import("./assistant/core/turn");
    return handleTurn(data);
  });

/** Enabled modules from the registry, for the welcome screen. */
export const assistantModules = createServerFn({ method: "GET" }).handler(async () => {
  const { registry } = await import("./assistant/core/registry");
  return registry().map((e) => ({ id: e.id, display_name: e.display_name }));
});
