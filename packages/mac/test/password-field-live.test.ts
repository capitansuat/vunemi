/**
 * The installed helper against a real password field in a small test app:
 * nothing reaches it, while a plain field in the same app still takes text.
 * Takes the foreground for a few seconds, so it only runs when asked for.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Helper } from "../src/helper.js";

const FIXTURE = `
import AppKit
let args = CommandLine.arguments
let log = args[2]
final class Watch: NSObject, NSTextFieldDelegate {
  func controlTextDidChange(_ n: Notification) {
    let value = (n.object as! NSTextField).stringValue
    FileManager.default.createFile(atPath: log, contents: value.data(using: .utf8))
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 360, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Vunemi field test"
let field: NSTextField = args[1] == "secure" ? NSSecureTextField(frame: NSRect(x: 20, y: 40, width: 320, height: 28)) : NSTextField(frame: NSRect(x: 20, y: 40, width: 320, height: 28))
let watch = Watch()
field.delegate = watch
window.contentView!.addSubview(field)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(field)
app.activate(ignoringOtherApps: true)
app.run()
`;

it.skipIf(process.platform !== "darwin" || process.env.VUNEMI_PASSWORD_FIELD_LIVE !== "1")("typing stops at a real password field and still reaches a plain one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vunemi-password-field-"));
  const source = join(dir, "fixture.swift");
  const binary = join(dir, "fixture");
  writeFileSync(source, FIXTURE);
  execFileSync("/usr/bin/swiftc", [source, "-o", binary]);
  const helper = new Helper("/Applications/Vunemi.app/Contents/Resources/VunemiHelper", { operationJournalPath: join(dir, "journal.json") });
  const attempt = async (kind: "secure" | "plain"): Promise<{ typed: string | null; error: string | null }> => {
    const log = join(dir, `${kind}.txt`);
    const child = spawn(binary, [kind, log], { stdio: "ignore" });
    try {
      await new Promise((done) => setTimeout(done, 1_500));
      const observed = (await helper.call("describe", { app: String(child.pid), part: "window" })) as { snapshotId: string };
      let error: string | null = null;
      try {
        await helper.call("type", { app: String(child.pid), text: "deneme", snapshotId: observed.snapshotId });
      } catch (failure) {
        error = String(failure);
      }
      await new Promise((done) => setTimeout(done, 400));
      return { typed: existsSync(log) ? readFileSync(log, "utf8") : null, error };
    } finally {
      child.kill();
    }
  };
  try {
    const secure = await attempt("secure");
    expect(secure.error).toMatch(/password field/);
    expect(secure.typed).toBeNull();
    const plain = await attempt("plain");
    expect(plain.error).toBeNull();
    expect(plain.typed).toBe("deneme");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
