/**
 * The archive tools against the Mac's real bsdtar, inside the real add-on
 * sandbox. Every archive here is made by the test; hostile ones are written
 * byte by byte, because no well-behaved tool would make them.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileTools, Roots, type ArchiveTools } from "@vunemi/files";
import { extractArchive, listArchive, parseListing, type IsolatedRunner } from "../../../../packages/files/src/archive.js";
import { runSandboxed } from "../../src/main/addons/sandbox.js";

const mac = process.platform === "darwin" && existsSync("/usr/bin/bsdtar");

let base: string;
let home: string;
let root: string;
let archives: ArchiveTools;
let undo: (() => Promise<void>) | null;
let produced: unknown[];

const context = () => ({
  runId: "r",
  signal: new AbortController().signal,
  offerUndo: (_label: string, fn: () => Promise<void>) => void (undo = fn),
  attach: () => {},
  produced: (item: unknown) => void produced.push(item),
});

const tools = () => new Map(createFileTools({ roots: new Roots([root]), shadowDir: join(base, "shadow"), archives }).map((tool) => [tool.name, tool]));
const call = async (name: string, args: object): Promise<string> => (await tools().get(name)!.run(args as never, context() as never)) as string;

/** Everything under a folder, as "name=contents", with Turkish letters in one form. */
function tree(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const shown = `${prefix}${name}`.normalize("NFC");
      if (lstatSync(path).isDirectory()) walk(path, `${shown}/`);
      else out.push(`${shown}=${readFileSync(path, "utf8")}`);
    }
  };
  walk(folder, "");
  return out.sort();
}

/** A stored zip with whatever names and modes it is given. */
function zipOf(entries: { name: string; data: string; mode?: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const n = Buffer.from(name);
    const d = Buffer.from(data);
    const head = Buffer.alloc(26);
    head.writeUInt16LE(20, 0);
    head.writeUInt16LE(0x800, 2);
    head.writeUInt32LE(crc32(d), 10);
    head.writeUInt32LE(d.length, 14);
    head.writeUInt32LE(d.length, 18);
    head.writeUInt16LE(n.length, 22);
    const entry = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), head, n, d]);
    const row = Buffer.alloc(46);
    row.write("PK\x01\x02", 0, "latin1");
    row.writeUInt16LE(0x031e, 4);
    head.copy(row, 6, 0, 26);
    row.writeUInt32LE(((0o100000 | mode) * 0x10000) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([row, n]));
    local.push(entry);
    offset += entry.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06", 0, "latin1");
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

/** A RAR4 holding one stored file: enough to prove the format is read. */
function storedRar(name: string, data: string): Buffer {
  const n = Buffer.from(name);
  const d = Buffer.from(data);
  const block = (body: Buffer) => {
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc32(body) & 0xffff);
    return Buffer.concat([crc, body]);
  };
  const main = Buffer.alloc(11);
  main.writeUInt8(0x73, 0);
  main.writeUInt16LE(13, 3);
  const file = Buffer.alloc(30);
  file.writeUInt8(0x74, 0);
  file.writeUInt16LE(0x8000, 1);
  file.writeUInt16LE(32 + n.length, 3);
  file.writeUInt32LE(d.length, 5);
  file.writeUInt32LE(d.length, 9);
  file.writeUInt8(3, 13);
  file.writeUInt32LE(crc32(d), 14);
  file.writeUInt32LE(0x5b3f0000, 18);
  file.writeUInt8(29, 22);
  file.writeUInt8(0x30, 23);
  file.writeUInt16LE(n.length, 24);
  file.writeUInt32LE(0o100644, 26);
  const end = Buffer.alloc(5);
  end.writeUInt8(0x7b, 0);
  end.writeUInt16LE(0x4000, 1);
  end.writeUInt16LE(7, 3);
  return Buffer.concat([Buffer.from("Rar!\x1a\x07\x00", "latin1"), block(main), block(Buffer.concat([file, n])), d, block(end)]);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-archive-")));
  home = join(base, "home");
  root = join(home, "Çalışma");
  mkdirSync(join(home, ".Trash"), { recursive: true });
  mkdirSync(root);
  vi.stubEnv("HOME", home);
  undo = null;
  produced = [];
  archives = {
    workDir: join(base, "jobs"),
    run: (program, args, run) => runSandboxed(program, args, { ...run, home, engineDir: "/usr/bin" }),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  execFileSync("/bin/chmod", ["-R", "u+rwX", base]);
  rmSync(base, { recursive: true, force: true });
});

