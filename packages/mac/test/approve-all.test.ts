import { describe, expect, it } from "vitest";
import { inputCover, soundsLikeSendOrDelete } from "../src/approve-all.js";

describe("what approve all reaches in an app", () => {
  it("covers an ordinary app by its identity", async () => {
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

  it("leaves a control or key that sounds like sending or deleting to its own card", async () => {
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
