import { describe, expect, it } from "vitest";
import { recoveryOwner, refusedBeforeStart } from "../../src/main/recovery-owner.js";

describe("recovery requests belong to one session", () => {
  it("accepts only the session that is open now", () => {
    expect(recoveryOwner("s_open", "s_open")).toBe("s_open");
  });

  it("refuses a request captured in another session or with no session", () => {
    for (const raw of ["s_other", undefined, null, 7, "", { id: "s_open" }]) expect(() => recoveryOwner(raw, "s_open")).toThrow();
  });
});

describe("a resume that cannot begin reaches the card", () => {
  it("throws when the run is refused before it begins", async () => {
    await expect(refusedBeforeStart(Promise.reject(new Error("cannot resume")))).rejects.toThrow("cannot resume");
  });

  it("returns while the run is going, and a later failure is only logged", async () => {
    let fail!: (e: Error) => void;
    const logged: unknown[] = [];
    await expect(refusedBeforeStart(new Promise((_r, j) => { fail = j; }), (e) => logged.push(e))).resolves.toBeUndefined();
    fail(new Error("later"));
    await new Promise((r) => setImmediate(r));
    expect(logged).toHaveLength(1);
  });
});