describe("reading what bsdtar lists", () => {
  it("counts files and sizes, and survives an owner name it cannot parse", () => {
    const listing = parseListing("drwxr-xr-x  0 0 0 0 Jan  1  2020 a/\n-rw-r--r--  0 0 0 200 Jan  1  2020 a/b c.txt\n-rw-r--r--  0 Some One Two 1 Jan  1  2020 odd\n");
    expect(listing).toEqual({ names: ["a/", "a/b c.txt"], files: 2, bytes: 200 });
  });
});

describe.runIf(mac)("making and opening archives", () => {
  beforeEach(() => {
    mkdirSync(join(root, "Yedek", "alt klasör"), { recursive: true });
    writeFileSync(join(root, "Yedek", "şğü dosya.txt"), "deneme");
    writeFileSync(join(root, "Yedek", "alt klasör", "b.txt"), "ikinci");
  });

  it.each(["zip", "7z", "tar", "tar.gz", "tar.bz2", "tar.xz", "tgz"])("round-trips a Turkish-named folder through .%s", async (kind) => {
    const made = join(root, `y.${kind}`);
    await call("files_compress", { paths: [join(root, "Yedek")], out: made });
    expect(statSync(made).size).toBeGreaterThan(0);
    await call("files_extract", { path: made, out: join(root, "açılan") });
    // One folder inside opens as that folder.
    expect(tree(join(root, "açılan"))).toEqual(tree(join(root, "Yedek")));
    expect(readdirSync(join(base, "jobs"))).toEqual([]);
  });

  it("marks zip names as UTF-8, so Windows reads the Turkish letters", async () => {
    const made = join(root, "y.zip");
    await call("files_compress", { paths: [join(root, "Yedek")], out: made });
    const bytes = readFileSync(made);
    // The central directory, entry by entry: plain-ASCII names need no mark.
    const marks = new Map<string, number>();
    for (let at = bytes.indexOf("PK\x01\x02", 0, "latin1"); at >= 0; at = bytes.indexOf("PK\x01\x02", at + 1, "latin1")) {
      const length = bytes.readUInt16LE(at + 28);
      marks.set(bytes.subarray(at + 46, at + 46 + length).toString("utf8").normalize("NFC"), bytes.readUInt16LE(at + 8) & 0x800);
    }
    expect(marks.get("Yedek/şğü dosya.txt")).toBe(0x800);
    expect(marks.get("Yedek/alt klasör/b.txt")).toBe(0x800);
  });

  it("leaves the account name out of a tar", async () => {
    const made = join(root, "y.tar.gz");
    await call("files_compress", { paths: [join(root, "Yedek")], out: made });
    const listed = execFileSync("/usr/bin/bsdtar", ["-tvf", made], { encoding: "utf8" });
    expect(listed).not.toContain(process.env.USER ?? "\0");
  });

  it("stores a link as a link, and never takes in what it points to", async () => {
    writeFileSync(join(home, "gizli.txt"), "ÇOK GİZLİ");
    symlinkSync(join(home, "gizli.txt"), join(root, "Yedek", "bağ"));
    const made = join(root, "y.tar");
    await call("files_compress", { paths: [join(root, "Yedek")], out: made });
    expect(readFileSync(made).includes("ÇOK GİZLİ")).toBe(false);
  });

  it("never replaces a file: a taken name gets a new one, and undo sends it to the Trash", async () => {
    writeFileSync(join(root, "y.zip"), "eski");
    const answer = await call("files_compress", { paths: [join(root, "Yedek")], out: join(root, "y.zip") });
    expect(readFileSync(join(root, "y.zip"), "utf8")).toBe("eski");
    expect(existsSync(join(root, "y 2.zip"))).toBe(true);
    expect(answer).toContain("y 2.zip");
    await undo!();
    expect(existsSync(join(root, "y 2.zip"))).toBe(false);
    expect(readdirSync(join(home, ".Trash"))).toEqual(["y 2.zip"]);
  });

  it("names the archive after what it holds, beside it", async () => {
    await call("files_compress", { paths: [join(root, "Yedek")] });
    expect(existsSync(join(root, "Yedek.zip"))).toBe(true);
    expect(produced).toEqual([{ kind: "file", path: join(root, "Yedek.zip") }]);
  });

  it("refuses a kind it cannot make, and a path outside the open folders", async () => {
    const tool = tools().get("files_compress")!;
    expect(await tool.check!({ paths: [join(root, "Yedek")], out: join(root, "y.rar") } as never, {} as never)).toMatch(/\.zip/);
    expect(await tool.check!({ paths: [join(home, "gizli.txt")] } as never, {} as never)).toBeTruthy();
  });

  it("is a request the user approves, and only exists when it can be sandboxed", () => {
    expect(tools().get("files_extract")!.actionClass).toBe("write-local");
    expect(tools().get("files_compress")!.actionClass).toBe("write-local");
    const plain = createFileTools({ roots: new Roots([root]), shadowDir: join(base, "shadow") }).map((tool) => tool.name);
    expect(plain).not.toContain("files_extract");
  });
});

