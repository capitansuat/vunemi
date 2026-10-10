/**
 * Talking in voice chat: where a reply being written is cut into things to
 * say, and that they are said in order, one at a time, until told to stop.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { SentenceCutter, SpeechPlayer, type Playing } from "../../src/renderer/src/lib/speech.js";

/** A reply as a model writes it: a few characters at a time. */
const written = (text: string, by = 3): string[] => {
  const cutter = new SentenceCutter();
  const out: string[] = [];
  for (let at = 0; at < text.length; at += by) out.push(...cutter.push(text.slice(at, at + by)));
  return [...out, ...cutter.flush()];
};

describe("SentenceCutter", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  it("gives a sentence as soon as the next one begins, not when the reply ends", () => {
    const cutter = new SentenceCutter();
    expect(cutter.push("Bugün üç toplantın var")).toEqual([]);
    expect(cutter.push(". İlki saat on")).toEqual(["Bugün üç toplantın var."]);
    expect(cutter.push("da! Sonra")).toEqual(["İlki saat onda!"]);
    expect(cutter.flush()).toEqual(["Sonra."]);
  });

  it("cuts the same however the reply is chopped up on its way", () => {
    const text = "First things first. Is it raining? Then take an umbrella with you.\n\nThat is all for today.";
    const whole = written(text, text.length);
    expect(whole).toEqual(["First things first.", "Is it raining?", "Then take an umbrella with you.", "That is all for today."]);
    for (const by of [1, 2, 5, 17]) expect(written(text, by), `by ${by}`).toEqual(whole);
  });

  it("says a short sentence together with the next one", () => {
    expect(written("Evet. Yarın sabah dokuzda başlıyor.")).toEqual(["Evet. Yarın sabah dokuzda başlıyor."]);
    expect(written("Tamam.")).toEqual(["Tamam."]);
  });

  it("ends a sentence at the end of a line: headings and list items carry no full stop", () => {
    expect(written("## Alışveriş listesi\n- Süt ve ekmek\n- **Yumurta**, bir düzine\n")).toEqual(["Alışveriş listesi.", "Süt ve ekmek.", "Yumurta, bir düzine."]);
    expect(written("1. Open the settings page\n2. Choose a model there\n")).toEqual(["1. Open the settings page.", "2. Choose a model there."]);
  });

  it("does not stop at a number, an address or a version", () => {
    expect(written("It costs 3.50 euros at example.com today. Version 2.1 is out.")).toEqual(["It costs 3.50 euros at example.com today.", "Version 2.1 is out."]);
  });

  it("names a code block and does not read it", () => {
    expect(written("Run this command:\n```bash\nrm -rf node_modules && pnpm install\n```\nThen start it again.")).toEqual(["Run this command:", "code block. Then start it again."]);
    // Still open when the reply ends: none of it is read.
    expect(written("Here it is:\n```js\nconst a = 1;")).toEqual(["Here it is: code block."]);
  });

  it("takes the marks out, and says an address by its site", () => {
    expect(written("See [the **docs**](https://example.com/a/b?c=d) or https://www.vunemi.app/help/voice#top for `more` details.")).toEqual(["See the docs or vunemi.app for more details."]);
    expect(written("| Day | Time |\n|---|---|\n| Monday | at nine |\n")).toEqual(["Day Time. Monday at nine."]);
    expect(written("---\n***\n")).toEqual([]);
  });

  it("cuts where a full-width mark ends a sentence, with no space after it", () => {
    expect(written("今日は会議が三つあります。最初の会議は十時に始まります。")).toEqual(["今日は会議が三つあります。", "最初の会議は十時に始まります。"]);
  });
});

describe("SpeechPlayer", () => {
  /** Clips that end when the test says so. */
  const stage = () => {
    const played: string[] = [];
    const asked: string[] = [];
    let end: (() => void) | null = null;
    let stopped = 0;
    const player = new SpeechPlayer({
      synthesize: async (text) => {
        asked.push(text);
        if (text === "broken") throw new Error("say");
        return new TextEncoder().encode(text).buffer as ArrayBuffer;
      },
      play: (wav): Playing => {
        played.push(new TextDecoder().decode(wav));
        let finish!: () => void;
        const done = new Promise<void>((resolve) => (finish = resolve));
        end = finish;
        return { done, stop: () => { stopped += 1; finish(); } };
      },
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { player, played, asked, tick, endClip: () => end?.(), stopped: () => stopped };
  };

  it("says them in order, one at a time, and has each made as soon as it is known", async () => {
    const s = stage();
    s.player.say("one");
    s.player.say("two");
    s.player.say("three");
    await s.tick();
    expect(s.asked).toEqual(["one", "two", "three"]);
    expect(s.played).toEqual(["one"]);
    s.endClip();
    await s.tick();
    expect(s.played).toEqual(["one", "two"]);
    let over = false;
    void s.player.finished().then(() => (over = true));
    s.endClip();
    await s.tick();
    expect(over).toBe(false);
    s.endClip();
    await s.tick();
    expect(s.played).toEqual(["one", "two", "three"]);
    expect(over).toBe(true);
  });

  it("skips a sentence that could not be made, and says the ones after it", async () => {
    const s = stage();
    s.player.say("broken");
    s.player.say("after");
    await s.tick();
    expect(s.played).toEqual(["after"]);
  });

  it("is quiet at once when stopped, and says nothing of what was waiting", async () => {
    const s = stage();
    s.player.say("one");
    s.player.say("two");
    await s.tick();
    let over = false;
    void s.player.finished().then(() => (over = true));
    s.player.stop();
    await s.tick();
    expect(s.stopped()).toBe(1);
    expect(over).toBe(true);
    expect(s.played).toEqual(["one"]);
    // And talks again when there is something new to say.
    s.player.say("new");
    await s.tick();
    expect(s.played).toEqual(["one", "new"]);
  });

  it("has nothing to wait for when nothing was said", async () => {
    await expect(stage().player.finished()).resolves.toBeUndefined();
  });
});
