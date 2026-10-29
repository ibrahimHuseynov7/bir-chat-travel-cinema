// ============================================================================
// TOOL REGISTRY — the plug-in contract (customer doc: "Tool Registry: the plug-in contract").
// Adding a module = one YAML entry below (+ one adapter in tools/adapters.ts only if it needs a
// NEW data source; existing adapters are reusable by name). No prompt and no other code is edited.
// Only `enabled: true` entries are loaded. Kept as a string so it ships inside the server bundle.
// ============================================================================
export default `
- id: travel_planner
  display_name: Travel planning
  enabled: true
  version: 2
  owner: bir-chat
  executor: agent
  description: Plans trips - destination ideas (incl. visa-free for the user's citizenship), flights (direct and with stops), buses, trains, hotels with prices, short day plans.
  use_when: [trip, holiday, vacation, flight, plane ticket, bus ticket, train ticket, hotel, "where can I go visa-free", "plan 3 days in X", earlier or later flight, cheaper hotel]
  not_when: [taxi or ride inside the city, restaurant booking, cinema tickets]
  max_cards: 10
  required_slots:
    - name: dates
      ask: "When do you want to travel?"
      example_options: [Novruz holidays, Next weekend, Pick dates]
      picker: {type: date, option: Pick dates}
      fallback: "flexible - cheapest dates in the next 30 days"
      ask_first: true
    - name: destination_or_criteria
      ask: "Where to, or what kind of place?"
      example_options: [Visa-free options, Beach, City break]
      fallback: "popular destinations"
    - name: origin
      ask: "From which city and airport will you depart?"
      default: profile.home_city
      default_if: profile.home_city_confirmed
      options_hint: "3-4 main cities with airports in the user's citizenship country (e.g. IT -> Rome, Milan, Venice)"
      hint: "city or airport exactly as the user said it (e.g. 'Milan', 'Milan Malpensa')"
  optional_slots:
    - {name: travelers, hint: "number of adults"}
    - {name: budget, hint: "amount + currency + basis as the user said it, e.g. 'under 500 AZN', '80 USD per night'"}
    - {name: transport, example_options: [Flight, Bus, Train, Any]}
    - {name: constraints, hint: "time windows and preferences, e.g. 'depart before 10:00', 'direct only', 'no night flights'"}
  max_tool_calls: 4
  tools:
    - name: search_flights
      description: >-
        Cached flight prices from Aviasales. Returns up to 8 options (direct AND with stops) as refs with departure
        time, arrival time, stops, duration, airline, departure airport and price_per_person (USD), plus a search_link_ref.
        Accepts city or airport names in any language or IATA codes.
      input_schema:
        type: object
        properties:
          origin: {type: string, description: "departure city or airport, e.g. 'Baku', 'Milan', 'MXP'"}
          destination: {type: string, description: "arrival city or airport, e.g. 'Istanbul', 'IST'"}
          depart: {type: string, description: "YYYY-MM-DD; YYYY-MM for the cheapest dates in a month; empty = flexible"}
          return: {type: string, description: "YYYY-MM-DD or empty for one-way"}
          adults: {type: integer}
          direct_only: {type: boolean}
          depart_after: {type: string, description: "HH:MM local departure time, for 'later' requests"}
          depart_before: {type: string, description: "HH:MM local departure time, for 'earlier' / 'no night flights'"}
          max_price: {type: number, description: "max price per person"}
          max_price_currency: {type: string, description: "currency of max_price, e.g. AZN, USD"}
        required: [origin, destination]
      adapter: aviasales_v1
    - name: web_search
      description: Search the web for visa rules, hotels with prices, bus and train tickets with prices, and destination ideas. Returns title, url, snippet.
      input_schema:
        type: object
        properties:
          query: {type: string}
          site_filter: {type: array, items: {type: string}, description: "optional list of domains"}
        required: [query]
      adapter: websearch_v1
    - name: fetch_page
      description: Read one page from the search results to get exact prices, times or visa rules.
      input_schema:
        type: object
        properties:
          url: {type: string}
        required: [url]
      adapter: fetch_v1
  module_instructions: |
    - Resolve relative dates (Novruz, next weekend) against today; state the exact dates in summary. Flexible dates: call search_flights with depart empty.
    - Visa-free status depends on user.citizenship. Confirm it on an official or reliable page via web_search; give source_url.
    - Open request ("somewhere visa-free", "popular destinations"): return 3 destinations (kind "destination", action "select", value = city name). Flights and hotels only after the user picks one.
    - Picked destination: call search_flights AND web_search for hotels in the same step. Return all flight refs + 2-3 hotels.
    - Flights: origin = slots.origin. Never assume Baku. Items = {"ref": ...} for ALL search_flights options, in the tool's order (outbound AND return legs when the tool split them). No options -> use search_link_ref, status "partial".
    - Round trips: always pass depart AND return to search_flights; the tool finds one-way legs or nearby dates by itself when the exact round trip is not cached.
    - "Earlier"/"later": read departure times in previous_results and use depart_before / depart_after. "Direct" -> direct_only. "No night flights" -> depart_after 06:00 and depart_before 22:00.
    - Hotels: web_search "<city> hotels price per night <month year>" (add the budget if given). Only hotels whose price appears in a result: price = per-night amount + currency as shown, attributes.price_basis "per night", verify=true, action handoff_url = that page.
    - Buses/trains: web_search "<from> to <to> bus|train ticket price". kind "bus"/"train", price + currency, departure times in attributes when shown, verify=true.
    - Budget: pass it to search_flights (max_price + max_price_currency) and never return an item above it.
  result_kinds: [destination, flight, bus, train, hotel, itinerary_day]

- id: cinema
  display_name: Cinema
  enabled: true
  version: 2
  owner: bir-chat
  executor: agent
  description: Movie suggestions, what is playing, showtimes at CinemaPlus/CineMastercard cinemas (malls) in Azerbaijan, the list of cinemas/malls, ticket purchase handoff.
  use_when: [movie, film, cinema, kino, showtimes, seans, tickets for a movie, "what to watch tonight", which cinemas or malls, cinema in a mall]
  not_when: [TV series at home, plane tickets]
  max_cards: 8
  required_slots:
    - name: date
      ask: "When do you want to go?"
      example_options: [Tonight, Tomorrow]
      fallback: today
  optional_slots:
    - {name: city, default: profile.home_city}
    - {name: genre, example_options: [Comedy, Action, Family, Drama]}
    - {name: language}
    - name: cinema
      ask: "Which cinema do you want to go to?"
      hint: "cinema / mall name, e.g. 28 Mall, Ganjlik Mall"
      example_options: [Any cinema]
      choose_first: cinema_list
  max_tool_calls: 3
  tools:
    - name: cinema_sessions
      description: >-
        Real sessions from the CineMastercard (CinemaPlus) website for one date (today or tomorrow only).
        Returns movies as refs with genres, cinemas, first showtimes and the lowest price.
      input_schema:
        type: object
        properties:
          date: {type: string, description: "YYYY-MM-DD (today or tomorrow)"}
          cinemas: {type: array, items: {type: string}, description: "cinema / mall names or slugs; empty = all cinemas in the city"}
          city: {type: string, description: "Baku, Ganja, Sumgayit or Shamakhi; default Baku"}
          movie: {type: string, description: "optional part of a movie title"}
          language: {type: string, description: "optional: Aze, Rus, Eng or Tur"}
        required: [date]
      adapter: cinemaplus_v1
    - name: cinema_list
      description: The CinemaPlus cinemas (most are in malls) with their city, as refs. Use when the user asks which cinemas or malls there are, or wants to choose a cinema.
      input_schema:
        type: object
        properties:
          city: {type: string, description: "optional city filter"}
      adapter: cinemaplus_list_v1
  module_instructions: |
    - Only today and tomorrow exist on the cinema site; for other dates return status "need_input" with options Tonight / Tomorrow.
    - The user asks which cinemas / malls there are, or wants to pick one: call cinema_list and return all its refs (kind "cinema").
    - A cinema or mall is named (slots.cinema): pass it in cinemas. slots.cinema "Any cinema": leave cinemas empty (all cinemas in the city).
    - Otherwise call cinema_sessions and return movie refs (max 6), most sessions first, or matching genre / topic_summary first.
    - "Suggest a movie": use genre and topic_summary; prefer movies that are actually playing.
  result_kinds: [movie, cinema]

- id: shopping_assistant
  display_name: Shopping
  enabled: true
  version: 2
  owner: bir-chat
  executor: direct
  description: Finds and compares products in the Birmarket marketplace catalogue.
  use_when: [buy, product, price of an item, compare products, gift ideas, "present for my mom", "gift for my dad / wife / kid", birthday present, phone, iphone, laptop]
  not_when: [travel or cinema tickets]
  max_cards: 6
  required_slots:
    - name: query
      ask: "What are you looking for?"
      example_options: [Smartphone, Headphones, Gift ideas]
      hint: "Azerbaijani product-type word + brand + model exactly as the user said it. Keep model names and numbers. Examples: iphone -> 'smartfon apple iphone'; iphone 16 pro -> 'smartfon apple iphone 16 pro'; samsung phone -> 'smartfon samsung'; headphones -> qulaqlıq; airpods -> 'qulaqlıq apple airpods'; laptop -> noutbuk; macbook -> 'noutbuk apple macbook'; suitcase -> çamadan; ball -> top; toy -> oyuncaq; a gift / present with no product named -> 'hədiyyə' (who it is for goes in recipient); a gift with a product named ('perfume for mom') -> the product words only, e.g. ətir"
  optional_slots:
    - {name: recipient, hint: "who a gift is for, as the user said it, e.g. mom, dad, wife, son, friend"}
    - {name: budget_min, hint: "number in AZN"}
    - {name: budget_max, hint: "number in AZN"}
  tools:
    - name: birmarket_catalog
      description: Birmarket listing pages for the query (live) plus the catalog snapshot (refreshed in the background).
      input_schema: {type: object, properties: {query: {type: string}}, required: [query]}
      adapter: birmarket_v1
  result_kinds: [product]

# Dummy 4th module for the plug-in test: set enabled: true - nothing else changes (needs TAVILY_API_KEY).
- id: weather
  display_name: Weather
  enabled: false
  version: 1
  owner: bir-chat
  executor: agent
  description: Weather forecast for a city and date.
  use_when: [weather, forecast, temperature, "will it rain"]
  not_when: [climate for choosing a holiday destination]
  required_slots:
    - name: city
      ask: "Which city?"
      example_options: [Baku, Istanbul, Dubai]
  optional_slots:
    - {name: date, default: today}
  max_tool_calls: 3
  tools:
    - name: web_search
      description: Search the web for weather forecasts. Returns title, url, snippet.
      input_schema: {type: object, properties: {query: {type: string}}, required: [query]}
      adapter: websearch_v1
    - name: fetch_page
      description: Read one forecast page.
      input_schema: {type: object, properties: {url: {type: string}}, required: [url]}
      adapter: fetch_v1
  module_instructions: |
    - Return one item (kind "forecast") per day asked, with high/low temperature and conditions in attributes, from a forecast page.
  result_kinds: [forecast]
`;