describe.runIf(mac)("opening someone else's archive", () => {
  const put = (name: string, bytes: Buffer) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };

  it("opens beside the archive by default, and never over what is there", async () => {
    const zip = put("rapor.zip", zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]));
    mkdirSync(join(root, "rapor"));
    writeFileSync(join(root, "rapor", "önemli.txt"), "kalsın");
    await call("files_extract", { path: zip });
    expect(tree(join(root, "rapor"))).toEqual(["önemli.txt=kalsın"]);
    expect(tree(join(root, "rapor 2"))).toEqual(["a.txt=bir", "b.txt=iki"]);
    await undo!();
    expect(existsSync(join(root, "rapor 2"))).toBe(false);
    expect(readdirSync(join(home, ".Trash"))).toEqual(["rapor 2"]);
  });

  it("makes a new folder inside a folder that exists", async () => {
    const zip = put("rapor.zip", zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]));
    mkdirSync(join(root, "Hedef"));
    await call("files_extract", { path: zip, out: join(root, "Hedef") });
    expect(tree(join(root, "Hedef"))).toEqual(["rapor/a.txt=bir", "rapor/b.txt=iki"]);
  });

  it("keeps nothing when an entry tries to leave", async () => {
    const zip = put("kaçış.zip", zipOf([{ name: "ok.txt", data: "ok" }, { name: "../kaçtı.txt", data: "x" }]));
    await expect(call("files_extract", { path: zip })).rejects.toThrow();
    expect(existsSync(join(root, "kaçtı.txt"))).toBe(false);
    expect(existsSync(join(root, "kaçış"))).toBe(false);
    expect(readdirSync(join(base, "jobs"))).toEqual([]);
  });

  it("puts an absolute name inside the new folder, not at that path", async () => {
    const outside = join(base, "mutlak.txt");
    const zip = put("mutlak.zip", zipOf([{ name: outside, data: "x" }, { name: "ok.txt", data: "ok" }]));
    await call("files_extract", { path: zip });
    expect(existsSync(outside)).toBe(false);
  });

  it("keeps nothing from a password-protected zip, and does not ask for a password", async () => {
    writeFileSync(join(root, "gizli.txt"), "içerik");
    execFileSync("/usr/bin/zip", ["-q", "-P", "deneme123", "kilitli.zip", "gizli.txt"], { cwd: root });
    await expect(call("files_extract", { path: join(root, "kilitli.zip") })).rejects.toThrow(/kilitli\.zip/);
    expect(existsSync(join(root, "kilitli"))).toBe(false);
  });

  it("keeps nothing from a damaged archive", async () => {
    const zip = zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]);
    const path = put("bozuk.zip", zip);
    const damaged = Buffer.from(zip);
    damaged[35] = damaged[35]! ^ 0xff;
    writeFileSync(path, damaged);
    await expect(call("files_extract", { path })).rejects.toThrow(/bozuk\.zip/);
    expect(existsSync(join(root, "bozuk"))).toBe(false);
  });

  it("repairs what an archive could set: unreadable files stay readable", async () => {
    const zip = put("izin.zip", zipOf([{ name: "kilit.txt", data: "okunur", mode: 0 }, { name: "b.txt", data: "iki" }]));
    await call("files_extract", { path: zip });
    expect(readFileSync(join(root, "izin", "kilit.txt"), "utf8")).toBe("okunur");
  });

  it("leaves out a link that leads away, and keeps one that stays inside", async () => {
    const source = join(base, "linked");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "bir");
    symlinkSync(join(home, "gizli.txt"), join(source, "dışarı"));
    symlinkSync("../../../gizli.txt", join(source, "yukarı"));
    symlinkSync("a.txt", join(source, "içeri"));
    execFileSync("/usr/bin/bsdtar", ["-cf", join(root, "bağlar.tar"), "-C", source, "."]);
    const answer = await call("files_extract", { path: join(root, "bağlar.tar") });
    expect(answer).toContain("2 link");
    expect(readdirSync(join(root, "bağlar")).map((name) => name.normalize("NFC")).sort()).toEqual(["a.txt", "içeri"].sort());
    expect(readlinkSync(join(root, "bağlar", "içeri"))).toBe("a.txt");
  });

  it("carries the mark that makes macOS warn before opening a downloaded app", async () => {
    const zip = put("indirilen.zip", zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]));
    const mark = "0081;00000000;Test;";
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", mark, zip]);
    await call("files_extract", { path: zip });
    expect(execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", join(root, "indirilen", "a.txt")], { encoding: "utf8" }).trim()).toBe(mark);
  });

  it("opens a RAR, and tells the model not to call it verified", async () => {
    const rar = put("eski.rar", storedRar("r.txt", "rar içeriği"));
    const answer = await call("files_extract", { path: rar });
    expect(tree(join(root, "eski"))).toEqual(["r.txt=rar içeriği"]);
    expect(answer).toMatch(/verified/);
  });

  it("refuses a split RAR by its name, and a kind it does not open", async () => {
    const tool = tools().get("files_extract")!;
    const part = put("film.part1.rar", storedRar("r.txt", "x"));
    expect(await tool.check!({ path: part } as never, {} as never)).toMatch(/film\.part1\.rar/);
    expect(await tool.check!({ path: put("kur.pkg", Buffer.from("x")) } as never, {} as never)).toMatch(/kur\.pkg/);
    await expect(call("files_extract", { path: part })).rejects.toThrow(/film\.part1\.rar/);
    expect(existsSync(join(root, "film.part1"))).toBe(false);
  });

  it("files_read lists an archive without opening it, and shows the size on the card", async () => {
    const zip = put("rapor.zip", zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]));
    const answer = await call("files_read", { path: zip });
    expect(answer).toContain("2 files");
    expect(answer).toContain("a.txt");
    expect(existsSync(join(root, "rapor"))).toBe(false);
    expect(await tools().get("files_extract")!.preview!({ path: zip } as never)).toMatch(/→/);
  });

  it("stops when more comes out than the archive claimed", async () => {
    const zip = put("bomba.zip", zipOf([{ name: "a.bin", data: "x".repeat(4096) }, { name: "b.txt", data: "iki" }]));
    await expect(extractArchive(archives, zip, join(root, "bomba"), { capBytes: 100 })).rejects.toThrow(/bomba\.zip/);
    expect(existsSync(join(root, "bomba"))).toBe(false);
  });

  it("stops a run that keeps writing, while it is writing", async () => {
    const zip = put("uzun.zip", zipOf([{ name: "a.txt", data: "bir" }, { name: "b.txt", data: "iki" }]));
    let stopped = false;
    const endless: IsolatedRunner = async (program, args, run) => {
      if (args[0] === "-tvf") return archives.run(program, args, run);
      writeFileSync(join(run.job, "fazla.bin"), Buffer.alloc(32 * 1024 * 1024, 7));
      await new Promise<void>((_, reject) => run.signal!.addEventListener("abort", () => {
        stopped = true;
        reject(new Error("aborted"));
      }));
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(extractArchive({ ...archives, run: endless }, zip, join(root, "uzun"), { capBytes: 1024, watchMs: 5 })).rejects.toThrow(/uzun\.zip/);
    expect(stopped).toBe(true);
    expect(existsSync(join(root, "uzun"))).toBe(false);
  });

  it("clears a job a crash left behind, but not a recent one", async () => {
    const zip = put("rapor.zip", zipOf([{ name: "a.txt", data: "bir" }]));
    const stale = join(base, "jobs", "job-eski");
    const recent = join(base, "jobs", "job-yeni");
    mkdirSync(stale, { recursive: true });
    mkdirSync(recent);
    utimesSync(stale, new Date(0), new Date(0));
    await listArchive(archives, zip);
    expect(readdirSync(join(base, "jobs"))).toEqual(["job-yeni"]);
  });

  it("the sandbox holds: bsdtar cannot read another file or write beside the archive", async () => {
    const zip = put("rapor.zip", zipOf([{ name: "a.txt", data: "bir" }]));
    const job = join(base, "jobs", "elle");
    mkdirSync(job, { recursive: true });
    const secret = put("başka.zip", zipOf([{ name: "x.txt", data: "x" }]));
    expect((await archives.run("/usr/bin/bsdtar", ["-tf", secret], { job, reads: [zip] })).code).not.toBe(0);
    expect((await archives.run("/usr/bin/bsdtar", ["-xf", zip, "-C", root], { job, reads: [zip] })).code).not.toBe(0);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    chmodSync(job, 0o700);
  });
});

