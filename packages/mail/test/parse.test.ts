import { describe, expect, it } from "vitest";
import { htmlToText, parseMessageSource } from "../src/parse.js";

describe("reading a raw message", () => {
  it("turns HTML-only mail into readable text", () => {
    expect(htmlToText("<style>p{}</style><p>Hello&nbsp;<b>there</b></p><p>Bye &amp; thanks &#39;x&#x27;</p>")).toBe("Hello there\nBye & thanks 'x'");
  });

  it("keeps the plain-text part when there is one", async () => {
    const source = ["From: a@example.com", "To: b@example.com", "Subject: s", "Content-Type: text/plain; charset=utf-8", "", "Plain words", ""].join("\r\n");
    expect((await parseMessageSource(source)).text.trim()).toBe("Plain words");
  });
});
