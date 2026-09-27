/**
 * The app lock. Off by default, and when it is on the rules are few: it
 * opens only for the Mac's owner, it locks again when the Mac does, and
 * switching it either way needs the owner too — so nobody locks themselves
 * out, and nobody who merely found the window open turns it off.
 */
import { describe, expect, it } from "vitest";
import { AppLock, type AuthResult } from "../../src/main/app-lock.js";

function owner(answers: AuthResult[]) {
  const asked: string[] = [];
  const authenticate = async (reason: string): Promise<AuthResult> => {
    asked.push(reason);
    return answers.shift() ?? { ok: false, reason: "cancelled" };
  };
  return { asked, authenticate };
}

describe("AppLock", () => {
  it("stays out of the way when the user never turned it on", async () => {
    const { asked, authenticate } = owner([]);
    const lock = new AppLock(() => false, authenticate);
    expect(lock.isLocked).toBe(false);
    lock.lock();
    expect(lock.isLocked).toBe(false);
    expect(await lock.unlock("open")).toEqual({ ok: true });
    expect(asked).toEqual([]);
  });

  it("starts locked when it is on, and opens only for the owner", async () => {
    const { authenticate } = owner([{ ok: false, reason: "cancelled" }, { ok: true }]);
    const lock = new AppLock(() => true, authenticate);
    expect(lock.isLocked).toBe(true);
    expect(await lock.unlock("open")).toEqual({ ok: false, reason: "cancelled" });
    expect(lock.isLocked).toBe(true);
    expect(await lock.unlock("open")).toEqual({ ok: true });
    expect(lock.isLocked).toBe(false);
  });

  it("locks again when the Mac locks, and says so", () => {
    const lock = new AppLock(() => true, owner([{ ok: true }]).authenticate);
    const heard: boolean[] = [];
    lock.onChange((locked) => heard.push(locked));
    return lock.unlock("open").then(() => {
      lock.lock();
      expect(lock.isLocked).toBe(true);
      expect(heard).toEqual([false, true]);
    });
  });

  it("does not accept an unlock completed after the Mac locked again", async () => {
    let finish!: (result: AuthResult) => void;
    const lock = new AppLock(() => true, () => new Promise((resolve) => { finish = resolve; }));
    const unlock = lock.unlock("open");
    lock.lock();
    finish({ ok: true });
    expect(await unlock).toEqual({ ok: false, reason: "cancelled" });
    expect(lock.isLocked).toBe(true);
  });

  it("takes the dialog down when the Mac locks, and asks afresh for the new lock", async () => {
    const dialogs: { signal: AbortSignal; answer: (r: AuthResult) => void }[] = [];
    const lock = new AppLock(() => true, (_reason, signal) => new Promise((resolve) => { dialogs.push({ signal, answer: resolve }); }));
    const before = lock.unlock("open");
    lock.lock();
    expect(dialogs[0]!.signal.aborted).toBe(true);
    // A click after the Mac locked must not ride on the old dialog.
    const after = lock.unlock("open");
    dialogs[0]!.answer({ ok: true });
    expect(await before).toEqual({ ok: false, reason: "cancelled" });
    await new Promise((r) => setTimeout(r, 0));
    expect(dialogs).toHaveLength(2);
    expect(lock.isLocked).toBe(true);
    dialogs[1]!.answer({ ok: true });
    expect(await after).toEqual({ ok: true });
    expect(lock.isLocked).toBe(false);
  });

  it("asks the owner before turning it on, and before turning it off", async () => {
    let on = false;
    const { asked, authenticate } = owner([{ ok: false, reason: "failed" }, { ok: true }, { ok: true }]);
    const lock = new AppLock(() => on, authenticate);
    const save = (next: boolean) => { on = next; };

    expect((await lock.setEnabled(true, "turn on", save)).ok).toBe(false);
    expect(on).toBe(false);
    expect((await lock.setEnabled(true, "turn on", save)).ok).toBe(true);
    expect(on).toBe(true);
    // Turning it on doesn't lock the window the user is looking at.
    expect(lock.isLocked).toBe(false);
    expect((await lock.setEnabled(false, "turn off", save)).ok).toBe(true);
    expect(on).toBe(false);
    expect(asked).toEqual(["turn on", "turn on", "turn off"]);
  });

  it("does not disable the lock when the Mac locks during authentication", async () => {
    let finish!: (result: AuthResult) => void;
    let on = true;
    const lock = new AppLock(() => on, () => new Promise((resolve) => { finish = resolve; }));
    const disabling = lock.setEnabled(false, "turn off", (next) => { on = next; });
    lock.lock();
    finish({ ok: true });
    expect(await disabling).toEqual({ ok: false, reason: "cancelled" });
    expect(on).toBe(true);
    expect(lock.isLocked).toBe(true);
  });

  it("shows one system dialog even when unlock is pressed twice", async () => {
    let answer!: (r: AuthResult) => void;
    let calls = 0;
    const lock = new AppLock(() => true, () => {
      calls++;
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = lock.unlock("open");
    const second = lock.unlock("open");
    answer({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it("stays locked when macOS can't be asked at all", async () => {
    const lock = new AppLock(() => true, async () => { throw new Error("helper missing"); });
    expect(await lock.unlock("open")).toEqual({ ok: false, reason: "error", detail: "helper missing" });
    expect(lock.isLocked).toBe(true);
  });
});
