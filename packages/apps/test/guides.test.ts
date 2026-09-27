import { describe, expect, it } from "vitest";
import type { ToolContext, ToolDef } from "@ocak/agent-core";
import { APP_GROUPS, APP_GUIDE_INDEX, createGuideTool, onDemand } from "../src/guides.js";

describe("app guides", () => {
  it("opens the group it was asked for and returns its guide", async () => {
    const opened: string[] = [];
    const out = await createGuideTool().run({ group: "photos" }, { openTools: (g: string) => opened.push(g) } as unknown as ToolContext);
    expect(opened).toEqual(["photos"]);
    expect(out).toContain("photos_search");
  });

  it("refuses a group it does not know, without opening anything", async () => {
    const opened: string[] = [];
    await expect(createGuideTool().run({ group: "terminal" }, { openTools: (g: string) => opened.push(g) } as unknown as ToolContext)).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it("lists every group in the always-present index", () => {
    for (const group of APP_GROUPS) expect(APP_GUIDE_INDEX).toContain(`- ${group.id}:`);
  });

  it("opens music or photos for a request that is about them, in any language", () => {
    const tool = (name: string, extra: Partial<ToolDef> = {}) => ({ name, description: "", parameters: { type: "object" }, actionClass: "read", run: async () => "", ...extra }) as ToolDef;
    const music = onDemand("music", [tool("music_now_playing")])[0]!.wantedFor!;
    for (const ask of ["Müzik uygulamasında şu an ne çalıyor?", "What's playing in Music?", "Şarkıyı durdur", "Spiel das Lied", "音乐里在放什么", "지금 무슨 노래야"]) expect(music.test(ask)).toBe(true);
    for (const ask of ["Takvimime bak", "Summarize this article"]) expect(music.test(ask)).toBe(false);
    const photos = onDemand("photos", [tool("photos_search")])[0]!.wantedFor!;
    for (const ask of ["Fotoğraflarımda köpek bul", "Find photos of the beach", "Найди фото собаки", "写真で犬を探して"]) expect(photos.test(ask)).toBe(true);
    const browsers = onDemand("browsers", [tool("browser_tabs")])[0]!.wantedFor!;
    for (const ask of ["Safari'de açık sekmeleri listele", "Open example.com in Chrome"]) expect(browsers.test(ask)).toBe(true);
    expect(browsers.test("Sekmeleri listele")).toBe(false);
    const contacts = onDemand("contacts", [tool("contacts_search")])[0]!.wantedFor!;
    for (const ask of ["Kişilerimde adında \"a\" geçen kişileri ara.", "Rehberde Ayşe'yi bul", "Search my contacts", "連絡先で探して"]) expect(contacts.test(ask)).toBe(true);
    expect(contacts.test("Bu kişi kim?")).toBe(false);
    // A tool's own words win; a group without words adds none.
    const own = /\bexcel\b/i;
    expect(onDemand("office", [tool("excel_read", { wantedFor: own })])[0]!.wantedFor).toBe(own);
    const messages = onDemand("messages", [tool("messages_send")])[0]!.wantedFor!;
    for (const ask of ["iMessage ile test@example.com adresine mesaj gönder", "SMS at", "WhatsApp'tan yaz"]) expect(messages.test(ask)).toBe(true);
    expect(messages.test("Ayşe'ye bir e-posta mesajı gönder")).toBe(false);
    expect(onDemand("other_apps", [tool("app_command")])[0]!.wantedFor).toBeUndefined();
  });
});
