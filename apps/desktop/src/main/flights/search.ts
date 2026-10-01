/**
 * Flight search on Google Flights' public search page.
 *
 * The page inlines its results in an `AF_initDataCallback` blob keyed
 * `ds:1`; elements [2][0] and [3][0] hold the flight rows. The row layout
 * and the round-trip method (pin an outbound, fetch its returns) come from
 * Fli (MIT, Copyright (c) 2025 Punit Arani; see LICENSE in this folder).
 *
 * Pages are fetched through a session of their own (see page-session.ts),
 * as the Chromium Vunemi is; nothing here pretends to be another browser.
 * If Google asks for cookie choices first, the search declines everything
 * that is not essential, the choice that needs no one's consent, and never
 * accepts on the user's behalf.
 */
import { encodeTfs, currencyOfToken, itineraryTfs, passengerKinds, segment, type PinnedLeg } from "./tfs.js";

export const SEARCH_PAGE = "https://www.google.com/travel/flights";

export interface FlightQuery {
  origin: string;
  destination: string;
  departure: string;
  returning?: string;
  adults: number;
  children: number;
  currency: string;
  country: string;
}

export interface FetchedPage { url: string; status: number; text: string }
/** GETs `url`, or POSTs `form` to it. */
export type FetchPage = (url: string, signal?: AbortSignal, form?: URLSearchParams) => Promise<FetchedPage>;

export interface FlightLeg {
  departure_airport: string;
  arrival_airport: string;
  departure_time: string;
  arrival_time: string;
  airline: string;
  flight_number: string;
}

/** One priced itinerary; a round trip lists its outbound legs, then its return legs. */
export interface FlightRow {
  price: number;
  currency: string;
  primary_airline_name?: string;
  booking_url: string;
  legs: FlightLeg[];
}

/** Google kept showing its cookie page, even after its non-essential cookies were declined. */
export class ConsentRequired extends Error {
  constructor() {
    super("Google Flights showed its cookie page, and declining its non-essential cookies did not bring results, so no flights were searched. Tell the user; they can search in the browser instead.");
  }
}

/** How many outbound flights a round trip prices returns for: one page each. */
const ROUND_TRIP_OUTBOUNDS = 6;
const PAGE_ATTEMPTS = 3;
const RETRY_MS = [500, 1500];
const LANGUAGE = "en-GB";

interface Decoded {
  price: number | null;
  currency: string | null;
  airlineName: string | null;
  legs: (FlightLeg & { date: string })[];
}

const pad = (n: unknown) => String(n).padStart(2, "0");
const isList = (value: unknown): value is unknown[] => Array.isArray(value);

function stamp(date: unknown, time: unknown): { day: string; at: string } {
  if (!isList(date) || !isList(time)) throw new Error("leg without date or time");
  const [y, m, d] = date as (number | null)[];
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m! < 1 || m! > 12 || d! < 1 || d! > 31) {
    throw new Error("leg with an invalid date");
  }
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return { day, at: `${day}T${pad(time[0] ?? 0)}:${pad(time[1] ?? 0)}:00` };
}

const code = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,3}$/.test(value)) throw new Error("leg without a valid code");
  return value;
};

function decodeLeg(raw: unknown): FlightLeg & { date: string } {
  if (!isList(raw)) throw new Error("leg is not a list");
  const carrier = isList(raw[22]) ? raw[22] : [];
  const departure = stamp(raw[20], raw[8]);
  return {
    departure_airport: code(raw[3]),
    arrival_airport: code(raw[6]),
    departure_time: departure.at,
    arrival_time: stamp(raw[21], raw[10]).at,
    airline: code(carrier[0]),
    flight_number: typeof carrier[1] === "string" ? carrier[1] : String(carrier[1] ?? ""),
    date: departure.day,
  };
}

export function decodeRow(row: unknown): Decoded {
  if (!isList(row) || !isList(row[0]) || !isList(row[1]) || !isList(row[1][0])) throw new Error("row shape changed");
  const detail = row[0];
  const head = row[1][0] as unknown[];
  const last = head.at(-1);
  const legs = (isList(detail[2]) ? detail[2] : []).map(decodeLeg);
  if (!legs.length) throw new Error("row without legs");
  const names = detail[1];
  return {
    price: typeof last === "number" && Number.isFinite(last) ? last : null,
    currency: currencyOfToken(row[1][1]),
    airlineName: isList(names) && typeof names[0] === "string" ? names[0] : null,
    legs,
  };
}

/** The `ds:1` payload of a search page, or null when the page has none. */
export function payloadOf(html: string): unknown {
  for (const match of html.matchAll(/AF_initDataCallback\((\{[\s\S]*?\})\);/g)) {
    const blob = match[1]!;
    if (/key:\s*'([^']+)'/.exec(blob)?.[1] !== "ds:1") continue;
    const data = /data:([\s\S]*?), sideChannel/.exec(blob)?.[1];
    if (data == null) return null;
    try { return JSON.parse(data); } catch { return null; }
  }
  return null;
}

/**
 * The rows of a payload. A missing block means Google changed the page and
 * is an error; an empty block is a real "no flights".
 */
