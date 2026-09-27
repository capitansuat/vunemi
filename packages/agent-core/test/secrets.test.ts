import { describe, expect, it } from "vitest";
import { maskSecrets, SECRET_MASK } from "../src/secrets.js";

describe("maskSecrets", () => {
  it("hides well-known key shapes", () => {
    // Fake keys. The prefixes are split so secret scanners don't mistake the
    // file for a leak; the joined strings are what the masker sees.
    const cases = [
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "xox" + "b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      "AIzaSyA-1234567890abcdefghijklmnopqrstu",
      "sk_" + "live_51H8abcdefghijklmnopqrstuv",
    ];
    for (const key of cases) {
      const out = maskSecrets(`the key is ${key} ok`);
      expect(out, key).toBe(`the key is ${SECRET_MASK} ok`);
    }
  });

  it("keeps the label of a bearer token or an assignment, and hides the value", () => {
    expect(maskSecrets("Authorization: Bearer abcdefghijklmnop.qrstuvwx")).toBe(`Authorization: Bearer ${SECRET_MASK}`);
    expect(maskSecrets('api_key = "a1b2c3d4e5f6g7h8"')).toBe(`api_key = "${SECRET_MASK}"`);
    expect(maskSecrets("PASSWORD: hunter2hunter2")).toBe(`PASSWORD: ${SECRET_MASK}`);
    expect(maskSecrets("token=abcdefgh12345678")).toBe(`token=${SECRET_MASK}`);
  });

  it("hides a private key block whole", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`x\n${pem}\ny`)).toBe(`x\n${SECRET_MASK}\ny`);
  });

  it("leaves ordinary text alone", () => {
    const ordinary = [
      "Password: at least 8 characters",
      "Enter your password below.",
      "The token economy of the 90s",
      "risk-free, skill-based tasks",
      "AKIA is not a key on its own",
      "Bearer bonds were popular",
    ];
    for (const text of ordinary) expect(maskSecrets(text), text).toBe(text);
  });
});
