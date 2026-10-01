import { t } from "@vunemi/i18n";
import type { CallView } from "./fold.js";

export interface TravelOption { title: string; price: string; detail: string; extra?: string; url: string; image?: string }
export interface TravelResults { kind: "travel-options"; source: "fli" | "trivago"; searchedAt: string; options: TravelOption[]; resultCount: number; searchUrl?: string; summary?: string; warning?: string }

/** Give the next turn the actual card, even if earlier tool output was compacted. */
export function travelSelectionMessage(results: TravelResults, index: number, pageOpened: boolean): string {
  const option = results.options[index];
  if (!option) throw new Error("Travel option not found");
  const item = JSON.stringify({ source: results.source, title: option.title, displayedPrice: option.price, offerUrl: option.url });
  return t("travel.chose", { n: String(index + 1), item, page: t(pageOpened ? "travel.pageTried" : "travel.pageFailed") });
}

function safeUrl(value: unknown, hosts: string[]): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

export function parseTravelOptions(call: Pick<CallView, "tool" | "status" | "output">): TravelResults | null {
  if (call.status !== "ok" || (call.tool !== "travel_search_flights" && call.tool !== "travel_search_hotels")) return null;
  const source = call.tool === "travel_search_flights" ? "fli" : "trivago";
  const wrapped = call.output?.match(/^<untrusted_content source="travel_search_(?:flights|hotels)">\n([\s\S]*)\n<\/untrusted_content>$/);
  if (!wrapped) return null;
  try {
    const raw: unknown = JSON.parse(wrapped[1]!);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const data = raw as Record<string, unknown>;
    if (data.kind !== "travel-options" || data.source !== source || !Array.isArray(data.options)) return null;
    const hosts = source === "fli" ? ["www.google.com", "google.com"] : ["www.trivago.co.uk", "www.trivago.com"];
    const options: TravelOption[] = data.options.slice(0, 6).flatMap((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const url = safeUrl(row.url, hosts);
      if (!url || typeof row.title !== "string" || typeof row.price !== "string" || typeof row.detail !== "string") return [];
      return [{ title: row.title.slice(0, 140), price: row.price.slice(0, 80), detail: row.detail.slice(0, 260),
        ...(typeof row.extra === "string" && { extra: row.extra.slice(0, 260) }), url,
        ...(safeUrl(row.image, ["imgcy.trivago.com"]) && { image: safeUrl(row.image, ["imgcy.trivago.com"])! }) }];
    });
    return { kind: "travel-options", source, searchedAt: typeof data.searchedAt === "string" ? data.searchedAt : "",
      options, resultCount: typeof data.resultCount === "number" && Number.isInteger(data.resultCount) ? data.resultCount : options.length,
      ...(safeUrl(data.searchUrl, hosts) && { searchUrl: safeUrl(data.searchUrl, hosts)! }),
      ...(typeof data.summary === "string" && { summary: data.summary.slice(0, 220) }),
      ...(typeof data.warning === "string" && { warning: data.warning.slice(0, 300) }) };
  } catch { return null; }
}
