import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "../../src/main/shutdown.js";

describe("closing Vunemi", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settled = async (p: Promise<void>) => {
    let done = false;
    void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    return () => done;
  };

  it("goes on as soon as the steps are done", async () => {
    const done = await settled(within(Promise.resolve("closed"), 5_000));
    expect(done()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("goes on when a step fails", async () => {
    const done = await settled(within(Promise.reject(new Error("the browser was already gone")), 5_000));
    expect(done()).toBe(true);
  });

  it("does not wait for ever for a step that never finishes", async () => {
    const done = await settled(within(new Promise(() => undefined), 5_000));
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
  });
});
