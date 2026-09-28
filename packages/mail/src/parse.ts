/**
 * A raw message (RFC 822 source) into what mail_read shows. Shared by the
 * transports that get a message whole: the Mac's Mail app hands over its
 * source, because asking it for the text makes it render the HTML, and on
 * macOS 27 that crashed Mail.
 */
import { simpleParser, type AddressObject } from "mailparser";
import type { MailAddress, MessageBody } from "./types.js";

function people(item: AddressObject | AddressObject[] | undefined): MailAddress[] {
  return (Array.isArray(item) ? item : item ? [item] : []).flatMap((part) =>
    part.value.map((value) => ({ ...(value.name && { name: value.name }), address: value.address ?? "" })),
  );
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML-only mail as plain text: enough to read, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseMessageSource(source: string | Buffer): Promise<Pick<MessageBody, "to" | "cc" | "text" | "attachments">> {
  const parsed = await simpleParser(source);
  return {
    to: people(parsed.to),
    cc: people(parsed.cc),
    text: parsed.text ?? (typeof parsed.html === "string" && parsed.html ? htmlToText(parsed.html) : "[No plain-text content.]"),
    attachments: parsed.attachments.map((item) => ({ name: item.filename ?? "(unnamed attachment)", bytes: item.size })),
  };
}