export function rowsOf(payload: unknown): Decoded[] {
  if (!isList(payload)) throw new Error("Google Flights changed its page: the result is not a list.");
  const raw: unknown[] = [];
  for (const i of [2, 3]) {
    const block = payload[i];
    if (i >= payload.length || (isList(block) && (block.length === 0 || !isList(block[0])))) {
      throw new Error("Google Flights changed its page: no result rows where they used to be.");
    }
    if (isList(block)) raw.push(...(block[0] as unknown[]));
  }
  const rows: Decoded[] = [];
  for (const row of raw) {
    try { rows.push(decodeRow(row)); } catch { /* one odd row costs only that row */ }
  }
  if (raw.length > 0 && rows.length === 0) throw new Error("Google Flights changed its page: none of its rows could be read.");
  return rows.filter((row) => row.price !== null).sort((a, b) => a.price! - b.price!);
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function pageUrl(tfs: string, query: Pick<FlightQuery, "currency" | "country">): string {
  return `${SEARCH_PAGE}?tfs=${tfs}&hl=${LANGUAGE}&gl=${query.country}&curr=${query.currency}`;
}

const CONSENT_SAVE = "https://consent.google.com/save";

const isConsentUrl = (value: string): boolean => {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "consent.google.com"; } catch { return false; }
};

const unescape = (value: string): string => value
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const attribute = (tag: string, name: string): string | null => {
  const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return found ? unescape(found[1]!) : null;
};

/**
 * The "Reject all" form of Google's cookie page, found by its fields rather
 * than its words, which follow the page language: it sets only
 * `set_eom=true`, where "Accept all" also sets `set_sc` and `set_aps`.
 */
export function rejectForm(html: string): { action: string; body: URLSearchParams } | null {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const body = new URLSearchParams();
    for (const input of form[2]!.matchAll(/<input\b[^>]*>/g)) {
      const name = attribute(input[0], "name");
      if (name) body.append(name, attribute(input[0], "value") ?? "");
    }
    if (body.get("set_eom") !== "true" || body.has("set_sc") || body.has("set_aps")) continue;
    const action = attribute(form[1]!, "action");
    return { action: action && isConsentUrl(action) ? action : CONSENT_SAVE, body };
  }
  return null;
}

/** Whether non-essential cookies were already declined during this search. */
interface Consent { declined: boolean }

/** One search page; a page that came back without its results is tried again. */
async function fetchRows(fetchPage: FetchPage, url: string, consent: Consent, signal?: AbortSignal): Promise<Decoded[]> {
  for (let attempt = 0; ; attempt++) {
    const page = await fetchPage(url, signal);
    if (page.status === 429) throw new Error("Google Flights is limiting requests right now. Try again later.");
    if (page.status < 200 || page.status >= 300) throw new Error(`Google Flights answered HTTP ${page.status}.`);
    const payload = payloadOf(page.text);
    if (payload != null) return rowsOf(payload);
    // Redirected, or served in place: a page without results whose forms post to the consent service.
    if (isConsentUrl(page.url) || /consent\.google\.com/.test(page.text)) {
      const reject = consent.declined ? null : rejectForm(page.text);
      if (!reject) throw new ConsentRequired();
      consent.declined = true;
      await fetchPage(reject.action, signal, reject.body);
      continue;
    }
    if (attempt + 1 >= PAGE_ATTEMPTS) throw new Error("Google Flights sent a page without results. Try again in a moment.");
    await wait(RETRY_MS[attempt] ?? 1500, signal);
  }
}

const pins = (legs: Decoded["legs"]): PinnedLeg[] => legs.map((leg) => ({
  origin: leg.departure_airport, date: leg.date, destination: leg.arrival_airport, airline: leg.airline, flightNumber: leg.flight_number,
}));

const plain = ({ date: _date, ...leg }: Decoded["legs"][number]): FlightLeg => leg;

export async function searchFlights(query: FlightQuery, fetchPage: FetchPage, signal?: AbortSignal): Promise<FlightRow[]> {
  const passengers = passengerKinds(query.adults, query.children);
  const roundTrip = !!query.returning;
  const directions = (outbound: PinnedLeg[] = []) => [
    segment(query.origin, query.destination, query.departure, outbound),
    ...(query.returning ? [segment(query.destination, query.origin, query.returning)] : []),
  ];
  const link = (legs: Decoded["legs"][]) =>
    `${SEARCH_PAGE}/booking?tfs=${itineraryTfs(legs.map(pins), passengers)}&curr=${query.currency}&hl=${LANGUAGE}&gl=${query.country}`;
  const row = (price: number, currency: string | null, airlineName: string | null, legs: Decoded["legs"][]): FlightRow => ({
    price, currency: currency ?? query.currency, ...(airlineName && { primary_airline_name: airlineName }),
    booking_url: link(legs), legs: legs.flat().map(plain),
  });

  const consent: Consent = { declined: false };
  const outbound = await fetchRows(fetchPage, pageUrl(encodeTfs(directions(), { roundTrip, passengers }), query), consent, signal);
  if (!roundTrip) return outbound.map((o) => row(o.price!, o.currency, o.airlineName, [o.legs]));

  // Each outbound's returns are priced as a pair; keep the cheapest return
  // for each, so the cards show different outbound flights.
  const rows: FlightRow[] = [];
  for (const out of outbound.slice(0, ROUND_TRIP_OUTBOUNDS)) {
    const tfs = encodeTfs(directions(pins(out.legs)), { roundTrip, passengers });
    const back = (await fetchRows(fetchPage, pageUrl(tfs, query), consent, signal))[0];
    if (back) rows.push(row(back.price ?? out.price!, back.currency ?? out.currency, out.airlineName, [out.legs, back.legs]));
  }
  return rows.sort((a, b) => a.price - b.price);
}
