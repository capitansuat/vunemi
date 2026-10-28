/** Full pinned-engine CLI access. The sandbox, staging, and exports remain Vunemi's boundary. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { t } from "@vunemi/i18n";
import type { ToolContext, ToolDef } from "@vunemi/agent-core";
import type { AddonId } from "../../../shared/ipc.js";
import {createSafeOfficeEdits} from "./safe-office-edit.js";
import { deliver, short, tried, type AddonToolDeps } from "./common.js";
type Named = {
  name: string;
  path: string;
};
type Inline = {
  name: string;
  text: string;
};
function alias(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.split("/").some(p => !p || p === "." || p === ".." || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Use a safe relative job file name.");
  return value;
}
function objects<T>(value: unknown): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("Expected a list of named files.");
  return value as T[];
}
function active(ctx: ToolContext): void {
  ctx.signal.throwIfAborted();
  ctx.assertToolActive?.();
}
function failure(stdout: string): string | undefined {
  // Recognize execution envelopes, without searching arbitrary nested user data.
  const read = (text: string): string | undefined => {
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (value.ok === false) return text;
      const command = value.id ?? value.command ?? value.cmd;
      const result = value.result;
      const failed = result?.failed;
      if (command === "actions.play" && typeof result?.action === "string" && typeof result?.ran === "number" && Number.isInteger(failed?.step) && typeof failed?.id === "string" && failed.error !== undefined) return text;
    } catch {/* Ordinary engine output is not a protocol envelope. */}
    return undefined;
  };
  return read(stdout) ?? stdout.split(/\n(?=\{)/).map(read).find(value => value !== undefined) ?? stdout.split("\n").map(read).find(value => value !== undefined);
}

