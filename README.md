# Bir Chat — Lifestyle Assistant MVP

Conversational assistant with three modules (travel planning, cinema, shopping) built to the customer's
"Lifestyle Assistant MVP — Agent Architecture & Prompts" spec: three agents per turn (Orchestrator ->
Module Agent -> Responder), a YAML tool registry as the only plug-in point, session state in code,
facts only from tool results with source URLs, and a UI JSON reply with tappable options.

## Where things are
- `src/lib/assistant/registry.yaml.ts` - THE REGISTRY (travel_planner, cinema, shopping_assistant, disabled weather)
- `src/lib/assistant/core/` - prompts, JSON schemas, validation (retry once -> fallback), state, turn pipeline
- `src/lib/assistant/agents/` - Orchestrator, Module Agent (one template for all modules), Responder
- `src/lib/assistant/tools/adapters.ts` - registry adapters -> data sources:
  - `cinemaplus_v1` -> CineMastercard (CinemaPlus) cinema pages via `src/lib/scrapers.server.ts`
  - `aviasales_v1` -> AviaSales cached prices (Travelpayouts API)
  - `websearch_v1` / `fetch_v1` -> web search (Tavily or Brave) + page reader for visa rules, hotels, buses
  - `birmarket_v1` (direct executor) -> Birmarket catalog snapshot (until a shopping endpoint exists)
- `src/lib/chat.functions.ts` - server functions `assistantTurn` and `assistantModules`
- `src/routes/index.tsx`, `src/components/assistant-cards.tsx` - chat UI that renders the UI JSON contract
- `src/test/assistant-flow.test.ts` - the spec's 6-turn demo flow end to end (real scraper code, faked network/model)

## Secrets (Lovable Cloud -> Secrets)
| Secret | Needed for |
|---|---|
| `COMPANY_AI_KEY` | Azure OpenAI (deployment `gpt-5.4-superchat` on `ai-ds-coe-resource`) |
| `TRAVELPAYOUTS_TOKEN` (+ optional `TRAVELPAYOUTS_MARKER`) | flight prices |
| `TAVILY_API_KEY` | visa rules, hotels, buses, destination ideas (or `SEARCH_PROVIDER=brave` + `BRAVE_API_KEY`) |
| `STATE_SECRET` (optional) | signs the session-state token; defaults to a key derived from `COMPANY_AI_KEY` |
| `ASSISTANT_DEBUG=true` (optional) | returns every agent's JSON with each reply |

Every turn's agent inputs/outputs are written to the server log as `[assistant-turn] {...}`.

| `BIRMARKET_LIVE_LOOKUP=false` (optional) | turns off live Birmarket tag/brand page lookups (snapshot only) |
| `AZURE_REASONING_ORCHESTRATOR` / `_MODULE_AGENT` / `_RESPONDER` (optional) | override reasoning effort, e.g. `low` (default: lowest the deployment accepts) |

## What changed in v2
- Speed: lowest accepted reasoning effort per agent (auto-detected), parallel tool calls, tools return
  ready-made items the agent picks by `ref`, compact Responder input (cards are ids only), caching of
  searches / flight prices / place lookups, a 40 s Module Agent budget, staged progress text in the chat.
- Flights (`tools/flights.ts`): up to 8 options (cheapest, direct, fastest, with stops, spread over the day);
  departure and arrival times (arrival in the destination's time zone, "+1" for next day), airports, duration,
  stops, airline name; filters for earlier / later / direct only / max price; any city or airport name.
- Origin: a stated foreign citizenship ("Italian passport") sets the profile and stops assuming Baku; the
  assistant asks for the departure city/airport. Cities with several airports get "From MXP"-style chips.
- Shopping: live Birmarket tag/brand listing pages (robots-allowed, cached 30 min) on top of the snapshot;
  accessory-aware ranking; prices with non-breaking spaces parse correctly.
- Cinema: `cinema_list` tool - cinemas/malls as selectable cards.
- Budget: parsed from the user's words and enforced in code (currency conversion via open.er-api.com).
- Fewer questions: slots with a `fallback` are filled and results shown first; ONE follow-up question after.
  New registry slot fields: `fallback`, `ask_first`, `default_if`, `options_hint`; module field `max_cards`.

## Flights when the exact trip is not cached (v2.1)
The Travelpayouts Data API returns prices other users found recently (a cache), while aviasales.com runs a
live search. Exact round trips are often missing from the cache, so `tools/flights.ts` falls back in order:
exact round trip -> outbound and return as separate one-way options -> the airport's whole city (kept to that
airport when possible) -> nearest cached dates within 3 days (`grouped_prices`). Cards show "Outbound" /
"Return" / "Nearby date" tags; leg prices are one-way. For full live results like aviasales.com, apply for the
Travelpayouts Flight Search API (real-time) and replace the `aviasales_v1` adapter.

## Gifts, price filters, cinema picked first (v2.2)
- Gifts (`tools/gifts.ts`): "a present for my mom" -> query `hədiyyə` + slot `recipient`. Code picks the recipient
  group (women / men / kids / anyone, in en/az/ru), then one best-rated Birmarket product per gift idea (perfume,
  handbag, jewelry, beauty, kitchen, ...) as a varied mix; kids', men's and accessory listings are skipped for mom.
  "a perfume for mom" searches the product words as usual.
- Price filters: every shopping result carries `filters` (price-range chips built from the found prices, plus
  "Any price" and a custom min-max input in the app). A chip tap sets `budget_min` / `budget_max` and reruns the
  search in code, without an Orchestrator call. Typed budgets ("under 80 manat") still work and show as active.
- Cinema: new registry slot field `choose_first: <tool>`. The cinema slot uses `cinema_list`, so "I want to go to
  the cinema" first shows the cinemas in the user's city as cards (no model call for the list); tapping one fills
  the slot and shows the films and sessions there. Naming a cinema up front skips the list.

## Adding a module
Add one entry to `registry.yaml.ts`. If it uses web search, reuse `websearch_v1`/`fetch_v1` - no code change
(set `enabled: true` on the included `weather` entry to try it). A new data source = one adapter in `tools/adapters.ts`.

## Known limits
- Session state travels as a signed token (no database): refreshing the page starts a new chat.
- Cinema covers CineMastercard (CinemaPlus) cinemas, today and tomorrow only (what the site publishes).
  Park Cinema's site loads showtimes with JavaScript and is not covered.
- Flight prices are AviaSales cached "from" prices (marked "check price on site"); booking happens on aviasales.com.
  The cache has no via-airport for transit flights, only the number of stops.
- Hotel, bus and train prices come from web search results (Hotellook closed in Oct 2025), marked "check price on site".
- The Birmarket catalog is refreshed in the background; right after a cold start shopping shows a Birmarket search link.
- Open items from the spec: shopping endpoint (replaces `birmarket_v1`), "no night flights" time window.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/1795e30d-3b4b-4cf2-93c9-9b62eee4773a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