/**
 * Real RARs, from libarchive's own test folder, decoded into one folder. They
 * are not kept in this repository; set VUNEMI_RAR_SAMPLES to run these.
 */
const samples = process.env.VUNEMI_RAR_SAMPLES;
describe.runIf(mac && samples)("real RAR files", () => {
  const open = async (name: string) => {
    copyFileSync(join(samples!, name), join(root, name));
    return call("files_extract", { path: join(root, name) });
  };
  const stem = (name: string) => join(root, name.replace(/\.rar$/, ""));

  it.each([["rar_compress_normal.rar", 3], ["rar5_compressed.rar", 1], ["rar5_solid.rar", 7]])("opens %s", async (name, files) => {
    expect(await open(name as string)).toContain(`${files} files`);
    expect(existsSync(stem(name as string))).toBe(true);
  });

  it.each(["rar4_encrypted.rar", "rar5_encrypted.rar", "rar4_encrypted_filenames.rar", "rar5_encrypted_filenames.rar"])("keeps nothing from the password-protected %s", async (name) => {
    await expect(open(name)).rejects.toThrow(/açılamadı|couldn't be opened/);
    expect(existsSync(stem(name))).toBe(false);
  });

  it("keeps nothing from the first part of a split RAR given another name", async () => {
    copyFileSync(join(samples!, "test_rar_multivolume_single_file.part1.rar"), join(root, "film.rar"));
    await expect(call("files_extract", { path: join(root, "film.rar") })).rejects.toThrow(/film\.rar/);
    expect(existsSync(join(root, "film"))).toBe(false);
  });
});
