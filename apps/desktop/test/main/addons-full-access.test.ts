import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Roots } from '@vunemi/files';
import type { ToolContext } from '@vunemi/agent-core';
import type { Engines } from '../../src/main/addons/jobs.js';
import { fullAccessTools } from '../../src/main/addons/tools/full-access.js';
let base: string, folder: string, job: string;
let invoke: (args: readonly string[]) => {
  code: number;
  stdout: string;
  stderr: string;
};
let calls: readonly string[][];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'full-access-')));
  folder = join(base, 'allowed');
  job = join(base, 'job');
  mkdirSync(folder);
  mkdirSync(job);
  calls = [];
  invoke = () => ({
    code: 0,
    stdout: 'done',
    stderr: ''
  });
});
afterEach(() => rmSync(base, {
  recursive: true,
  force: true
}));
const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: () => {},
  attach: () => {}
});
const list = () => fullAccessTools('sheets', 'GridCraft', 'sheet', {
  roots: new Roots([folder]),
  shotDir: base,
  backupDir: join(base, '.backups'),
  engines: (async (_id, _signal, work) => work({
    dir: job,
    run: async args => {
      calls = [...calls, [...args]];
      return invoke(args);
    }
  })) as Engines
});
const run = () => list()[1]!;
it('runs arbitrary argv, stages arbitrary assets and exports verified files', async () => {
  writeFileSync(join(folder, 'data.bin'), 'source');
  invoke = args => {
    expect(args).toEqual(['any.future.mode', '--script', 'scripts/work.jsonl']);
    expect(readFileSync(join(job, 'assets/in.bin'), 'utf8')).toBe('source');
    expect(readFileSync(join(job, 'scripts/work.jsonl'), 'utf8')).toBe('steps');
    writeFileSync(join(job, 'result.custom'), 'result');
    return {
      code: 0,
      stdout: 'complete',
      stderr: ''
    };
  };
  expect(await run().run({
    args: ['any.future.mode', '--script', 'scripts/work.jsonl'],
    inputs: [{
      path: join(folder, 'data.bin'),
      name: 'assets/in.bin'
    }],
    files: [{
      name: 'scripts/work.jsonl',
      text: 'steps'
    }],
    outputs: [{
      name: 'result.custom',
      path: join(folder, 'out.custom')
    }]
  }, ctx())).toContain('complete');
  expect(readFileSync(join(folder, 'out.custom'), 'utf8')).toBe('result');
});
it('checks every output before exporting any', async () => {
  invoke = () => {
    writeFileSync(join(job, 'one'), 'yes');
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'one',
      path: join(folder, 'one')
    }, {
      name: 'missing',
      path: join(folder, 'two')
    }]
  }, ctx())).rejects.toThrow();
  expect(existsSync(join(folder, 'one'))).toBe(false);
});
it.each(['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a\u0000b'])('rejects unsafe alias %s before launch', async name => {
  await expect(run().run({
    args: ['run'],
    files: [{
      name,
      text: 'x'
    }]
  }, ctx())).rejects.toThrow();
  expect(calls).toEqual([]);
});
it('rejects conflicting aliases and external paths', async () => {
  await expect(run().run({
    args: ['run'],
    files: [{
      name: 'a',
      text: 'x'
    }, {
      name: 'a/b',
      text: 'y'
    }]
  }, ctx())).rejects.toThrow();
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'a',
      path: join(base, 'outside')
    }]
  }, ctx())).rejects.toThrow();
  expect(calls).toEqual([]);
});
it('rejects output symlinks even pointing inside the job', async () => {
  invoke = () => {
    writeFileSync(join(job, 'real'), 'yes');
    symlinkSync(join(job, 'real'), join(job, 'alias'));
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'alias',
      path: join(folder, 'out')
    }]
  }, ctx())).rejects.toThrow();
});
it('rejects structured JSONL failures but accepts nested user data', async () => {
  invoke = () => ({
    code: 0,
    stdout: '{"ok":true}\n{"ok":false,"error":"bad step"}',
    stderr: ''
  });
  await expect(run().run({
    args: ['run']
  }, ctx())).rejects.toThrow(/bad step/);
  invoke = () => ({
    code: 0,
    stdout: '{"ok":true,"data":{"ok":false,"error":"user data"}}',
    stderr: ''
  });
  expect(await run().run({
    args: ['run']
  }, ctx())).toContain('user data');
});
it('reads help despite a usage exit and supports search paging', async () => {
  invoke = () => ({
    code: 1,
    stdout: 'Usage: grid\nalpha mode\nbeta mode\nalpha feature',
    stderr: ''
  });
  expect(await list()[0]!.run({
    query: 'alpha',
    offset: 1,
    limit: 1
  }, ctx())).toContain('alpha feature');
  expect(calls).toEqual([['--help']]);
});
it('classifies only exported files as writes and keeps schema compact', () => {
  expect(run().classify!({
    args: ['run']
  })).toBe('read');
  expect(run().classify!({
    outputs: [{}]
  })).toBe('write-local');
  for (const tool of list()) expect(JSON.stringify(tool.parameters).length).toBeLessThan(1000);
});
it('honors cancellation before launch and delivery', async () => {
  const c = new AbortController();
  c.abort();
  await expect(run().run({
    args: ['run']
  }, {
    ...ctx(),
    signal: c.signal
  })).rejects.toThrow();
  expect(calls).toEqual([]);
  const d = new AbortController();
  invoke = () => {
    writeFileSync(join(job, 'out'), 'yes');
    d.abort();
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'out',
      path: join(folder, 'out')
    }]
  }, {
    ...ctx(),
    signal: d.signal
  })).rejects.toThrow();
  expect(existsSync(join(folder, 'out'))).toBe(false);
});
it('exports complete directory trees and reports each file', async () => {
  invoke = () => {
    mkdirSync(join(job, 'pages/nested'), {
      recursive: true
    });
    writeFileSync(join(job, 'pages/a.pdf'), 'a');
    writeFileSync(join(job, 'pages/nested/b.pdf'), 'b');
    return {
      code: 0,
      stdout: 'split complete',
      stderr: ''
    };
  };
  const produced: string[] = [];
  await run().run({
    args: ['split'],
    outputs: [{
      name: 'pages',
      path: join(folder, 'split')
    }]
  }, {
    ...ctx(),
    produced: v => {
      if (v.kind === 'file') produced.push(v.path);
    }
  });
  expect(readFileSync(join(folder, 'split/nested/b.pdf'), 'utf8')).toBe('b');
  expect(produced).toEqual([join(folder, 'split/a.pdf'), join(folder, 'split/nested/b.pdf')]);
});
it('rejects directory trees with symlinks before exporting any file', async () => {
  invoke = () => {
    mkdirSync(join(job, 'pages'));
    writeFileSync(join(job, 'pages/a.pdf'), 'a');
    symlinkSync(join(folder, 'original'), join(job, 'pages/z.pdf'));
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['split'],
    outputs: [{
      name: 'pages',
      path: join(folder, 'split')
    }]
  }, ctx())).rejects.toThrow();
  expect(existsSync(join(folder, 'split'))).toBe(false);
});
it('never clobbers destinations appearing during execution', async () => {
  invoke = () => {
    writeFileSync(join(job, 'out'), 'new');
    writeFileSync(join(folder, 'out'), 'original');
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'out',
      path: join(folder, 'out')
    }]
  }, ctx())).rejects.toThrow();
  expect(readFileSync(join(folder, 'out'), 'utf8')).toBe('original');
});
it('rejects nonzero exits and empty files even when other outputs exist', async () => {
  invoke = () => ({
    code: 3,
    stdout: '',
    stderr: 'unsupported'
  });
  await expect(run().run({
    args: ['new-mode']
  }, ctx())).rejects.toThrow(/unsupported/);
  invoke = () => {
    writeFileSync(join(job, 'empty'), '');
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'empty',
      path: join(folder, 'out')
    }]
  }, ctx())).rejects.toThrow();
  expect(existsSync(join(folder, 'out'))).toBe(false);
});
it('honors active-tool revocation after engine work', async () => {
  let revoked = false;
  invoke = () => {
    revoked = true;
    writeFileSync(join(job, 'out'), 'yes');
    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'out',
      path: join(folder, 'out')
    }]
  }, {
    ...ctx(),
    assertToolActive: () => {
      if (revoked) throw new Error('revoked');
    }
  })).rejects.toThrow(/revoked/);
  expect(existsSync(join(folder, 'out'))).toBe(false);
});
it('stages directory inputs including nested assets and empty folders', async () => {
  mkdirSync(join(folder, 'batch/nested'), {
    recursive: true
  });
  mkdirSync(join(folder, 'batch/empty'));
  writeFileSync(join(folder, 'batch/nested/source.raw'), 'asset');
  invoke = () => {
    expect(readFileSync(join(job, 'in/nested/source.raw'), 'utf8')).toBe('asset');
    expect(existsSync(join(job, 'in/empty'))).toBe(true);
    return {
      code: 0,
      stdout: 'checked',
      stderr: ''
    };
  };
  expect(await run().run({
    args: ['batch'],
    inputs: [{
      name: 'in',
      path: join(folder, 'batch')
    }]
  }, ctx())).toContain('checked');
});
it.each(['.env', 'nested/.ssh/key'])('refuses private entries in directory inputs: %s', async privateName => {
  mkdirSync(join(folder, 'batch', privateName, '..'), {
    recursive: true
  });
  writeFileSync(join(folder, 'batch', privateName), 'private');
  expect(await run().check!({
    args: ['batch'],
    inputs: [{
      name: 'in',
      path: join(folder, 'batch')
    }]
  })).toBeTruthy();
  expect(calls).toEqual([]);
});
it('rejects input symlink trees and expanded inline collisions', async () => {
  mkdirSync(join(folder, 'batch'));
  writeFileSync(join(folder, 'batch/a'), 'source');
  await expect(run().run({
    args: ['batch'],
    inputs: [{
      name: 'in',
      path: join(folder, 'batch')
    }],
    files: [{
      name: 'in/a',
      text: 'replace'
    }]
  }, ctx())).rejects.toThrow();
  symlinkSync(join(folder, 'batch'), join(folder, 'batch/loop'));
  expect(await run().check!({
    args: ['batch'],
    inputs: [{
      name: 'in',
      path: join(folder, 'batch')
    }]
  })).toBeTruthy();
  expect(calls).toEqual([]);
});
it('rechecks directory entries immediately before staging', async () => {
  mkdirSync(join(folder, 'batch'));
  writeFileSync(join(folder, 'batch/a'), 'source');
  const tool = fullAccessTools('sheets', 'GridCraft', 'sheet', {
    roots: new Roots([folder]),
    shotDir: base,
  backupDir: join(base, '.backups'),
    engines: (async (_id, _signal, work) => {
      rmSync(join(folder, 'batch/a'));
      symlinkSync(join(base, 'private'), join(folder, 'batch/a'));
      return work({
        dir: job,
        run: async args => {
          calls = [...calls, [...args]];
          return invoke(args);
        }
      });
    }) as Engines
  })[1]!;
  await expect(tool.run({
    args: ['batch'],
    inputs: [{
      name: 'in',
      path: join(folder, 'batch')
    }]
  }, ctx())).rejects.toThrow();
  expect(calls).toEqual([]);
});
it('rejects Photo actions.play partial execution before exporting', async () => {
  invoke = () => {
    writeFileSync(join(job, 'out'), 'partial');
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        id: 'actions.play',
        result: {
          action: 'resize',
          ran: 2,
          failed: {
            step: 3,
            id: 'image.resize',
            error: 'bad dimensions'
          }
        }
      }),
      stderr: ''
    };
  };
  await expect(run().run({
    args: ['run'],
    outputs: [{
      name: 'out',
      path: join(folder, 'out')
    }]
  }, ctx())).rejects.toThrow(/bad dimensions/);
  expect(existsSync(join(folder, 'out'))).toBe(false);
});
it('rejects top-level failures without error but accepts nested failed user data', async () => {
  invoke = () => ({
    code: 0,
    stdout: '{"ok":false,"reason":"refused"}',
    stderr: ''
  });
  await expect(run().run({
    args: ['run']
  }, ctx())).rejects.toThrow(/refused/);
  invoke = () => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      id: 'read',
      result: {
        failed: {
          step: 1,
          id: 'user',
          error: 'user content'
        }
      }
    }),
    stderr: ''
  });
  expect(await run().run({
    args: ['read']
  }, ctx())).toContain('user content');
});
it("rejects external directory inputs and symlinks to allowed files", async () => {
  mkdirSync(join(base, "outside"));
  expect(await run().check!({
    args: ["batch"],
    inputs: [{
      name: "in",
      path: join(base, "outside")
    }]
  })).toBeTruthy();
  mkdirSync(join(folder, "batch"));
  writeFileSync(join(folder, "source"), "source");
  symlinkSync(join(folder, "source"), join(folder, "batch", "alias"));
  expect(await run().check!({
    args: ["batch"],
    inputs: [{
      name: "in",
      path: join(folder, "batch")
    }]
  })).toMatch(/symlinks/);
  expect(calls).toEqual([]);
});
it("shows export destinations in the localized preview", async () => {
  const preview = await run().preview!({
    outputs: [{
      name: "out",
      path: join(folder, "report.custom")
    }]
  });
  expect(preview).toContain("report.custom");
  expect(await run().preview!({
    args: ["commands"]
  })).toBe("GridCraft");
});
it("accepts arbitrary nested failed data inside non-execution results", async () => {
  invoke = () => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      id: "read",
      result: {
        action: "content",
        ran: 2,
        failed: {
          step: 1,
          id: "content",
          error: "user text"
        }
      }
    }),
    stderr: ""
  });
  expect(await run().run({
    args: ["read"]
  }, ctx())).toContain("user text");
});
it("detects actual pretty PhotoCraft partial envelopes without ok", async () => {
  invoke = () => {
    writeFileSync(join(job, "out"), "partial");
    const first = JSON.stringify({
      command: "doc.new",
      result: {
        doc: 1
      }
    }, null, 2);
    const failed = JSON.stringify({
      command: "actions.play",
      result: {
        action: "resize",
        ran: 1,
        failed: {
          step: 1,
          id: "image.resize",
          error: "stopped action"
        }
      }
    }, null, 2);
    return {
      code: 0,
      stdout: first + "\n" + failed,
      stderr: ""
    };
  };
  await expect(run().run({
    args: ["run"],
    outputs: [{
      name: "out",
      path: join(folder, "out")
    }]
  }, ctx())).rejects.toThrow(/stopped action/);
  expect(existsSync(join(folder, "out"))).toBe(false);
});
it("uses Roots canonical spelling for padded relative inputs", async () => {
  mkdirSync(join(folder, "batch"));
  writeFileSync(join(folder, "batch", "a"), "asset");
  invoke = () => {
    expect(readFileSync(join(job, "in", "a"), "utf8")).toBe("asset");
    return {
      code: 0,
      stdout: "checked",
      stderr: ""
    };
  };
  expect(await run().run({
    args: ["batch"],
    inputs: [{
      name: "in",
      path: " batch "
    }]
  }, ctx())).toContain("checked");
});
