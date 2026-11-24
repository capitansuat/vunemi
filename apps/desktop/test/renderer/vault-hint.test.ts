/** The locked vault's hint names the system that keeps the key. */
import { expect, it } from "vitest";
import { lockedHint } from "../../src/renderer/src/components/VaultView.js";

it("uses the keyring wording off macOS, so Windows doesn't speak of macOS", () => {
  expect(lockedHint("win32")).toBe("linux.vault.unlockHint");
  expect(lockedHint("linux")).toBe("linux.vault.unlockHint");
  expect(lockedHint("darwin")).toBe("vault.unlockHint");
  // Not known yet: as macOS always was.
  expect(lockedHint(undefined)).toBe("vault.unlockHint");
});
