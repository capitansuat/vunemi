import { describe, expect, it, vi } from "vitest";
import { MailNotSent, Outbox, type Draft, type MailAccount, type StoredSend } from "../src/index.js";

const draft: Draft = { to: ["b@example.com"], subject: "Test", body: "Test" };
const account = (send: MailAccount["send"] = async () => {}): MailAccount => ({
  label: "a@example.com",
  ready: async () => true,
  search: async () => [],
  read: async () => { throw new Error("unused"); },
  saveDraft: async () => ({ id: "draft" }),
  send,
});

function storage() {
  let records: StoredSend[] = [];
  return {
    load: () => structuredClone(records),
    save: (next: StoredSend[]) => { records = structuredClone(next); },
    get records() { return records; },
  };
}

describe("outbox in-flight state", () => {
  it("keeps the account busy and settle waits until an SMTP send finishes", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sendFinished = new Promise<void>((resolve) => { finish = resolve; });
    const mailbox = account(async () => sendFinished);
    const outbox = new Outbox(45_000);
    const events: string[] = [];
    outbox.on((event) => events.push(event.kind));
    await outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);

    // Closing the app must not bypass the undo window.
    await outbox.settle();
    expect(outbox.pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45_000);
    const settling = outbox.settle();
    expect(outbox.pending).toHaveLength(0);
    expect(outbox.busy).toBe(true);
    expect(outbox.hasWorkFor(mailbox.label)).toBe(true);
    expect(events).toEqual(["held", "sending"]);
    finish();
    await settling;
    vi.useRealTimers();
    expect(outbox.busy).toBe(false);
    expect(outbox.hasWorkFor(mailbox.label)).toBe(false);
    expect(events).toEqual(["held", "sending", "sent"]);
  });

  it("waits for a second SMTP send that starts during shutdown", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      const first = account(async () => new Promise<void>((resolve) => { finishFirst = resolve; }));
      const second = account(async () => new Promise<void>((resolve) => { finishSecond = resolve; }));
      const outbox = new Outbox(100);
      await outbox.hold({ id: "first", label: "first@example.com", account: first }, draft);
      await vi.advanceTimersByTimeAsync(100);
      const settling = outbox.settle();
      await outbox.hold({ id: "second", label: "second@example.com", account: second }, draft);
      await vi.advanceTimersByTimeAsync(100);
      finishFirst();
      await Promise.resolve();
      expect(outbox.busy).toBe(true);
      finishSecond();
      await settling;
      expect(outbox.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists an approved send before accepting it and restores the undo window", async () => {
    const disk = storage();
    const first = new Outbox(45_000, disk);
    await first.restore(() => undefined);
    const mailbox = account();
    const held = await first.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
    expect(disk.records).toMatchObject([{ id: held.id, accountId: "a", state: "held" }]);
    const reopened = new Outbox(45_000, disk);
    await reopened.restore((id) => id === "a" ? mailbox : undefined);
    expect(reopened.pending).toHaveLength(1);
    expect(await reopened.cancel(held.id)).toBe(true);
    expect(disk.records).toEqual([]);
    await first.cancel(held.id);
  });

  it("does not retry a send interrupted after SMTP began", async () => {
    const disk = storage();
    disk.save([{ id: "m-1", accountId: "a", account: "a@example.com", draft, at: Date.now() - 1000, state: "sending" }]);
    const send = vi.fn(async () => {});
    const reopened = new Outbox(45_000, disk);
    const errors: string[] = [];
    reopened.on((event) => { if (event.kind === "failed") errors.push(event.error); });
    await reopened.restore(() => account(send));
    expect(reopened.pending).toEqual([]);
    expect(errors[0]).toMatch(/Gönderim durumu bilinmiyor/);
    expect(disk.records[0]?.state).toBe("uncertain");
    expect(send).not.toHaveBeenCalled();
    expect(reopened.uncertain).toMatchObject([{ id: "m-1", subject: "Test" }]);
    expect(await reopened.dismiss("m-1")).toBe(true);
    expect(disk.records).toEqual([]);
  });

  it("clears a send the server refused before taking it and says it can be sent again", async () => {
    vi.useFakeTimers();
    try {
      const disk = storage();
      const send = vi.fn(async () => { throw new MailNotSent("535 Bad credentials"); });
      const mailbox = account(send);
      const outbox = new Outbox(100, disk);
      await outbox.restore(() => mailbox);
      const events: { kind: string; error?: string }[] = [];
      outbox.on((event) => events.push(event));
      await outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
      await vi.advanceTimersByTimeAsync(100);
      expect(events.map((event) => event.kind)).toEqual(["held", "sending", "failed"]);
      expect(events[2]!.error).toContain("535 Bad credentials");
      expect(disk.records).toEqual([]);
      expect(outbox.uncertain).toEqual([]);
      const reopened = new Outbox(100, disk);
      await reopened.restore(() => mailbox);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a refused send uncertain when its record can't be cleared", async () => {
    vi.useFakeTimers();
    try {
      const disk = storage();
      let failWrites = false;
      const flaky = {
        load: disk.load,
        save: (next: StoredSend[]) => { if (failWrites && next.length === 0) throw new Error("disk full"); disk.save(next); },
      };
      const mailbox = account(async () => { failWrites = true; throw new MailNotSent("refused"); });
      const outbox = new Outbox(100, flaky);
      await outbox.restore(() => mailbox);
      await outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
      await vi.advanceTimersByTimeAsync(100);
      expect(disk.records).toMatchObject([{ state: "uncertain" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a partial SMTP delivery uncertain across restart without retrying", async () => {
    vi.useFakeTimers();
    try {
      const disk = storage();
      const send = vi.fn(async () => { throw new Error("a@example.com accepted; b@example.com rejected"); });
      const mailbox = account(send);
      const first = new Outbox(100, disk);
      await first.restore(() => mailbox);
      const events: string[] = [];
      first.on((event) => events.push(event.kind));
      await first.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual(["held", "sending", "failed"]);
      expect(disk.records).toMatchObject([{ state: "uncertain" }]);
      const reopened = new Outbox(100, disk);
      await reopened.restore(() => mailbox);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(reopened.uncertain).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a new send when its encrypted queue cannot be saved", async () => {
    const send = vi.fn(async () => {});
    const outbox = new Outbox(45_000, {
      load: () => [],
      save: () => { throw new Error("Kasa kullanılamıyor"); },
    });
    await outbox.restore(() => undefined);
    await expect(outbox.hold({ id: "a", label: "a@example.com", account: account(send) }, draft)).rejects.toThrow(/Kasa kullanılamıyor/);
    expect(outbox.pending).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a malformed stored queue from being overwritten", async () => {
    const outbox = new Outbox(45_000, {
      load: () => [{ id: "broken" } as StoredSend],
      save: () => { throw new Error("must not write"); },
    });
    await expect(outbox.restore(() => account())).rejects.toThrow(/kuyruğu geçersiz/);
    await expect(outbox.hold({ id: "a", label: "a@example.com", account: account() }, draft)).rejects.toThrow(/henüz yüklenmedi/);
  });

  it("does not activate restored sends if their updated deadline cannot be saved", async () => {
    const outbox = new Outbox(45_000, {
      load: () => [{ id: "m-1", accountId: "a", account: "a@example.com", draft, at: Date.now() - 1, state: "held" }],
      save: () => { throw new Error("disk full"); },
    });
    await expect(outbox.restore(() => account())).rejects.toThrow(/disk full/);
    expect(outbox.pending).toEqual([]);
    await expect(outbox.hold({ id: "a", label: "a@example.com", account: account() }, draft)).rejects.toThrow(/henüz yüklenmedi/);
  });

  it("with a slow async queue, a send starts only after its marker is written, and a late take-back is refused", async () => {
    vi.useFakeTimers();
    try {
      const disk = storage();
      let release!: () => void;
      let slow = false;
      const gated = {
        load: async () => disk.load(),
        save: async (next: StoredSend[]) => {
          if (slow) await new Promise<void>((resolve) => { release = resolve; });
          disk.save(next);
        },
      };
      const send = vi.fn(async () => {});
      const mailbox = account(send);
      const outbox = new Outbox(100, gated);
      await outbox.restore(() => mailbox);
      const held = await outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
      slow = true;
      await vi.advanceTimersByTimeAsync(100);
      // The "sending" marker is still being written: nothing has gone yet.
      expect(send).not.toHaveBeenCalled();
      expect(outbox.busy).toBe(true);
      expect(await outbox.cancel(held.id)).toBe(false);
      slow = false;
      release();
      await outbox.settle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(disk.records).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a message again when its take-back can't be written, and it doesn't go meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const disk = storage();
      let failRemoval = false;
      const flaky = {
        load: async () => disk.load(),
        save: async (next: StoredSend[]) => {
          if (failRemoval && next.length === 0) throw new Error("vault gone");
          disk.save(next);
        },
      };
      const send = vi.fn(async () => {});
      const mailbox = account(send);
      const outbox = new Outbox(1_000, flaky);
      await outbox.restore(() => mailbox);
      const held = await outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft);
      failRemoval = true;
      await expect(outbox.cancel(held.id)).rejects.toThrow(/vault gone/);
      expect(outbox.pending).toHaveLength(1);
      expect(disk.records).toHaveLength(1);
      failRemoval = false;
      expect(await outbox.cancel(held.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).not.toHaveBeenCalled();
      expect(disk.records).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes concurrent changes one after another, none lost", async () => {
    const disk = storage();
    const queue = {
      load: async () => disk.load(),
      save: async (next: StoredSend[]) => { await new Promise((resolve) => setTimeout(resolve, 5)); disk.save(next); },
    };
    const mailbox = account();
    const outbox = new Outbox(60_000, queue);
    await outbox.restore(() => mailbox);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => outbox.hold({ id: "a", label: mailbox.label, account: mailbox }, draft)));
    expect(disk.records.map((item) => item.id).sort()).toEqual([a!.id, b!.id, c!.id].sort());
    await Promise.all([outbox.cancel(a!.id), outbox.cancel(c!.id)]);
    expect(disk.records.map((item) => item.id)).toEqual([b!.id]);
    await outbox.cancel(b!.id);
  });
});
