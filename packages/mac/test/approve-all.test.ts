import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputCover, soundsLikeSendOrDelete } from "../src/approve-all.js";
const notMac = process.platform !== "darwin";

describe("what approve all reaches in an app", () => {
  // Windows and Linux: macOS desktop control only.
  it.skipIf(notMac)("covers an ordinary app by its identity", async () => {
    expect(await inputCover({ name: "TextEdit", bundleId: "com.apple.TextEdit" })).toEqual({ key: "app:com.apple.TextEdit", app: "TextEdit" });
    expect(await inputCover({ name: "TextEdit", bundleId: "com.apple.TextEdit" }, "Bold")).toEqual({ key: "app:com.apple.TextEdit", app: "TextEdit" });
  });

  it.each([
    ["Mail", "com.apple.mail"],
    ["Messages", "com.apple.MobileSMS"],
    ["WhatsApp", "net.whatsapp.WhatsApp"],
    ["Safari", "com.apple.Safari"],
    ["Google Chrome", "com.google.Chrome"],
    ["Calendar", "com.apple.iCal"],
  ])("never covers %s, where a click can send", async (name, bundleId) => {
    expect(await inputCover({ name, bundleId })).toBeUndefined();
  });

  // Windows and Linux: macOS desktop control only.
  it.skipIf(notMac)("leaves a control or key that sounds like sending or deleting to its own card", async () => {
    expect(await inputCover({ name: "Finder", bundleId: "com.apple.finder" }, "Move to Trash")).toBeUndefined();
    expect(await inputCover({ name: "Finder", bundleId: "com.apple.finder" }, "cmd+delete")).toBeUndefined();
    expect(await inputCover({ name: "Finder", bundleId: "com.apple.finder" }, "cmd+backspace")).toBeUndefined();
    expect(await inputCover({ name: "Finder", bundleId: "com.apple.finder" }, "New Folder")).toBeDefined();
  });

  it.each(["Send", "SİL", "Sil", "Gönder", "Çöp Kutusuna Taşı", "Supprimer", "Löschen", "Eliminar", "Elimina", "Excluir", "Удалить", "Отправить", "削除", "送信", "삭제", "보내기", "删除", "發送", "Buy now", "Satın al"])("hears %s", (word) => {
    expect(soundsLikeSendOrDelete(word)).toBe(true);
  });

  it.each(["Save", "Kaydet", "Bold", "Align Left", "Undo", "cmd+s", "return", "Font", "Enregistrer", "Speichern", "保存", "저장"])("lets %s through", (word) => {
    expect(soundsLikeSendOrDelete(word)).toBe(false);
  });
});

describe("an app whose name on screen isn't its folder's", () => {
  const dir = mkdtempSync(join(tmpdir(), "vunemi-apps-"));
  const bundle = (folder: string, bundleId: string, category: string) => {
    mkdirSync(join(dir, `${folder}.app`, "Contents"), { recursive: true });
    writeFileSync(join(dir, `${folder}.app`, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>LSApplicationCategoryType</key><string>${category}</string></dict></plist>`);
  };
  bundle("Notes", "org.example.notes", "public.app-category.productivity");
  bundle("MyBank", "org.example.bank", "public.app-category.finance");
  // Spotlight stands in: it finds a bundle by id, whatever the app is called on screen.
  const look = { folders: [dir], withId: async (id: string) => ({ "org.example.notes": [join(dir, "Notes.app")], "org.example.bank": [join(dir, "MyBank.app")] } as Record<string, string[]>)[id] ?? [] };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Windows and Linux: macOS desktop control only.
  it.skipIf(notMac)("is still covered when it is an ordinary app (Notlar for Notes)", async () => {
    expect(await inputCover({ name: "Notlar", bundleId: "org.example.notes" }, undefined, look)).toEqual({ key: "app:org.example.notes", app: "Notlar" });
  });

  it("keeps its card when its category is finance, under any name", async () => {
    expect(await inputCover({ name: "MyBank", bundleId: "org.example.bank" }, undefined, look)).toBeUndefined();
    expect(await inputCover({ name: "Bankam", bundleId: "org.example.bank" }, undefined, look)).toBeUndefined();
  });

  it("keeps its card when its bundle can't be found", async () => {
    expect(await inputCover({ name: "Somewhere", bundleId: "org.example.nowhere" }, undefined, look)).toBeUndefined();
  });
});
