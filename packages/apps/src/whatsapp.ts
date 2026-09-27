/**
 * WhatsApp, the only way it can be done honestly for a personal account:
 * Vunemi opens the chat with the text already typed, and the user presses
 * Send. WhatsApp offers no API for personal accounts, and driving WhatsApp
 * Web breaks its terms and risks the user's number. Nothing is read.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolDef } from "@ocak/agent-core";
import { t } from "@ocak/i18n";

export const WHATSAPP_GUIDE = `WhatsApp:
- whatsapp_compose opens a WhatsApp chat with one phone number and the text already typed in. It does not send: the user reads it and presses Send themselves. Say exactly that; never say the message was sent.
- It can't read WhatsApp messages or find contacts there. Get the number from the user or from contacts_search.`;

export interface WhatsAppOptions {
  /** Opens a URL with the Mac's own handler. */
  open?: (url: string) => Promise<void>;
  /** Whether the WhatsApp app is installed; otherwise the chat opens in the browser. */
  hasApp?: () => boolean;
}

/** A phone number as WhatsApp wants it: country code and number, digits only. */
export function whatsappNumber(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) throw new Error("Give one phone number with its country code, e.g. +90 555 123 45 67.");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
    throw new Error("Give one phone number with its country code, e.g. +90 555 123 45 67.");
  }
  return digits;
}

export function whatsappUrl(number: string, text: string, app: boolean): string {
  const encoded = encodeURIComponent(text);
  return app ? `whatsapp://send?phone=${number}&text=${encoded}` : `https://wa.me/${number}?text=${encoded}`;
}

const openWithMac = (url: string) =>
  new Promise<void>((resolve, reject) => execFile("/usr/bin/open", [url], { timeout: 15_000 }, (err) => (err ? reject(err) : resolve())));

export function createWhatsAppTool(opts: WhatsAppOptions = {}): ToolDef {
  const open = opts.open ?? openWithMac;
  const hasApp = opts.hasApp ?? (() => existsSync("/Applications/WhatsApp.app"));
  return {
    name: "whatsapp_compose",
    description: "Open a WhatsApp chat with one phone number and the text typed in, for the user to send. Does not send.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "One phone number with country code, e.g. +90 555 123 45 67" },
        text: { type: "string" },
      },
      required: ["to", "text"],
    },
    // Nothing leaves the Mac here; the user sends from WhatsApp.
    actionClass: "write-local",
    alwaysAsk: true,
    preview: async (a) => t("apps.whatsapp.compose", { to: String(a.to ?? ""), text: String(a.text ?? "").slice(0, 500) }),
    async run(a) {
      const number = whatsappNumber(a.to);
      const text = String(a.text ?? "");
      if (!text.trim() || text.length > 2000) throw new Error("text must be 1 to 2000 characters.");
      const app = hasApp();
      await open(whatsappUrl(number, text, app));
      return `Opened a WhatsApp chat with +${number} ${app ? "in the WhatsApp app" : "in the browser (WhatsApp isn't installed; the page offers WhatsApp Web)"} with the text typed in. Nothing has been sent: the user sends it by pressing Send in WhatsApp.`;
    },
  };
}
