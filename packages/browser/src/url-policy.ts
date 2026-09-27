/**
 * Where the agent may navigate. Deliberately narrow: public http(s), plus the
 * private-network sites the user has trusted in Settings.
 *
 * Blocking loopback and private ranges keeps the agent away from this app's
 * own control surfaces (the dev server, the browser's DevTools port, the
 * extension bridge) and from the user's LAN — the SSRF shape of prompt
 * injection. `new URL()` does the canonicalising (tabs/newlines stripped,
 * `127.1` and `0x7f000001` → `127.0.0.1`), so checks run on the real host.
 *
 * A campus or company intranet is private too, and the user may know it well.
 * Such a host opens once the user adds it to the trusted list; only the user
 * can, from Settings. This computer's own addresses can never be trusted:
 * Vunemi's own controls live there.
 *
 * That checks the first address the agent asks for. Everything a page asks
 * for afterwards (redirects, new windows, frames, fetches) goes through
 * `requestGuard`, which also resolves host names.
 */

/** The hosts the user trusts, lower-case and without a trailing dot. */
export type TrustedSites = ReadonlySet<string>;
const NONE: TrustedSites = new Set();

const TRUST_HINT = "If the user knows and trusts this site, they can add it under Settings › Security › Trusted sites, and it will open. Tell the user this; don't retry it or look for another way in.";

function privateNetwork(host: string, address?: string): string {
  const where = address ? `${host} points to a private network address (${address})` : `${host} is on a private network`;
  return `${where}, such as a campus or company intranet, a router or another device, so Vunemi's browser won't open it. ${TRUST_HINT}`;
}

/** Whether a refusal is one the user can lift by trusting the site. */
export function trustWouldOpen(reason: string): boolean {
  return reason.endsWith(TRUST_HINT);
}

function thisComputer(host: string): string {
  return `${host} is this computer's own address. Vunemi's browser never opens it, because Vunemi's own controls live there.`;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.$/, "").toLowerCase();
}

/** localhost and loopback, plus link-local (cloud metadata lives there): never trusted. */
function isThisComputer(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "[::]" || host === "[::1]") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return v4[1] === "127" || v4[1] === "0" || (v4[1] === "169" && v4[2] === "254");
  const mapped = host.match(/^\[::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]$/);
  if (mapped) return isThisComputer(mapped[1]!);
  const hex = host.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isThisComputer(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^\[fe[89ab]/.test(host);
}

/**
 * Turns what the user typed into a host that can be trusted: a bare host or a
 * full address, with or without a path. Refused when it is not a web host,
 * or is this computer's own address.
 */
export function trustableHost(raw: string): { host: string } | { refused: "invalid" | "this-computer" } {
  const text = raw.trim();
  if (!text || /[\s*]/.test(text)) return { refused: "invalid" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { refused: "invalid" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return { refused: "invalid" };
  const host = hostOf(url);
  if (isThisComputer(host)) return { refused: "this-computer" };
  if (!host.includes(".") && !host.startsWith("[")) return { refused: "invalid" };
  return { host };
}

export function checkNavigation(raw: string, trusted: TrustedSites = NONE): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return `"${raw}" is not a valid absolute URL. Include the scheme, e.g. https://example.com`;
  }

  if (url.href === "about:blank") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `Navigation to ${url.protocol} URLs is not allowed. Only http and https pages can be opened.`;
  }
  if (url.username || url.password) {
    return "URLs with embedded credentials are not allowed.";
  }

  const host = hostOf(url);
  if (isThisComputer(host)) return thisComputer(host);
  if (trusted.has(host)) return null;
  if (host.endsWith(".local") || host.endsWith(".internal") || isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return privateNetwork(host);
  }
  return null;
}

/** Asks the system resolver for every address a host name has. */
export type Lookup = (host: string) => Promise<string[]>;

const GUARD_TTL_MS = 60_000;
const GUARD_MAX_HOSTS = 500;

/**
 * Judges every request a page makes, not only the first address: a page can
 * redirect, open a window, frame or fetch 127.0.0.1 or the user's router. A
 * host name is resolved and refused when any of its addresses is private; one
 * that doesn't resolve is left to fail on its own. Chromium resolves again
 * after this, so a name that changes its answer in between (DNS rebinding)
 * can still get through; this closes the plain cases.
 *
 * A trusted host opens as a page, and pages of trusted hosts may use each
 * other. A public page may not reach a trusted private host in the background
 * (the router attack Chrome's Local Network Access guards against), so `from`
 * is the address of the page making the request, absent for the page itself.
 * Returns why a request is refused, or null.
 */
export function requestGuard(
  lookup: Lookup,
  ttlMs = GUARD_TTL_MS,
  trusted: () => TrustedSites = () => NONE,
): (raw: string, from?: string) => Promise<string | null> {
  const known = new Map<string, { at: number; addresses: Promise<string[]> }>();
  const resolve = (host: string): Promise<string[]> => {
    const now = Date.now();
    const cached = known.get(host);
    if (cached && now - cached.at < ttlMs) return cached.addresses;
    if (known.size >= GUARD_MAX_HOSTS) known.clear();
    const addresses = lookup(host).catch(() => []);
    known.set(host, { at: now, addresses });
    return addresses;
  };
  return async (raw, from) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `"${raw.slice(0, 200)}" is not a valid URL.`;
    }
    // data:, blob: and the like are the page's own; only the network is judged.
    const web = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    if (web !== "http:" && web !== "https:") return null;
    const host = hostOf(url);
    const trust = trusted();
    const isTrusted = trust.has(host) && !isThisComputer(host);
    if (isTrusted && from !== undefined) {
      // A page that can't be told is treated as a stranger.
      const page = safeHost(from);
      if (page === null || !trust.has(page)) {
        return `A page on ${page ?? "an unknown site"} tried to reach ${host}, a trusted private-network site, in the background. Only pages of trusted sites may do that.`;
      }
    }
    if (!isTrusted) {
      const fixed = checkNavigation(`${web}//${url.host}/`);
      if (fixed) return fixed;
    }
    if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null; // an address, judged above
    // A name is judged by what it resolves to; one that doesn't resolve is left to fail on its own.
    const addresses = await resolve(host);
    const own = addresses.find((ip) => isThisComputer(ip.includes(":") ? `[${ip.replace(/%.*$/, "")}]` : ip));
    if (own) return thisComputer(`${host} (${own})`);
    const inside = isTrusted ? undefined : addresses.find(isPrivateAddress);
    return inside ? privateNetwork(host, inside) : null;
  };
}

function safeHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? hostOf(url) : null;
  } catch {
    return null;
  }
}

/** A bare IPv4 or IPv6 address (no brackets) that is loopback, private, link-local or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return bare.includes(":") ? isPrivateIPv6(`[${bare}]`) : isPrivateIPv4(bare);
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIPv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1);
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped, as a resolver writes it (::ffff:127.0.0.1) or as URL does (::ffff:7f00:1).
  const dotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]!);
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h); // unique-local, link-local
}
