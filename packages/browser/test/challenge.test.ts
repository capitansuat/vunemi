import type { AXNode } from "@vunemi/perception";
import { describe, expect, it } from "vitest";
import { detectChallenge } from "../src/challenge.js";

const node = (name: string, role = "StaticText"): AXNode => ({
  nodeId: name,
  ignored: false,
  role: { value: role },
  name: { value: name },
});

describe("detectChallenge", () => {
  it("recognises Google's unusual-traffic page by URL", () => {
    expect(detectChallenge("https://www.google.com/sorry/index?continue=x", [])).toMatch(/Google/);
    expect(detectChallenge("https://www.google.com.tr/sorry/index", [])).toMatch(/Google/);
  });

  it("recognises Cloudflare interstitials", () => {
    expect(detectChallenge("https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate", [])).toMatch(/Cloudflare/);
    expect(detectChallenge("https://shop.example/", [node("Verify you are human by completing the action below.")])).toBe(
      "human verification",
    );
  });

  it("recognises CAPTCHA text in English and Turkish", () => {
    expect(detectChallenge("https://a.example/", [node("I'm not a robot", "checkbox")])).toBe("CAPTCHA");
    expect(detectChallenge("https://a.example/", [node("Ben robot değilim", "checkbox")])).toBe("CAPTCHA");
    expect(
      detectChallenge("https://a.example/", [node("Our systems have detected unusual traffic from your computer network.")]),
    ).toMatch(/unusual/);
  });

  it("ignores an invisible reCAPTCHA badge on an ordinary page", () => {
    expect(detectChallenge("https://a.example/login", [node("reCAPTCHA", "Iframe"), node("Sign in", "button")])).toBeNull();
  });

  it("ignores ignored nodes and ordinary pages", () => {
    expect(detectChallenge("https://a.example/", [{ ...node("I'm not a robot"), ignored: true }])).toBeNull();
    expect(detectChallenge("https://news.ycombinator.com/", [node("Hacker News", "link")])).toBeNull();
  });

  // Observed on hepsiburada.com behind a VPN: the site answers with a page
  // titled "Güvenlik" and nothing else at all. Without this the agent is
  // handed a blank page and no reason for it.
  it("recognises a wall that renders nothing but its title", () => {
    expect(detectChallenge("https://www.hepsiburada.com/ara?q=kulaklik", [node("Hepsiburada | Güvenlik", "RootWebArea")])).toBe(
      "bot protection",
    );
    expect(detectChallenge("https://a.example/", [node("Access Denied", "RootWebArea")])).toBe("bot protection");
    expect(detectChallenge("https://a.example/", [node("Just a moment…", "RootWebArea")])).toBe("bot protection");
  });

  it("does not call an ordinary page a wall because of its title", () => {
    // A real page that happens to say "Güvenlik" — it has content, so it loaded.
    expect(
      detectChallenge("https://bank.example/", [
        node("Güvenlik Merkezi", "RootWebArea"),
        node("Giriş yap", "button"),
        node("Hesabım", "link"),
        node("Kartlarım", "link"),
        node("Şifremi unuttum", "link"),
      ]),
    ).toBeNull();
  });

  it("leaves a blank page alone when nothing says wall", () => {
    // A page still loading is not a bot check, and must not stop the agent.
    expect(detectChallenge("https://a.example/", [node("Ürünler", "RootWebArea")])).toBeNull();
    expect(detectChallenge("https://a.example/", [])).toBeNull();
  });
});
