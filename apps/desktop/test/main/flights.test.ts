import { describe, expect, it, vi } from "vitest";
import { ConsentRequired, consentDecline, consentReturn, pageUrl, payloadOf, rejectForm, rowsOf, searchFlights, type FetchPage } from "../../src/main/flights/search.js";
import { currencyOfToken, encodeTfs, itineraryTfs, passengerKinds, segment } from "../../src/main/flights/tfs.js";
import { travelConnectors } from "../../src/main/travel.js";

// Tokens Fli's own encoder produces for the same inputs (checked byte for byte).
const ONE_WAY = "CBwQAhoeEgoyMDI2LTEwLTI1agcIARIDTUFOcgcIARIDQURCQAFAAUACSAFwAZgBAg";
const PINNED = "CBwQAhpiEgoyMDI2LTEwLTI1IiAKA01BThIKMjAyNi0xMC0yNRoDSVNUKgJUSzIEMTk5NCIgCgNJU1QSCjIwMjYtMTAtMjUaA0FEQioCVEsyBDIzMTZqBwgBEgNNQU5yBwgBEgNBREIaHhIKMjAyNi0xMC0zMGoHCAESA0FEQnIHCAESA01BTkABQAFAAkgBcAGYAQE";
const ONE_WAY_ROUND = encodeTfs([segment("MAN", "ADB", "2026-10-25"), segment("ADB", "MAN", "2026-10-30")], { roundTrip: true, passengers: passengerKinds(2, 1) });
const SINGLE = "CBwQAhpAEgoyMDI2LTEwLTI1IiAKA01BThIKMjAyNi0xMC0yNRoDSVNUKgJUSzIEMTk5NGoHCAESA01BTnIHCAESA0lTVEABSAFwAYIBCwj___________8BmAEC";

const mts = { origin: "MAN", date: "2026-10-25", destination: "IST", airline: "TK", flightNumber: "1994" };
const ist = { origin: "IST", date: "2026-10-25", destination: "ADB", airline: "TK", flightNumber: "2316" };

/** A price token carrying `code` the way Google's does: field 3 { field 3: code }. */
function token(code: string): string {
  const inner = Buffer.concat([Buffer.from([0x1a, code.length]), Buffer.from(code)]);
  return Buffer.concat([Buffer.from([0x1a, inner.length]), inner]).toString("base64");
}

function leg(from: string, to: string, day: [number, number, number], dep: [number, number], arr: [number, number], airline: string, number: string): unknown[] {
  const raw: unknown[] = [];
  raw[3] = from; raw[6] = to; raw[8] = dep; raw[10] = arr; raw[11] = 120;
  raw[20] = day; raw[21] = day; raw[22] = [airline, number];
  return raw;
}

function row(name: string, price: number, legs: unknown[][], currency = "GBP"): unknown[] {
  const detail: unknown[] = [];
  detail[0] = legs.length ? (legs[0] as unknown[])[22] && ((legs[0] as unknown[])[22] as unknown[])[0] : null;
  detail[1] = [name]; detail[2] = legs; detail[9] = 300;
  return [detail, [[null, price], token(currency)]];
}

function page(rows: unknown[], others: unknown[] = []): string {
  const payload = [[null, null, null, null, "session"], null, [rows], others.length ? [others] : null];
  return `<html><script>AF_initDataCallback({key: 'ds:0', hash: '0', data:[1], sideChannel: {}});</script>`
    + `<script>AF_initDataCallback({key: 'ds:1', hash: '1', data:${JSON.stringify(payload)}, sideChannel: {}});</script></html>`;
}

// The shape of Google's cookie page: "Accept all" sets more fields than "Reject all".
const CONSENT_PAGE = `<html><title>Before you continue</title>
<form method="POST" action="https://consent.google.com/save"><input type="hidden" name="gl" value="GB"><input type="hidden" name="continue" value="https://www.google.com/travel/flights?a=1&amp;b=2"><input type="hidden" name="set_sc" value="true"><input type="hidden" name="set_aps" value="true"><input type="hidden" name="set_eom" value="false"><button>Accept all</button></form>
<form method="POST" action="https://consent.google.com/save"><input type="hidden" name="gl" value="GB"><input type="hidden" name="continue" value="https://www.google.com/travel/flights?a=1&amp;b=2"><input type="hidden" name="set_eom" value="true"><button>Reject all</button></form></html>`;

