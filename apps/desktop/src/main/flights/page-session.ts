/**
 * The session the flight search reads Google Flights through: in memory
 * only, apart from the embedded browser, and gone when Vunemi quits. The
 * user's own cookies and sign-ins are never sent, and nothing it collects
 * is kept.
 */
import { app, session, type Session } from "electron";
import type { FetchPage } from "./search.js";

/** The only hosts this session may reach. */
const HOSTS = new Set(["www.google.com", "consent.google.com"]);

let flights: Session | null = null;

function flightSession(): Session {
  if (flights) return flights;
  // No "persist:" prefix: Chromium keeps this partition in memory.
  const ses = session.fromPartition("vunemi-flights");
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|vunemi|@vunemi\/desktop)\/\S+/gi, ""));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === "https:" && HOSTS.has(url.hostname);
    } catch { /* not a URL */ }
    cb({ cancel: !allowed });
  });
  return (flights = ses);
}

export const fetchFlightPage: FetchPage = async (url, signal, form) => {
  const timeout = AbortSignal.timeout(30_000);
  const response = await flightSession().fetch(url, {
    credentials: "include",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(form && { method: "POST", body: form }),
  });
  // Electron leaves `url` empty when the request was not redirected.
  return { url: response.url || url, status: response.status, text: await response.text() };
};
