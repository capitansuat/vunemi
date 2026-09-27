/**
 * Where the agent may navigate. Deliberately narrow: public http(s) only.
 *
 * Blocking loopback and private ranges keeps the agent away from this app's
 * own control surfaces (the dev server, the browser's DevTools port, the
 * extension bridge) and from the user's LAN — the SSRF shape of prompt
 * injection. `new URL()` does the canonicalising (tabs/newlines stripped,
 * `127.1` and `0x7f000001` → `127.0.0.1`), so checks run on the real host.
 *
 * That checks the first address the agent asks for. Everything a page asks
 * for afterwards (redirects, new windows, frames, fetches) goes through
 * `requestGuard`, which also resolves host names.
 */

export function checkNavigation(raw: string): string | null {
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

  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return `Local network address ${host} is blocked.`;
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return `Private or loopback address ${host} is blocked.`;
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
 * Returns why a request is refused, or null.
 */
export function requestGuard(lookup: Lookup, ttlMs = GUARD_TTL_MS): (raw: string) => Promise<string | null> {
  const known = new Map<string, { at: number; verdict: Promise<string | null> }>();
  return async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `"${raw.slice(0, 200)}" is not a valid URL.`;
    }
    // data:, blob: and the like are the page's own; only the network is judged.
    const web = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    if (web !== "http:" && web !== "https:") return null;
    const fixed = checkNavigation(`${web}//${url.host}/`);
    if (fixed) return fixed;
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null; // an address, judged above
    const now = Date.now();
    const cached = known.get(host);
    if (cached && now - cached.at < ttlMs) return cached.verdict;
    if (known.size >= GUARD_MAX_HOSTS) known.clear();
    const verdict = lookup(host).then(
      (addresses) => {
        const inside = addresses.find(isPrivateAddress);
        return inside ? `${host} points to a private or loopback address (${inside}) and is blocked.` : null;
      },
      () => null,
    );
    known.set(host, { at: now, verdict });
    return verdict;
  };
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