const ok = (text: string, url = "https://www.google.com/travel/flights") => ({ url, status: 200, text });
const query = { origin: "MAN", destination: "ADB", departure: "2026-10-25", adults: 2, children: 1, currency: "GBP", country: "GB" };

const pegasus = row("Pegasus", 180, [leg("MAN", "ADB", [2026, 10, 25], [9, 5], [16, 40], "PC", "1202")]);
const turkish = row("Turkish Airlines", 150, [
  leg("MAN", "IST", [2026, 10, 25], [7, 0], [13, 0], "TK", "1994"),
  leg("IST", "ADB", [2026, 10, 25], [15, 0], [16, 10], "TK", "2316"),
]);

describe("flight search encoding", () => {
  it("writes the same tfs tokens as Fli", () => {
    expect(encodeTfs([segment("MAN", "ADB", "2026-10-25")], { roundTrip: false, passengers: passengerKinds(2, 1) })).toBe(ONE_WAY);
    expect(encodeTfs([segment("MAN", "ADB", "2026-10-25", [mts, ist]), segment("ADB", "MAN", "2026-10-30")], { roundTrip: true, passengers: passengerKinds(2, 1) })).toBe(PINNED);
    expect(itineraryTfs([[mts]], passengerKinds(1, 0))).toBe(SINGLE);
  });

  it("reads the currency out of a price token", () => {
    expect(currencyOfToken(token("try"))).toBe("TRY");
    expect(currencyOfToken("not base64 protobuf")).toBeNull();
    expect(currencyOfToken(undefined)).toBeNull();
  });
});

describe("search page", () => {
  it("finds the ds:1 payload among the page's data blocks", () => {
    expect((payloadOf(page([pegasus])) as unknown[])[0]).toEqual([null, null, null, null, "session"]);
    expect(payloadOf("<html>no data</html>")).toBeNull();
  });

  it("reads rows cheapest first and skips a row it cannot read", () => {
    const rows = rowsOf(payloadOf(page([pegasus, ["junk"]], [turkish])));
    expect(rows.map((r) => [r.airlineName, r.price, r.currency])).toEqual([["Turkish Airlines", 150, "GBP"], ["Pegasus", 180, "GBP"]]);
    expect(rows[0]!.legs[1]).toMatchObject({ departure_airport: "IST", arrival_airport: "ADB", departure_time: "2026-10-25T15:00:00", flight_number: "2316" });
  });

  it("treats a changed page as an error, never as no flights", () => {
    expect(() => rowsOf([[], null, []])).toThrow(/changed its page/);
    expect(() => rowsOf([[], null])).toThrow(/changed its page/);
    expect(() => rowsOf(payloadOf(page([["junk"], [1, 2]])))).toThrow(/none of its rows/);
    expect(rowsOf([[], null, null, null])).toEqual([]);
  });
});