/** Expand and authorize every entry, preserving empty input directories. */
function inputTree(deps: AddonToolDeps, input: Named): (Named & {
  directory: boolean;
})[] {
  const expanded = input.path === "~" || input.path.startsWith("~/") ? join(homedir(), input.path.slice(1)) : input.path;
  const lexical = isAbsolute(expanded) ? expanded : join(deps.roots.list()[0] ?? homedir(), expanded);
  const seen = new Set<string>();
  const visit = (path: string, name: string): (Named & {
    directory: boolean;
  })[] => {
    alias(name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Input trees cannot contain symlinks.");
    const allowed = deps.roots.resolve(path, "read");
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("Inputs must be regular files or directories.");
    if (stat.isFile()) return [{
      name,
      path: allowed,
      directory: false
    }];
    if (seen.has(allowed)) throw new Error("Input directory cycle.");
    seen.add(allowed);
    return [{
      name,
      path: allowed,
      directory: true
    }, ...readdirSync(allowed).flatMap(child => visit(join(allowed, child), `${name}/${child}`))];
  };
  // Authorize the supplied spelling before walking the physical directory.
  const canonical = deps.roots.resolve(input.path, "read");
  if (existsSync(lexical) && lstatSync(lexical).isSymbolicLink()) throw new Error("Input trees cannot contain symlinks.");
  return visit(canonical, input.name);
}
function contained(job: string, path: string): void {
  const rel = relative(realpathSync(job), realpathSync(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Output escapes the job folder.");
}
function outputTree(job: string, name: string): {
  name: string;
  path: string;
}[] {
  const path = join(job, name);
  const parts = name.split("/");
  for (let i = 1; i <= parts.length; i++) if (lstatSync(join(job, ...parts.slice(0, i))).isSymbolicLink()) throw new Error("Job output cannot contain symlinks.");
  contained(job, path);
  const stat = lstatSync(path);
  if (stat.isFile() && stat.size > 0) return [{
    name,
    path
  }];
  if (!stat.isDirectory()) throw new Error(`Expected a nonempty regular output: ${name}`);
  const children = readdirSync(path).flatMap(child => outputTree(job, `${name}/${child}`));
  if (!children.length) throw new Error(`Empty output directory: ${name}`);
  return children;
}
export function fullAccessTools(id: AddonId, engine: string, prefix: string, deps: AddonToolDeps): ToolDef[] {
  const edits=createSafeOfficeEdits(deps.roots);
  function prepare(a: Record<string, unknown>) {
    if (!Array.isArray(a.args) || a.args.some(v => typeof v !== "string" || v.includes("\0"))) throw new Error("args must be CLI arguments as a string list.");
    const inputs = objects<Named>(a.inputs).map(value => {
      const input = {
        name: alias(value.name),
        path: value.path
      };
      inputTree(deps, input);
      return input;
    });
    const files = objects<Inline>(a.files).map(v => {
      const name = alias(v.name);
      if (typeof v.text !== "string") throw new Error("Inline file text must be a string.");
      return {
        name,
        text: v.text
      };
    });
    if (files.reduce((n, v) => n + Buffer.byteLength(v.text), 0) > 32_000_000) throw new Error("Inline files exceed 32 MB.");
    const declared=objects<Named>(a.outputs);
    if(a.replaceExisting===true&&(!['documents','sheets','slides'].includes(id)||declared.length!==1))throw Error('replaceExisting supports exactly one Office file export per approval.');
    const outputs = declared.map(v => {
      const name = alias(v.name),
        path = deps.roots.resolve(v.path, "write");
      const expectedKind=id==='documents'?'.docx':id==='sheets'?'.xlsx':id==='slides'?'.pptx':null;
      if(a.replaceExisting===true&&(extname(path).toLowerCase()!==expectedKind||extname(name).toLowerCase()!==expectedKind))throw Error('Office replacement engine, target and job output format must match.');
      const replacement=edits.prepare(a,v.path,a.replaceExisting);
      return {name,path,replacement};
    });
    if(a.replaceExisting===true&&!inputs.some(input=>deps.roots.resolve(input.path,'read')===outputs[0]!.path))throw Error('Office replacement must stage the existing target as an input.');
    for (const group of [[...inputs, ...files], outputs]) {
      const names = group.map(v => v.name.toLowerCase());
      if (names.some((n, i) => names.some((m, j) => i !== j && (n === m || n.startsWith(`${m}/`))))) throw new Error("Conflicting job file names.");
    }
    if (outputs.some((v, i) => outputs.some((w, j) => i !== j && (v.path === w.path || v.path.startsWith(`${w.path}${sep}`))))) throw new Error("Conflicting output destinations.");
    const timeoutMs = a.timeoutMs === undefined ? id === "video" ? 2_400_000 : 300_000 : Number(a.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_400_000) throw new Error("timeoutMs must be between 1 and 2400000.");
    if (a.stdin !== undefined && typeof a.stdin !== "string") throw new Error("stdin must be a string.");
    return {
      args: a.args as string[],
      inputs,
      files,
      outputs,
      timeoutMs,
      stdin: a.stdin as string | undefined
    };
  }
  const named = (field: string) => ({
    type: "array",
    items: {
      type: "object",
      properties: {
        name: {
          type: "string"
        },
        [field]: {
          type: "string"
        }
      },
      required: ["name", field]
    }
  });
  return [{
    name: `${prefix}_engine_help`,
    description: `${engine} installed CLI help. Optional query filters lines; offset/limit page matching lines.`,
    actionClass: "read",
    untrustedOutput: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string"
        },
        offset: {
          type: "integer",
          minimum: 0
        },
        limit: {
          type: "integer",
          minimum: 1
        }
      }
    },
    check: () => null,
    preview: async () => `${engine} help`,
    run: async (a, ctx) => {
      active(ctx);
      return deps.engines(id, ctx.signal, async job => {
        active(ctx);
        const result = await job.run(["--help"]);
        active(ctx);
        const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
        if (!text.trim() || result.code !== 0 && result.code !== 1) throw new Error(`${engine} help failed: ${text || result.code}`);
        const lines = text.split("\n").filter(line => !a.query || line.toLowerCase().includes(String(a.query).toLowerCase()));
        const offset = Number(a.offset ?? 0),
          limit = a.limit === undefined ? lines.length : Number(a.limit);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) throw new Error("Invalid help page.");
        return `Help lines ${offset + 1}-${Math.min(lines.length, offset + limit)} of ${lines.length}\n${lines.slice(offset, offset + limit).join("\n")}`;
      });
    }
  }, {
    name: `${prefix}_engine_run`,
    description: `Run any ${engine} CLI mode with argv (no shell). Stage inputs/files at relative names used in args; export verified nonempty outputs to new allowed paths.`,
    actionClass: "write-local",
    untrustedOutput: true,
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: {
            type: "string"
          }
        },
        inputs: named("path"),
        files: named("text"),
        outputs: named("path"),
        stdin: {
          type: "string"
        },
        replaceExisting:{type:"boolean",description:"Explicitly replace one existing Office file with an approved backup; default false exports new files only."},
        timeoutMs: {
          type: "integer"
        }
      },
      required: ["args"]
    },
    classify: a => Array.isArray(a.outputs) && a.outputs.length ? "write-local" : "read",
    alwaysAskWhen:a=>a.replaceExisting===true,
    check: a => tried(() => prepare(a)),
    preview: async a => {
      const outputs=objects<Named>(a.outputs);
      if(a.replaceExisting===true){const plan=prepare(a);return `Replace existing Office file: ${outputs[0]!.path}\nBackup original: ${plan.outputs[0]!.replacement.backupPath}\nEngine changes: ${JSON.stringify(plan.args)}`;}
      return outputs.length ? outputs.map(output => t("addons.preview.make", {
        path: short(output.path)
      })).join("\n") : engine;
    },
    run: async (a, ctx) => {
      const plan = prepare(a);
      active(ctx);
      for(const output of plan.outputs)edits.verify(output.replacement);
      return deps.engines(id, ctx.signal, async job => {
        for (const input of plan.inputs) {
          for (const entry of inputTree(deps, input)) {
            active(ctx);
            const stat = lstatSync(entry.path);
            const source = deps.roots.resolve(entry.path, "read");
            if (stat.isSymbolicLink() || (entry.directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Input changed before staging.");
            const path = join(job.dir, entry.name);
            if (entry.directory) mkdirSync(path, {
              recursive: true
            });else {
              mkdirSync(dirname(path), {
                recursive: true
              });
              copyFileSync(source, path, constants.COPYFILE_EXCL);
            }
          }
        }
        for (const file of plan.files) {
          const path = join(job.dir, file.name);
          mkdirSync(dirname(path), {
            recursive: true
          });
          writeFileSync(path, file.text, {
            flag: "wx"
          });
        }
        active(ctx);
        const result = await job.run(plan.args, {
          stdin: plan.stdin,
          timeoutMs: plan.timeoutMs
        });
        active(ctx);
        const failed = failure(result.stdout);
        if (result.code !== 0 || failed !== undefined) throw new Error(`${engine} failed: ${failed ?? (result.stderr || result.stdout || `exit ${result.code}`)}`);
        const exports = plan.outputs.map(output => ({
          ...output,
          files: outputTree(job.dir, output.name)
        }));
        // Validate all requested trees and all destinations before the first exported byte.
        for (const output of exports) {
          deps.roots.resolve(output.path, "write");
          edits.verify(output.replacement);
          if(a.replaceExisting===true&&(output.files.length!==1||lstatSync(join(job.dir,output.name)).isDirectory()))throw Error('Office replacement requires one nonempty file, not a directory export.');
          for (const file of output.files) deps.roots.resolve(join(output.path, relative(output.name, file.name)), "write");
        }
        active(ctx);
        for (const output of exports) {
          const directory = lstatSync(join(job.dir, output.name)).isDirectory();
          if (directory) {
            mkdirSync(dirname(output.path), {
              recursive: true
            });
            mkdirSync(output.path);
          }
          for (const file of output.files) {
            active(ctx);
            const to = directory ? join(output.path, relative(output.name, file.name)) : output.path;
            if(a.replaceExisting===true)edits.deliver(file.path,output.replacement,ctx);
            else deliver(file.path, deps.roots.resolve(to, "write"), ctx);
          }
        }
        return [result.stdout, result.stderr, ...plan.outputs.map(o => `Exported: ${o.path}${o.replacement.backupPath?`; original backup: ${o.replacement.backupPath}`:""}`)].filter(Boolean).join("\n");
      });
    }
  }];
}
