// @vitest-environment node
// Birmarket MP Catalog API search (ported from the Birmarket shopping assistant). Only the network is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/scrapers.server", async (orig) => {
  const real = await orig<typeof import("@/lib/scrapers.server")>();
  return { ...real, warmUp: () => {}, getBirmarketProducts: () => [] };
});

const cat = await import("@/lib/birmarket-catalog.server");
const { DIRECT_ADAPTERS } = await import("@/lib/assistant/tools/adapters");

const apiProduct = (
  id: number,
  name: string,
  price: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  slugged_name: name.toLowerCase().replace(/\s+/g, "-"),
  status: "active",
  brand: name.split(" ")[1],
  main_img: { medium: `https://img.test/${id}.jpg` },
  ratings: { rating_value: 4.5, review_count: 10 },
  default_offer: { retail_price: price, old_price: 0, qty: 5 },
  ...extra,
});

let calls: URL[] = [];
let respond: (u: URL) => Response;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u);
    return respond(u);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const run = (query: string, slots: Record<string, string> = {}) =>
  DIRECT_ADAPTERS["birmarket_v1"]!({ query, slots, session: null as never, language: "en" });
const searches = () => calls.filter((u) => u.pathname === "/api/v1/products");

describe("Birmarket catalog helpers", () => {
  it("maps every sort to a value the catalog accepts", () => {
    const ok = new Set([
      "retail_price_asc",
      "retail_price_desc",
      "boosted_score",
      "search_popular_score",
      "rating_desc",
    ]);
    for (const s of ["relevance", "price_asc", "price_desc", "rating", "popularity", undefined])
      expect(ok.has(cat.mapSort(s))).toBe(true);
  });

  it("anchors common product types to the verified categories, never accessories", () => {
    expect(cat.inferCategory("smartfon apple iphone 16")).toEqual({
      categoryId: 3,
      query: "apple iphone 16",
    });
    expect(cat.inferCategory("noutbuk")).toEqual({ categoryId: 16, query: "" });
    expect(cat.inferCategory("qulaqlıq apple airpods")?.categoryId).toBe(6);
    expect(cat.inferCategory("ağıllı saat samsung")).toEqual({ categoryId: 4, query: "samsung" });
    expect(cat.inferCategory("kişi krosovka nike")).toEqual({ categoryId: 3177, query: "nike" });
    expect(cat.inferCategory("qadın qol saatı")?.categoryId).toBe(4040);
    expect(cat.inferCategory("telefon çexolu iphone")).toBeNull();
    expect(cat.inferCategory("çamadan")).toBeNull();
  });

  it("resolves category names: exact, single-word partial, never stopwords or risky multi-word partials", () => {
    const list = [
      { id: 3, name: "Mobil telefonlar və smartfonlar", slug: "mobil" },
      { id: 16, name: "Notbuklar", slug: "notbuklar" },
      { id: 900, name: "Stolüstü oyunlar", slug: "stolustu" },
      { id: 901, name: "Hədiyyə qablaşdırması", slug: "hediyye" },
    ];
    expect(cat.resolveCategoryFromList("  Mobil telefonlar və smartfonlar ", list)).toBe(3);
    expect(cat.resolveCategoryFromList("notbuk", list)).toBe(16);
    expect(cat.resolveCategoryFromList("hədiyyə", list)).toBeUndefined();
    expect(cat.resolveCategoryFromList("PS5 oyunları", list)).toBeUndefined();
  });

  it("AZ -> RU fallback is used only when it finds more", async () => {
    expect(cat.translateQueryToRu("idman geyimi")).toBe("спортивная одежда");
    expect(cat.translateQueryToRu("samsung")).toBeUndefined();
    const p = (id: string) => cat.normalizeProduct(apiProduct(Number(id), `X ${id}`, 10));
    const search = vi.fn(async ({ query }: { query: string }) =>
      query === "idman geyimi" ? [p("1")] : [p("2"), p("3"), p("1")],
    );
    const out = await cat.applyAzRuFallback({ query: "idman geyimi" }, search);
    expect(out.map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("flags English multi-word queries but not brands or Russian", () => {
    expect(cat.looksNonAzRu("cheap running shoes for me")).toBe(true);
    expect(cat.looksNonAzRu("Samsung")).toBe(false);
    expect(cat.looksNonAzRu("беговые кроссовки")).toBe(false);
  });
});

describe("shopping module on the catalog API", () => {
  it("anchored search with integer price bounds sent together; cards keep the existing shape", async () => {
    respond = () =>
      Response.json({
        meta: { total: 2 },
        products: [
          apiProduct(1259304, "Smartfon Apple iPhone 16 8GB/128GB", 1799.99, {
            default_offer: { retail_price: 1799.99, old_price: 2500, qty: 3 },
          }),
          apiProduct(2, "Smartfon Samsung Galaxy S24", 1500),
          apiProduct(3, "Smartfon Apple iPhone 13", 999, { status: "inactive" }),
        ],
      });
    const r = await run("smartfon apple iphone 16", { budget_max: "1999.5" });
    const q = searches()[0]!.searchParams;
    expect(q.get("category_id")).toBe("3");
    expect(q.get("query")).toBe("apple iphone 16");
    expect([q.get("price_from"), q.get("price_to")]).toEqual(["0", "2000"]);
    expect(r.status).toBe("ok");
    expect(r.items).toHaveLength(2); // inactive listing dropped
    expect(r.items[0]).toMatchObject({
      id: "p1259304",
      kind: "product",
      subtitle: "was 2500 AZN",
      price: { amount: 1799.99, currency: "AZN" },
      source_url: "https://birmarket.az/product/1259304-smartfon-apple-iphone-16-8gb/128gb",
      attributes: {
        image: "https://img.test/1259304.jpg",
        rating: 4.5,
        reviews: 10,
        old_price_azn: 2500,
      },
    });
    // "Apple" is already in the query, so no brand chip for it; the price toggle is offered instead.
    expect(r.suggestions.map((s) => s.label)).toEqual(["Cheapest first", "Most expensive first"]);
  });

  it("brand filter that matches nothing is dropped instead of dead-ending", async () => {
    respond = (u) =>
      Response.json({
        products: u.searchParams.get("brands") ? [] : [apiProduct(5, "Yaddaş SanDisk 64GB", 25)],
      });
    const r = await run("yaddaş kartı", { brand: "Canon", sort: "cheapest" });
    expect(searches()[0]!.searchParams.get("sort")).toBe("retail_price_asc");
    expect(r.status).toBe("ok");
    expect(r.summary).toMatch(/Nothing from Canon/);
  });

  it("nothing in budget -> closest prices; nothing at all -> /suggests chips", async () => {
    respond = (u) =>
      Response.json(
        u.pathname === "/api/v1/suggests"
          ? { predictions: { next_words: [{ word: "telefon" }] }, brands: [{ name: "Nokia" }] }
          : { products: u.searchParams.get("price_to") ? [] : [apiProduct(7, "Çamadan Big", 300)] },
      );
    const partial = await run("çamadan", { budget_max: "100" });
    expect(partial.status).toBe("partial");
    expect(partial.items[0]!.title).toBe("Çamadan Big");

    respond = (u) =>
      Response.json(
        u.pathname === "/api/v1/suggests"
          ? { predictions: { next_words: [{ word: "telefon" }] }, brands: [{ name: "Nokia" }] }
          : { products: [] },
      );
    const none = await run("telefn");
    expect(none.status).toBe("no_results");
    expect(none.suggestions).toEqual([
      { label: "telefon", value: "telefon" },
      { label: "Nokia", value: "only Nokia" },
    ]);
  });

  it("bestsellers query uses the bestsellers block", async () => {
    respond = (u) =>
      Response.json({
        products: u.pathname.endsWith("/bestsellers")
          ? [apiProduct(9, "Smartfon Samsung S26", 2100)]
          : [],
      });
    const r = await run("ən çox satılan");
    expect(r.items.map((i) => i.title)).toEqual(["Smartfon Samsung S26"]);
  });

  it("catalog outage falls back to the Birmarket pages", async () => {
    respond = (u) =>
      u.hostname === "mp-catalog.umico.az"
        ? new Response("Attention Required! | Cloudflare", { status: 403 })
        : new Response("<div></div>", { headers: { "content-type": "text/html" } });
    const r = await run("çamadan");
    expect(r.summary).toMatch(/catalog is still loading/); // the page-scraping path answered
    expect(r.items[0]!.action.value).toContain("birmarket.az");
  });
});
