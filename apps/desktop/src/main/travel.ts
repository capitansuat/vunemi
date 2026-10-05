/** Two opt-in travel sources. Searches are user-initiated; neither books nor pays. */
import { execFile } from "node:child_process";
import type { Connector, ConnectorStatus } from "@vunemi/connectors";
import { wantsMoreTravelSearches, type ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { McpClient } from "@vunemi/mcp";
import { searchFlights, type FetchPage } from "./flights/search.js";

const TRIVAGO_MCP = "https://mcp.trivago.com/mcp";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const date = (value: unknown): string => {
  const text = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T12:00:00Z`))) throw new Error("Dates must be YYYY-MM-DD.");
  return text;
};
const count = (value: unknown, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`The number of people must be ${min}–${max}.`);
  return n;
};
const airport = (value: unknown): string => {
  const code = str(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Airports must be three-letter IATA codes.");
  return code;
};
const currency = (value: unknown): string => /^[A-Z]{3}$/.test(str(value).toUpperCase()) ? str(value).toUpperCase() : "GBP";
const explicitCurrencies: Record<string, string> = {
  GBP: "GBP", POUND: "GBP", POUNDS: "GBP", STERLING: "GBP",
  TRY: "TRY", TL: "TRY", LIRA: "TRY", LIRASI: "TRY",
  EUR: "EUR", EURO: "EUR", EUROS: "EUR", USD: "USD", DOLLAR: "USD", DOLLARS: "USD",
  CAD: "CAD", AUD: "AUD", JPY: "JPY", YEN: "JPY", CHF: "CHF",
};

/** Currency is a user preference, never inferred from the language or destination. */
export function requestedCurrency(goal: string): string | null {
  if (/£/.test(goal)) return "GBP";
  if (/₺/.test(goal)) return "TRY";
  if (/€/.test(goal)) return "EUR";
  if (/\$/.test(goal)) return "USD";
  for (const match of goal.replaceAll("ı", "i").replaceAll("İ", "I").toUpperCase().matchAll(/(?:^|[^\p{L}])([\p{L}]{2,8})(?=$|[^\p{L}])/gu)) {
    const found = explicitCurrencies[match[1]!];
    if (found) return found;
  }
  return null;
}

export async function travelCurrency(goal: string, systemCurrency: () => Promise<string>): Promise<string> {
  const selected = requestedCurrency(goal) ?? await systemCurrency();
  if (!/^[A-Z]{3}$/.test(selected)) throw new Error("A valid currency code is required.");
  return selected;
}

/** Apple's regional currency is independent of the app's conversation language. */
function macCurrency(): Promise<string> {
  return new Promise((resolve, reject) => execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e",
    'ObjC.import("Foundation"); ObjC.unwrap($.NSLocale.currentLocale.objectForKey($.NSLocaleCurrencyCode))'],
  { timeout: 5_000 }, (error, stdout) => {
    const code = str(stdout).toUpperCase();
    if (error || !/^[A-Z]{3}$/.test(code)) reject(new Error("Could not read the Mac's regional currency. Ask the user which currency to use."));
    else resolve(code);
  }));
}

export class TravelSearchLimit {
  private readonly runs = new Map<string, Set<"flight" | "hotel">>();
  used(runId: string | undefined, kind: "flight" | "hotel", goal: string): boolean {
    return !!runId && !wantsMoreTravelSearches(goal) && this.runs.get(runId)?.has(kind) === true;
  }
  mark(runId: string | undefined, kind: "flight" | "hotel"): void {
    if (!runId) return;
    const seen = this.runs.get(runId) ?? new Set<"flight" | "hotel">();
    seen.add(kind);
    this.runs.set(runId, seen);
    if (this.runs.size > 100) this.runs.delete(this.runs.keys().next().value!);
  }
}
const stopsText = (n: number): string => n === 0 ? t("travel.direct") : t("travel.stops", { count: n });

const safeUrl = (value: unknown, hosts: readonly string[]): string => {
  try {
    const url = new URL(str(value));
    return url.protocol === "https:" && hosts.includes(url.hostname) ? url.toString() : "";
  } catch { return ""; }
};

export interface TravelOption {
  title: string;
  price: string;
  detail: string;
  extra?: string;
  url: string;
  image?: string;
}
export interface TravelOptions {
  kind: "travel-options";
  source: "google" | "trivago";
  searchedAt: string;
  options: TravelOption[];
  resultCount: number;
  searchUrl?: string;
  summary?: string;
  warning?: string;
}

export function flightSearchUrl(origin: string, destination: string, departure: string, returning: string | undefined, adults: number, children: number, money: string, country = "GB"): string {
  const url = new URL("https://www.google.com/travel/flights");
  url.searchParams.set("q", `Flights from ${origin} to ${destination} on ${departure}${returning ? ` returning ${returning}` : ""} ${adults} adult${adults === 1 ? "" : "s"}${children ? ` ${children} child${children === 1 ? "" : "ren"}` : ""}`);
  url.searchParams.set("hl", "en-GB");
  url.searchParams.set("curr", money);
  url.searchParams.set("gl", country);
  return url.toString();
}

/** A Trivago MCP property link carries the destination and party search state. */
export function trivagoSearchUrl(offer: string): string {
  const safe = safeUrl(offer, TRIVAGO_HOSTS);
  if (!safe) return "";
  const property = new URL(safe);
  const parts = (property.searchParams.get("search") ?? "").split(";").filter((part) => /^(200-|dr-|drs-|rc-)/.test(part));
  if (!parts.some((part) => part.startsWith("200-")) || !parts.some((part) => part.startsWith("dr-"))) return "";
  const url = new URL("/en-GB/srl/hotels", property.origin);
  url.searchParams.set("search", parts.join(";"));
  const money = property.searchParams.get("currencyCode");
  if (money && /^[A-Z]{3}$/.test(money)) url.searchParams.set("currencyCode", money);
  return url.toString();
}

export function flightOptions(raw: unknown, searchedAt = new Date().toISOString(), returnDate?: string, searchUrl?: string): TravelOptions {
  const data = obj(raw);
  if (data.success === false) throw new Error(str(data.error) || "The flight search failed.");
  const rows = Array.isArray(data.flights) ? data.flights : [];
  const seen = new Set<string>();
  const options: TravelOption[] = [];
  let resultCount = 0;
  for (const rawRow of rows) {
    const row = obj(rawRow);
    const legs = Array.isArray(row.legs) ? row.legs.map(obj) : [];
    const url = safeUrl(row.booking_url, ["www.google.com", "google.com"]);
    const price = number(row.price);
    if (!url || price === null || !legs.length || seen.has(url)) continue;
    seen.add(url);
    resultCount++;
    if (options.length >= 6) continue;
    const first = legs[0]!;
    const last = legs.at(-1)!;
    const split = returnDate ? legs.findIndex((leg, i) => i > 0 && str(leg.departure_time).slice(0, 10) >= returnDate) : -1;
    const outward = split > 0 ? legs.slice(0, split) : legs;
    const homeward = split > 0 ? legs.slice(split) : [];
    const finish = outward.at(-1)!;
    const airline = str(row.primary_airline_name) || str(first.airline) || t("travel.flight");
    const stops = Math.max(0, outward.length - 1);
    const backStops = homeward.length ? Math.max(0, homeward.length - 1) : null;
    const outboundText = `${str(first.departure_time).replace("T", " ")} → ${str(finish.arrival_time).replace("T", " ")}`;
    const returnText = homeward.length ? t("travel.returnLeg", { time: `${str(homeward[0]?.departure_time).replace("T", " ")} → ${str(last.arrival_time).replace("T", " ")}` }) : "";
    options.push({
      title: airline,
      price: new Intl.NumberFormat("en-GB", { style: "currency", currency: currency(row.currency), maximumFractionDigits: 0 }).format(price),
      detail: `${outboundText} · ${stopsText(stops)}`,
      ...(returnText && { extra: `${returnText} · ${stopsText(backStops ?? 0)}` }),
      url,
    });
  }
  return { kind: "travel-options", source: "google", searchedAt, options, resultCount, ...(searchUrl && { searchUrl }),
    warning: options.length ? t("travel.flightsNote") : t("travel.flightsEmpty") };
}

export function hotelOptions(raw: unknown, searchedAt = new Date().toISOString(), summary?: string): TravelOptions {
  const data = obj(raw);
  if (str(data.error)) throw new Error(str(data.error));
  const rows = Array.isArray(data.accommodations) ? data.accommodations : [];
  const options: TravelOption[] = [];
  let resultCount = 0;
  for (const rawRow of rows) {
    const row = obj(rawRow);
    const url = safeUrl(row.accommodation_url, TRIVAGO_HOSTS);
    const title = str(row.accommodation_name);
    if (!url || !title) continue;
    resultCount++;
    if (options.length >= 6) continue;
    const rating = str(row.review_rating);
    const nights = str(row.price_per_night);
    const stay = str(row.price_per_stay);
    options.push({ title, price: stay || nights || t("travel.seePrice"), detail: [rating && t("travel.rating", { rating }), nights && t("travel.perNight", { price: nights })].filter(Boolean).join(" · "),
      extra: str(row.country_city), url,
      ...(safeUrl(row.main_image, ["imgcy.trivago.com"]) && { image: safeUrl(row.main_image, ["imgcy.trivago.com"]) }) });
  }
  const searchUrl = options.map((item) => trivagoSearchUrl(item.url)).find(Boolean);
  return { kind: "travel-options", source: "trivago", searchedAt, options, resultCount, ...(searchUrl && { searchUrl }), ...(summary && { summary }),
    warning: options.length ? t("travel.hotelsNote") : t("travel.hotelsEmpty") };
}

export interface TravelOptionsDeps {
  systemCurrency?: () => Promise<string>;
  countryCode?: () => string;
  /** Fetches a Google Flights page through the flight search's own session. */
  fetchPage?: FetchPage;
}

const TRIVAGO_HOSTS = ["www.trivago.co.uk", "www.trivago.com"];

/** Where an offer card may open: Google Flights or Trivago over https, nothing else. */
const OFFER_HOSTS = ["www.google.com", "google.com", ...TRIVAGO_HOSTS];
export function offerPageUrl(raw: string): string {
  const url = safeUrl(raw, OFFER_HOSTS);
  if (!url) throw new Error("Only Google Flights and Trivago offers open from a travel card.");
  return url;
}

/** Whether a page is one of Trivago's, where an opened offer may land. */
export function trivagoPage(url: string): boolean {
  return safeUrl(url, TRIVAGO_HOSTS) !== "";
}

/**
 * Run in a Trivago page: answers its cookie question (Usercentrics) with
 * "Essential cookies only", through the consent tool's own interface rather
 * than its buttons, whose words follow the page language. Resolves true
 * when it answered, false when nothing was asked. Never accepts.
 */
export const DECLINE_TRIVAGO_COOKIES = `(async () => {
  const ready = async () => { try { return Boolean(window.__ucCmp && await window.__ucCmp.isInitialized()); } catch { return false; } };
  for (let i = 0; i < 40 && !(await ready()); i++) await new Promise((r) => setTimeout(r, 250));
  const cmp = window.__ucCmp;
  if (!cmp || !(await ready()) || !(await cmp.isConsentRequired())) return false;
  await cmp.denyAllConsents();
  await cmp.saveConsents();
  await cmp.closeCmp();
  return true;
})()`;

/**
 * The model's copy of travel results, without links: half its tokens were
 * booking links it never needs. The cards show them, and choosing an
 * option sends that option's link back to the model.
 */
export function withoutLinks(raw: string): string {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data.kind !== "travel-options" || !Array.isArray(data.options)) return raw;
  const { searchUrl: _search, ...rest } = data;
  const options = data.options.map((o: Record<string, unknown>) => {
    const { url: _url, image: _image, ...keep } = o;
    return keep;
  });
  return JSON.stringify({ ...rest, options });
}

export function travelConnectors(opts: TravelOptionsDeps = {}): Connector[] {
  const limit = new TravelSearchLimit();
  let systemMoney: Promise<string> | null = null;
  const moneyFor = (goal: string) => travelCurrency(goal, () => (systemMoney ??= (opts.systemCurrency ?? macCurrency)()));
  const country = () => { const code = str(opts.countryCode?.()).toUpperCase(); return /^[A-Z]{2}$/.test(code) ? code : "GB"; };
  const trivago = new McpClient({ kind: "http", url: TRIVAGO_MCP });
  const flightTool: ToolDef = {
    name: "travel_search_flights",
    description: "Search flight prices and options on Google Flights. Use IATA airport codes, YYYY-MM-DD dates and passenger counts. A child is 2–11 years old. Results are shown to the user as option cards. Nothing is booked.",
    parameters: { type: "object", properties: {
      origin: { type: "string", description: "Departure IATA code, e.g. MAN" }, destination: { type: "string", description: "Arrival IATA code, e.g. ADB" },
      departure_date: { type: "string", description: "YYYY-MM-DD" }, return_date: { type: "string", description: "Optional return date, YYYY-MM-DD" },
      adults: { type: "integer", minimum: 1, maximum: 9 }, children: { type: "integer", minimum: 0, maximum: 8 },
    }, required: ["origin", "destination", "departure_date"], additionalProperties: false },
    actionClass: "outbound", untrustedOutput: true, forModel: withoutLinks,
    // The approval card says where the search goes before anything is sent.
    async preview(args) { return t("travel.sentFlights", { what: `${str(args.origin)} → ${str(args.destination)} · ${str(args.departure_date)}${args.return_date ? ` – ${str(args.return_date)}` : ""}` }); },
    async run(args, ctx) {
      if (limit.used(ctx.runId, "flight", ctx.userGoal ?? "")) return JSON.stringify({ kind: "travel-search-skipped", reason: "Flights were already searched for this request, and the user did not ask for other dates or routes. Use the earlier results." });
      const origin = airport(args.origin), destination = airport(args.destination), departure = date(args.departure_date);
      const returning = args.return_date ? date(args.return_date) : undefined;
      if (returning && returning < departure) throw new Error("The return date cannot be before the departure date.");
      const adults = count(args.adults ?? 1, 1, 9), children = count(args.children ?? 0, 0, 8);
      if (adults + children > 9) throw new Error("At most 9 passengers can be searched.");
      const money = await moneyFor(ctx.userGoal ?? "");
      const fetchPage = opts.fetchPage;
      if (!fetchPage) throw new Error("Flight search is not available in this build.");
      const query = { origin, destination, departure, ...(returning && { returning }), adults, children, currency: money, country: country() };
      const flights = await searchFlights(query, fetchPage, ctx.signal);
      const options = flightOptions({ flights }, new Date().toISOString(), returning,
        flightSearchUrl(origin, destination, departure, returning, adults, children, money, country()));
      limit.mark(ctx.runId, "flight");
      return JSON.stringify(options);
    },
  };
  const hotelTool: ToolDef = {
    name: "travel_search_hotels",
    description: "Search hotel prices on Trivago's official MCP server. Given one date, assume one night; check-out is optional. If the number of guests is not given, search for one adult. If children are mentioned, use their ages. Results are shown to the user as option cards. Nothing is booked.",
    parameters: { type: "object", properties: {
      destination: { type: "string" }, check_in: { type: "string", description: "YYYY-MM-DD" }, check_out: { type: "string", description: "Optional, YYYY-MM-DD; one night if omitted" },
      adults: { type: "integer", minimum: 1 }, child_ages: { type: "array", items: { type: "integer", minimum: 0, maximum: 17 } }, rooms: { type: "integer", minimum: 1 },
    }, required: ["destination", "check_in"], additionalProperties: false },
    actionClass: "outbound", untrustedOutput: true, forModel: withoutLinks,
    async preview(args) { return t("travel.sentHotels", { what: `${str(args.destination)} · ${str(args.check_in)}${args.check_out ? ` – ${str(args.check_out)}` : ""}` }); },
    async run(args, ctx) {
      if (limit.used(ctx.runId, "hotel", ctx.userGoal ?? "")) return JSON.stringify({ kind: "travel-search-skipped", reason: "Hotels were already searched for this request, and the user did not ask for other dates or areas. Use the earlier results." });
      const destination = str(args.destination).slice(0, 120), arrival = date(args.check_in);
      const departure = args.check_out ? date(args.check_out) : new Date(Date.parse(`${arrival}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      if (!destination || departure <= arrival) throw new Error("A hotel destination and valid check-in/check-out dates are required.");
      const adults = count(args.adults ?? 1, 1, 9), ages = Array.isArray(args.child_ages) ? args.child_ages.map((x) => count(x, 0, 17)) : [];
      if (adults + ages.length > 9) throw new Error("At most 9 guests can be searched.");
      const rooms = count(args.rooms ?? 1, 1, adults);
      const money = await moneyFor(ctx.userGoal ?? "");
      const result = await trivago.callToolResult("trivago-accommodation-search", { query: destination, arrival, departure,
        adults, children: ages.length, ...(ages.length && { children_ages: ages.join("-") }), rooms,
        country: country(), currency: money, language: "EN_GB" }, ctx.signal);
      const options = hotelOptions(result.structuredContent, new Date().toISOString(),
        `${destination} · ${arrival} – ${departure} · ${[t("travel.adults", { count: adults }), ...(ages.length ? [t("travel.children", { count: ages.length })] : [])].join(", ")}`);
      limit.mark(ctx.runId, "hotel");
      return JSON.stringify(options);
    },
  };
  const ready: ConnectorStatus = { state: "ready" };
  return [{
    id: "travel-flights", group: "service",
    get label() { return t("connectors.travelFlights.label"); },
    get description() { return t("connectors.travelFlights.description"); },
    get provides() { return [t("connectors.travelFlights.provides.flights")]; },
    needs: { kind: "none" }, defaultOn: false, requestableWhenOff: true, origin: "builtin",
    status: async () => ready,
    tools: () => [flightTool], disconnect: async () => {},
    instructions: "For flight searches, use travel_search_flights first. The tool picks the currency: the one the user named, otherwise the Mac's regional currency. If the user gave one date, do not search other dates; one successful search is enough. Results are shown as cards; never invent prices or links. An empty result does not prove there are no flights. Do not open a booking page until the user has chosen an option. Never estimate a child's fare from an adult fare; keep the passenger count exact and check dates and weekdays before stating them.",
  }, {
    id: "travel-hotels", group: "service",
    get label() { return t("connectors.travelHotels.label"); },
    get description() { return t("connectors.travelHotels.description"); },
    get provides() { return [t("connectors.travelHotels.provides.hotels")]; },
    needs: { kind: "none" }, defaultOn: false, requestableWhenOff: true, origin: "builtin", status: async () => ready,
    tools: () => [hotelTool], disconnect: async () => trivago.dispose(),
    instructions: "For hotel searches, use travel_search_hotels first. The tool picks the currency: the one the user named, otherwise the Mac's regional currency. If the user gives only a check-in day, assume one night; if the number of guests is unclear, search for one adult first and say so. For one date and area, one successful search is enough; do not search alternatives the user did not ask for. If children are mentioned, ask their ages only when needed. Results are shown as cards. The advertiser name can change on click, so do not state the provider as certain. The user makes the booking.",
  }];
}
