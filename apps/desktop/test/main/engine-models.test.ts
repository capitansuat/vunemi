import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelStore, projectorFile } from "../../src/main/engine/models.js";

const src = { repo: "org/m", commit: "c".repeat(40), file: "M-Q4_K_M.gguf", size: 4, sha256: "a".repeat(64), name: "M", license: "mit" };
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tenami-models-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the installed models", () => {
  it("finds a model's vision part beside it, and deletes it with the model", () => {
    const store = new ModelStore(dir);
    writeFileSync(join(dir, src.file), "gguf");
    store.add({ ...src, projector: { file: "mmproj-F16.gguf", size: 2, sha256: "b".repeat(64) } });
    const m = store.get("m-q4_k_m")!;
    expect(projectorFile(src.file)).toBe("M-Q4_K_M.mmproj.gguf");
    expect(store.projectorPathOf(m)).toBeNull(); // not downloaded yet
    writeFileSync(join(dir, "M-Q4_K_M.mmproj.gguf"), "pj");
    expect(store.projectorPathOf(m)).toBe(join(dir, "M-Q4_K_M.mmproj.gguf"));
    store.remove("m-q4_k_m");
    expect(existsSync(join(dir, "M-Q4_K_M.mmproj.gguf"))).toBe(false);
  });

  it("remembers a downloaded model and lists it while its file is there", () => {
    const store = new ModelStore(dir);
    writeFileSync(join(dir, src.file), "gguf");
    const added = store.add(src);
    expect(added.id).toBe("m-q4_k_m");
    expect(new ModelStore(dir).list().map((m) => m.id)).toEqual(["m-q4_k_m"]);
    rmSync(join(dir, src.file));
    expect(new ModelStore(dir).list()).toEqual([]);
  });

  it("records the tool test", () => {
    const store = new ModelStore(dir);
    writeFileSync(join(dir, src.file), "gguf");
    store.add(src);
    store.update("m-q4_k_m", { toolTest: "failed" });
    expect(new ModelStore(dir).get("m-q4_k_m")?.toolTest).toBe("failed");
  });

  it("deletes the file, and any half download, when a model is removed", () => {
    const store = new ModelStore(dir);
    writeFileSync(join(dir, src.file), "gguf");
    writeFileSync(join(dir, `${src.file}.part`), "gg");
    store.add(src);
    store.remove("m-q4_k_m");
    expect(existsSync(join(dir, src.file))).toBe(false);
    expect(existsSync(join(dir, `${src.file}.part`))).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("keeps a download that was cut short, to carry on later", () => {
    const store = new ModelStore(dir);
    store.setPending(src);
    writeFileSync(join(dir, `${src.file}.part`), "gg");
    const again = new ModelStore(dir);
    expect(again.pending()).toEqual(src);
    expect(again.partialBytes(src)).toBe(2);
    again.setPending(null);
    expect(new ModelStore(dir).pending()).toBeNull();
  });

  it("survives a damaged record", () => {
    writeFileSync(join(dir, "models.json"), "{not json");
    expect(new ModelStore(dir).list()).toEqual([]);
  });

  it("never lets a file name leave the folder", () => {
    const store = new ModelStore(dir);
    expect(() => store.pathOf({ ...src, file: "../escape.gguf" })).toThrow();
    expect(() => store.add({ ...src, file: "sub/x.gguf" })).toThrow();
  });
});
