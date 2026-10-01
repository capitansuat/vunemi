/**
 * The `tfs` parameter Google Flights addresses a search or an itinerary by,
 * and the currency inside a price token. Both are small protobuf messages.
 *
 * Field layout from Fli (MIT, Copyright (c) 2025 Punit Arani; see LICENSE
 * in this folder), reverse-engineered there from browser captures:
 *
 *   1 = 28, 2 = 2, 14 = 1 (constants)   8  = passenger kind, one per traveller
 *   3 = segment, repeated               9  = cabin (1 economy)
 *     3.2  departure date               16 = max-uint64 (itinerary links only)
 *     3.4  pinned leg, repeated         19 = 2 one-way, 1 round trip
 *     3.13 origin, 3.14 destination
 */

export interface PinnedLeg {
  origin: string;
  date: string;
  destination: string;
  airline: string;
  flightNumber: string;
}

const utf8 = new TextEncoder();

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    const low = Number(v & 0x7fn);
    v >>= 7n;
    bytes.push(v > 0n ? low | 0x80 : low);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

const key = (field: number, wire: 0 | 2) => varint(BigInt((field << 3) | wire));
const num = (field: number, value: number | bigint) => join([key(field, 0), varint(BigInt(value))]);
const bytes = (field: number, body: Uint8Array) => join([key(field, 2), varint(BigInt(body.length)), body]);
const text = (field: number, value: string) => bytes(field, utf8.encode(value));

/** Passenger kinds Google numbers 1 adult, 2 child. */
export function passengerKinds(adults: number, children: number): number[] {
  return [...Array<number>(adults).fill(1), ...Array<number>(children).fill(2)];
}

/** One travel direction; pinning legs asks for the options that follow them. */
export function segment(origin: string, destination: string, date: string, pinned: readonly PinnedLeg[] = []): Uint8Array {
  return bytes(3, join([
    text(2, date),
    ...pinned.map((leg) => bytes(4, join([
      text(1, leg.origin), text(2, leg.date), text(3, leg.destination), text(5, leg.airline), text(6, leg.flightNumber),
    ]))),
    bytes(13, join([num(1, 1), text(2, origin)])),
    bytes(14, join([num(1, 1), text(2, destination)])),
  ]));
}

export function encodeTfs(segments: Uint8Array[], opts: { roundTrip: boolean; passengers: number[]; itinerary?: boolean }): string {
  const body = join([
    num(1, 28), num(2, 2), ...segments,
    ...opts.passengers.map((kind) => num(8, kind)),
    num(9, 1), num(14, 1),
    ...(opts.itinerary ? [bytes(16, num(1, (1n << 64n) - 1n))] : []),
    num(19, opts.roundTrip ? 1 : 2),
  ]);
  return Buffer.from(body).toString("base64url");
}

/** The link that opens Google's booking page for exactly these flights. */
export function itineraryTfs(directions: PinnedLeg[][], passengers: number[]): string {
  return encodeTfs(
    directions.map((legs) => segment(legs[0]!.origin, legs.at(-1)!.destination, legs[0]!.date, legs)),
    { roundTrip: directions.length === 2, passengers, itinerary: true },
  );
}

function readVarint(data: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift < 53; shift += 7) {
    const byte = data[at++];
    if (byte === undefined) throw new Error("truncated varint");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, at];
  }
  throw new Error("varint too large");
}

function fields(data: Uint8Array): { field: number; body?: Uint8Array }[] {
  const out: { field: number; body?: Uint8Array }[] = [];
  let at = 0;
  while (at < data.length) {
    const [tag, next] = readVarint(data, at);
    at = next;
    const wire = tag & 7;
    if (wire === 0) at = readVarint(data, at)[1];
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const [length, start] = readVarint(data, at);
      if (start + length > data.length) throw new Error("field past end");
      out.push({ field: tag >> 3, body: data.subarray(start, start + length) });
      at = start + length;
    } else throw new Error(`wire type ${wire}`);
  }
  return out;
}

/** The ISO code inside a row's price token (field 3.3), or null. */
export function currencyOfToken(token: unknown): string | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const inner = fields(Buffer.from(token, "base64url")).find((f) => f.field === 3)?.body;
    const code = inner && fields(inner).find((f) => f.field === 3)?.body;
    const value = code ? new TextDecoder().decode(code).toUpperCase() : "";
    return /^[A-Z]{3}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