describe("searchFlights", () => {
  it("searches one way with one page and links each flight to its booking page", async () => {
    const fetchPage = vi.fn<FetchPage>(async () => ok(page([pegasus, turkish])));
    const rows = await searchFlights(query, fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]![0]).toBe(pageUrl(ONE_WAY, query));
    expect(rows.map((r) => r.price)).toEqual([150, 180]);
    expect(rows[0]).toMatchObject({ currency: "GBP", primary_airline_name: "Turkish Airlines" });
    expect(rows[0]!.booking_url).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\/booking\?tfs=[\w-]+&curr=GBP&hl=en-GB&gl=GB$/);
  });

  it("prices a round trip by pinning each outbound and taking its cheapest return", async () => {
    const back = row("Pegasus", 310, [leg("ADB", "MAN", [2026, 10, 30], [18, 0], [21, 30], "PC", "1203")]);
    const dearer = row("Pegasus", 420, [leg("ADB", "MAN", [2026, 10, 30], [8, 0], [11, 30], "PC", "1201")]);
    const fetchPage = vi.fn<FetchPage>(async (url) => ok(new URL(url).searchParams.get("tfs") === ONE_WAY_ROUND ? page([turkish]) : page([dearer, back])));
    const rows = await searchFlights({ ...query, returning: "2026-10-30" }, fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(new URL(fetchPage.mock.calls[1]![0]).searchParams.get("tfs")).toBe(PINNED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe(310);
    expect(rows[0]!.legs.map((l) => l.flight_number)).toEqual(["1994", "2316", "1203"]);
  });

  it("declines Google's non-essential cookies, never accepts them, and searches on", async () => {
    let declined = false;
    const posts: { url: string; form: URLSearchParams }[] = [];
    const fetchPage = vi.fn<FetchPage>(async (url, _signal, form) => {
      if (form) { posts.push({ url, form }); declined = true; return ok(""); }
      return declined ? ok(page([pegasus])) : ok(CONSENT_PAGE);
    });
    expect(await searchFlights(query, fetchPage)).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://consent.google.com/save");
    expect(Object.fromEntries(posts[0]!.form)).toEqual({ gl: "GB", continue: "https://www.google.com/travel/flights?a=1&b=2", set_eom: "true" });
  });

  it("declines once per search and then says so plainly", async () => {
    const fetchPage = vi.fn<FetchPage>(async (_url, _signal, form) => ok(form ? "" : CONSENT_PAGE));
    await expect(searchFlights({ ...query, returning: "2026-10-30" }, fetchPage)).rejects.toBeInstanceOf(ConsentRequired);
    expect(fetchPage.mock.calls.filter((call) => call[2]).length).toBe(1);
  });

  it("finds the reject form by its fields and only posts to the consent service", () => {
    expect(rejectForm(CONSENT_PAGE.replace("Reject all", "Alle ablehnen"))?.body.get("set_eom")).toBe("true");
    expect(rejectForm('<form action="https://evil.example/save"><input name="set_eom" value="true"></form>')?.action).toBe("https://consent.google.com/save");
    expect(rejectForm('<form><input name="set_eom" value="false"><input name="set_sc" value="true"></form>')).toBeNull();
    expect(rejectForm("<html>no forms</html>")).toBeNull();
  });

  it("declines Google's cookie page in the browser pane too, and nothing else", () => {
    expect(consentDecline("https://consent.google.com/ml?continue=x", CONSENT_PAGE)?.body.get("set_eom")).toBe("true");
    // Served in place on Google's own page, its forms posting to the consent service.
    expect(consentDecline("https://www.google.com/travel/flights/booking?tfs=a", CONSENT_PAGE)?.action).toBe("https://consent.google.com/save");
    // Any other site's page, even one that copies Google's form, is left alone.
    expect(consentDecline("https://www.trivago.co.uk/en-GB/lm", CONSENT_PAGE)).toBeNull();
    expect(consentDecline("https://google.com.evil.example/", CONSENT_PAGE)).toBeNull();
    expect(consentDecline("http://consent.google.com/ml", CONSENT_PAGE)).toBeNull();
    // A Google page with no cookie question.
    expect(consentDecline("https://www.google.com/travel/flights", "<html><form action=\"/search\"></form></html>")).toBeNull();
  });

  it("returns to the Google page the cookie question came from, and nowhere else", () => {
    const flights = "https://www.google.com/travel/flights?q=MAN+to+ADB";
    expect(consentReturn(flights)).toBe(flights);
    expect(consentReturn("https://consent.google.com/ml?continue=x")).toBeNull();
    expect(consentReturn("https://evil.example/?google.com")).toBeNull();
    expect(consentReturn("http://www.google.com/travel/flights")).toBeNull();
    expect(consentReturn("javascript:alert(1)")).toBeNull();
    expect(consentReturn(null)).toBeNull();
  });

  it("tries a page again when it came back without results", async () => {
    let calls = 0;
    const fetchPage: FetchPage = async () => ok(++calls === 1 ? "<html></html>" : page([pegasus]));
    expect(await searchFlights(query, fetchPage)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("names a refused request", async () => {
    await expect(searchFlights(query, async () => ({ url: "https://www.google.com/", status: 429, text: "" }))).rejects.toThrow(/limiting/);
  });
});

describe("flight tool", () => {
  it("returns cards from the built-in search", async () => {
    const tool = travelConnectors({ fetchPage: async () => ok(page([pegasus])) }).find((c) => c.id === "travel-flights")!.tools()[0]!;
    const ctx = { signal: new AbortController().signal, runId: "r1", userGoal: "MAN to ADB flights £" } as never;
    const result = JSON.parse(String(await tool.run({ origin: "MAN", destination: "ADB", departure_date: "2026-10-25" }, ctx)));
    expect(result).toMatchObject({ kind: "travel-options", source: "google" });
    expect(result.options[0]).toMatchObject({ title: "Pegasus", price: "£180" });
  });
});
