/** Two opt-in travel sources. Searches are user-initiated; neither books nor pays. */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Connector, ConnectorStatus } from "@vunemi/connectors";
import { wantsMoreTravelSearches, type ToolDef } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import { McpClient } from "@vunemi/mcp";

const TRIVAGO_MCP = "https://mcp.trivago.com/mcp";
// PyPI 0.9.0 lacks child passengers in its MCP tool. Pin the current source
// until a release with that schema is published; uv caches it after setup.
const FLI_REV = "881aee5ff4321e81ea2157cb44be94ce6a21dc1b";
const FLI_SOURCE = `flights[mcp] @ git+https://github.com/punitarani/fli@${FLI_REV}`;

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
const UV_MISSING = "Fli needs uv (https://docs.astral.sh/uv/), which is not installed on this Mac. Tell the user it is missing; you may search in the browser instead.";
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
  source: "fli" | "trivago";
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
  const safe = safeUrl(offer, ["www.trivago.co.uk", "www.trivago.com"]);
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
  if (data.success === false) throw new Error(str(data.error) || "The Fli search failed.");
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
  return { kind: "travel-options", source: "fli", searchedAt, options, resultCount, ...(searchUrl && { searchUrl }),
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
    const url = safeUrl(row.accommodation_url, ["www.trivago.co.uk", "www.trivago.com"]);
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

async function executable(name: string): Promise<string | null> {
  const candidates = [join(homedir(), ".local/bin", name), "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name))];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* next */ }
  }
  return null;
}

export function travelConnectors(opts: { systemCurrency?: () => Promise<string>; countryCode?: () => string } = {}): Connector[] {
  const limit = new TravelSearchLimit();
  let systemMoney: Promise<string> | null = null;
  const moneyFor = (goal: string) => travelCurrency(goal, () => (systemMoney ??= (opts.systemCurrency ?? macCurrency)()));
  const country = () => { const code = str(opts.countryCode?.()).toUpperCase(); return /^[A-Z]{2}$/.test(code) ? code : "GB"; };
  let fli: McpClient | null = null;
  const trivago = new McpClient({ kind: "http", url: TRIVAGO_MCP });
  const fliClient = async (): Promise<McpClient> => {
    if (fli) return fli;
    const uvx = await executable("uvx");
    if (!uvx) throw new Error(UV_MISSING);
    fli = new McpClient({ kind: "stdio", command: uvx, args: ["--from", FLI_SOURCE, "--with", "click", "fli-mcp"] }, undefined, 60_000);
    return fli;
  };
  const flightTool: ToolDef = {
    name: "travel_search_flights",
    description: "Search flight prices and options with Fli. Use IATA airport codes, YYYY-MM-DD dates and passenger counts. A child is 2–11 years old. Results are shown to the user as option cards. Nothing is booked.",
    parameters: { type: "object", properties: {
      origin: { type: "string", description: "Departure IATA code, e.g. MAN" }, destination: { type: "string", description: "Arrival IATA code, e.g. ADB" },
      departure_date: { type: "string", description: "YYYY-MM-DD" }, return_date: { type: "string", description: "Optional return date, YYYY-MM-DD" },
      adults: { type: "integer", minimum: 1, maximum: 9 }, children: { type: "integer", minimum: 0, maximum: 8 },
    }, required: ["origin", "destination", "departure_date"], additionalProperties: false },
    actionClass: "outbound", untrustedOutput: true,
    async check() { return (await executable("uvx")) ? null : UV_MISSING; },
    async preview(args) { return `Fli › ${str(args.origin)} → ${str(args.destination)} · ${str(args.departure_date)}${args.return_date ? ` – ${str(args.return_date)}` : ""}`; },
    async run(args, ctx) {
      if (limit.used(ctx.runId, "flight", ctx.userGoal ?? "")) return JSON.stringify({ kind: "travel-search-skipped", reason: "Flights were already searched for this request, and the user did not ask for other dates or routes. Use the earlier results." });
      const origin = airport(args.origin), destination = airport(args.destination), departure = date(args.departure_date);
      const returning = args.return_date ? date(args.return_date) : undefined;
      if (returning && returning < departure) throw new Error("The return date cannot be before the departure date.");
      const adults = count(args.adults ?? 1, 1, 9), children = count(args.children ?? 0, 0, 8);
      if (adults + children > 9) throw new Error("At most 9 passengers can be searched.");
      const money = await moneyFor(ctx.userGoal ?? "");
      const client = await fliClient();
      const result = await client.callToolResult("search_flights", { origin, destination, departure_date: departure,
        ...(returning && { return_date: returning }), passengers: adults, children, currency: money, language: "en-GB", country: country(), top_n: 10 }, ctx.signal);
      const options = flightOptions(result.structuredContent, new Date().toISOString(), returning,
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
    actionClass: "outbound", untrustedOutput: true,
    async preview(args) { return `Trivago › ${str(args.destination)} · ${str(args.check_in)}${args.check_out ? ` – ${str(args.check_out)}` : ""}`; },
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
    status: async () => (await executable("uvx")) ? ready : { state: "blocked", reason: t("connectors.travelFlights.needsUv") },
    tools: () => [flightTool], disconnect: async () => { fli?.dispose(); fli = null; },
    instructions: "For flight searches, use travel_search_flights first. The tool picks the currency: the one the user named, otherwise the Mac's regional currency. If the user gave one date, do not search other dates; one successful search is enough. Results are shown as cards; never invent prices or links. An empty result does not prove there are no flights. Do not open a booking page until the user has chosen an option.",
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
