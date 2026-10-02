import { describe, expect, it } from "vitest";
import { getLocale, setLocale } from "@vunemi/i18n";
import { shapeOutput } from "@vunemi/agent-core";
import { DECLINE_TRIVAGO_COOKIES, flightOptions, flightSearchUrl, hotelOptions, offerPageUrl, requestedCurrency, travelConnectors, travelCurrency, TravelSearchLimit, trivagoPage, trivagoSearchUrl, withoutLinks } from "../../src/main/travel.js";
import { parseTravelOptions } from "../../src/renderer/src/lib/travel-options.js";

const flightUrl = "https://www.google.com/travel/flights/booking?tfs=abc";
const hotelUrl = "https://www.trivago.co.uk/en-GB/lm/radisson-red?currencyCode=GBP&search=100-456;200-15289;dr-20261025-20261030;drs-40;rc-1-1-10";

describe("travel sources", () => {
  it("keeps both connections off until the user enables them", () => {
    expect(travelConnectors().map((c) => [c.id, c.defaultOn])).toEqual([
      ["travel-flights", false], ["travel-hotels", false],
    ]);
    expect(travelConnectors().every((c) => c.requestableWhenOff)).toBe(true);
    const hotel = travelConnectors().find((c) => c.id === "travel-hotels")!.tools()[0]!;
    expect(hotel.parameters.required).toEqual(["destination", "check_in"]);
  });

  it("says on the approval card where the search is sent, in the app's language", async () => {
    const [flights, hotels] = travelConnectors().map((c) => c.tools()[0]!);
    const before = getLocale();
    setLocale("tr");
    expect(await flights!.preview!({ origin: "MAN", destination: "ADB", departure_date: "2026-11-03", return_date: "2026-11-10" }))
      .toBe("Bu arama Google Flights'a gönderilecek: MAN → ADB · 2026-11-03 – 2026-11-10");
    expect(await hotels!.preview!({ destination: "Roma", check_in: "2026-11-03" })).toBe("Bu arama Trivago'ya gönderilecek: Roma · 2026-11-03");
    setLocale("en");
    expect(await hotels!.preview!({ destination: "Rome", check_in: "2026-11-03", check_out: "2026-11-05" }))
      .toBe("This search will be sent to Trivago: Rome · 2026-11-03 – 2026-11-05");
    setLocale(before);
  });

  it("opens only Google Flights and Trivago offers from a card", () => {
    expect(offerPageUrl(flightUrl)).toBe(flightUrl);
    expect(offerPageUrl(hotelUrl)).toBe(hotelUrl);
    expect(() => offerPageUrl("https://www.flypgs.com/en")).toThrow();
    expect(() => offerPageUrl("http://www.google.com/travel/flights")).toThrow();
    expect(() => offerPageUrl("javascript:alert(1)")).toThrow();
  });

  it("answers Trivago's cookie question with essential cookies only, and only on Trivago", async () => {
    expect(trivagoPage(hotelUrl)).toBe(true);
    expect(trivagoPage("https://www.trivago.com/en-US/srl/hotels")).toBe(true);
    expect(trivagoPage("https://www.google.com/travel/flights")).toBe(false);
    expect(trivagoPage("https://www.trivago.co.uk.evil.example/")).toBe(false);
    expect(trivagoPage("http://www.trivago.co.uk/en-GB/lm")).toBe(false);
    const page = (required: boolean) => {
      const calls: string[] = [];
      const cmp = {
        isInitialized: async () => true,
        isConsentRequired: async () => required,
        denyAllConsents: async () => void calls.push("deny"),
        saveConsents: async () => void calls.push("save"),
        closeCmp: async () => void calls.push("close"),
        acceptAllConsents: async () => void calls.push("ACCEPT"),
      };
      return { calls, run: () => new Function("window", `return ${DECLINE_TRIVAGO_COOKIES}`)({ __ucCmp: cmp }) as Promise<boolean> };
    };
    const asked = page(true);
    expect(await asked.run()).toBe(true);
    expect(asked.calls).toEqual(["deny", "save", "close"]);
    const answered = page(false);
    expect(await answered.run()).toBe(false);
    expect(answered.calls).toEqual([]);
  });

  it("turns flight results into priced cards, deduplicates and rejects foreign links", () => {
    const raw = { success: true, flights: [
      { price: 860, currency: "GBP", primary_airline_name: "Pegasus", booking_url: flightUrl,
        legs: [
          { departure_time: "2026-10-25T12:00:00", arrival_time: "2026-10-25T17:00:00" },
          { departure_time: "2026-10-30T18:00:00", arrival_time: "2026-10-30T23:00:00" },
        ] },
      { price: 860, currency: "GBP", booking_url: flightUrl, legs: [{}] },
      { price: 1, currency: "GBP", booking_url: "https://evil.example/booking", legs: [{}] },
    ] };
    const searchUrl = flightSearchUrl("MAN", "ADB", "2026-10-25", "2026-10-30", 1, 1, "GBP");
    const result = flightOptions(raw, "2026-09-30T12:00:00Z", "2026-10-30", searchUrl);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({ title: "Pegasus", price: "£860", url: flightUrl });
    expect(result.options[0]?.extra).toContain("Dönüş");
    const displayed = parseTravelOptions({ tool: "travel_search_flights", status: "ok", output: shapeOutput(JSON.stringify(result), { name: "travel_search_flights", untrustedOutput: true }, 12_000) });
    expect(displayed?.options).toHaveLength(1);
    expect(displayed?.options[0]?.url).toBe(flightUrl);
    expect(displayed?.searchUrl).toBe(searchUrl);
    expect(new URL(searchUrl).searchParams.get("q")).toContain("1 adult 1 child");
  });

  it("gives the model the options without their links, which only the cards need", () => {
    const hotels = hotelOptions({ accommodations: [{ accommodation_name: "Radisson RED", accommodation_url: hotelUrl, price_per_stay: "£400",
      main_image: "https://imgcy.trivago.com/x.jpeg" }] }, "2026-09-30T12:00:00Z");
    const forModel = JSON.parse(withoutLinks(JSON.stringify(hotels)));
    expect(forModel.options).toEqual([{ title: "Radisson RED", price: "£400", detail: "", extra: "" }]);
    expect(forModel.searchUrl).toBeUndefined();
    expect(forModel.kind).toBe("travel-options");
    const skipped = JSON.stringify({ kind: "travel-search-skipped", reason: "x" });
    expect(withoutLinks(skipped)).toBe(skipped);
    for (const tool of travelConnectors().flatMap((c) => c.tools())) expect(tool.forModel).toBe(withoutLinks);
  });

  it("uses Trivago's offer and does not misstate the advertiser as the booking provider", () => {
    const raw = { accommodations: [{ accommodation_name: "Radisson RED Izmir", price_per_stay: "£471", price_per_night: "£94",
      review_rating: "8.8", accommodation_url: hotelUrl, main_image: "https://imgcy.trivago.com/image.jpg", advertisers: ["Radisson Hotels"] }] };
    const result = hotelOptions(raw, "2026-09-30T12:00:00Z");
    expect(result.options[0]).toMatchObject({ title: "Radisson RED Izmir", price: "£471", url: hotelUrl });
    expect(JSON.stringify(result)).not.toContain("Radisson Hotels");
    const displayed = parseTravelOptions({ tool: "travel_search_hotels", status: "ok", output: shapeOutput(JSON.stringify(result), { name: "travel_search_hotels", untrustedOutput: true }, 12_000) });
    expect(displayed?.options[0]?.image).toBe("https://imgcy.trivago.com/image.jpg");
    const searchUrl = trivagoSearchUrl(hotelUrl);
    expect(searchUrl).toContain("/en-GB/srl/hotels?");
    expect(new URL(searchUrl).searchParams.get("search")).toBe("200-15289;dr-20261025-20261030;drs-40;rc-1-1-10");
    expect(displayed?.searchUrl).toBe(searchUrl);
  });

  it("refuses arbitrary result links even when a tool result claims to be a card", () => {
    const result = { kind: "travel-options", source: "trivago", searchedAt: "", options: [{ title: "Fake", price: "£1", detail: "", url: "https://example.com/steal" }] };
    const displayed = parseTravelOptions({ tool: "travel_search_hotels", status: "ok", output: shapeOutput(JSON.stringify(result), { name: "travel_search_hotels", untrustedOutput: true }, 12_000) });
    expect(displayed?.options).toEqual([]);
  });

  it("uses the Mac's currency unless the user explicitly chooses another", async () => {
    const macCurrency = async () => "GBP";
    expect(requestedCurrency("İzmir'de otel bak, Türkçe konuşalım")).toBeNull();
    expect(await travelCurrency("İzmir'de otel bak, Türkçe konuşalım", macCurrency)).toBe("GBP");
    expect(await travelCurrency("İzmir'de 5000 TL civarında otel bak", macCurrency)).toBe("TRY");
    expect(await travelCurrency("Türk lirası göster", macCurrency)).toBe("TRY");
    expect(await travelCurrency("Show flights in euros", macCurrency)).toBe("EUR");
    expect(await travelCurrency("Flights in £", macCurrency)).toBe("GBP");
  });

  it("keeps one hotel and one flight search per simple request, while allowing explicit date comparisons", () => {
    const limit = new TravelSearchLimit();
    const goal = "Yarın İzmir'de otel ve Manchester'dan uçuş bak";
    expect(limit.used("run1", "hotel", goal)).toBe(false);
    limit.mark("run1", "hotel");
    expect(limit.used("run1", "hotel", goal)).toBe(true);
    expect(limit.used("run1", "flight", goal)).toBe(false);
    limit.mark("run1", "flight");
    expect(limit.used("run1", "flight", goal)).toBe(true);
    expect(limit.used("run2", "flight", goal)).toBe(false);
    expect(limit.used("run1", "flight", "Farklı tarihleri karşılaştır")).toBe(false);
  });
});
