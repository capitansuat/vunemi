import { describe, expect, it, vi } from "vitest";
import { createWhatsAppTool, whatsappNumber, whatsappUrl } from "../src/whatsapp.js";

const ctx = { signal: new AbortController().signal } as never;

describe("whatsapp_compose", () => {
  it("accepts one international number and refuses anything else", () => {
    expect(whatsappNumber("+90 555 123 45 67")).toBe("905551234567");
    expect(whatsappNumber("+1 (415) 555-0100")).toBe("14155550100");
    for (const bad of ["0555 123 45 67", "ali@example.com", "+90 555; rm", "123", "+90555123456712345"]) {
      expect(() => whatsappNumber(bad)).toThrow(/country code/);
    }
  });

  it("puts the text in the link, encoded, for the app or the web", () => {
    expect(whatsappUrl("905551234567", "Saat 5 & sonra?", true)).toBe("whatsapp://send?phone=905551234567&text=Saat%205%20%26%20sonra%3F");
    expect(whatsappUrl("905551234567", "hi", false)).toBe("https://wa.me/905551234567?text=hi");
  });

  it("opens the chat, asks first, and never claims it sent", async () => {
    const open = vi.fn(async () => {});
    const tool = createWhatsAppTool({ open, hasApp: () => true });
    expect(tool.alwaysAsk).toBe(true);
    expect(tool.actionClass).toBe("write-local");
    const out = String(await tool.run({ to: "+90 555 123 45 67", text: "Saat 5'te görüşürüz" }, ctx));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^whatsapp:\/\/send\?phone=905551234567&text=/));
    expect(out).toContain("Nothing has been sent");
    expect(out).not.toMatch(/\bwas sent\b/);
  });

  it("opens nothing for an empty or overlong text", async () => {
    const open = vi.fn(async () => {});
    const tool = createWhatsAppTool({ open, hasApp: () => false });
    await expect(tool.run({ to: "+905551234567", text: "  " }, ctx)).rejects.toThrow();
    await expect(tool.run({ to: "+905551234567", text: "x".repeat(2001) }, ctx)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
