import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const commitModule = await import("../../dist/commands/commit.js").catch(() => null);

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-commit-"));
  try {
    await git(root, "init", "--quiet");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "tracked.txt"), "before\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "chore: initial fixture");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdin: { isTTY: true },
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    read() { return { stdout, stderr }; },
  };
}

test("commit proposes and commits only staged content", async () => {
  assert.notEqual(commitModule, null, "the built commit command must exist");
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "unstaged\n");
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    const io = output();
    let input;
    const code = await commitModule.commitCommand(root, io, {
      async propose(value) { input = value; return { subject: "fix: update tracked content", summary: "Updates the tracked fixture." }; },
      async confirm() { return true; },
    });
    assert.equal(code, 0);
    assert.match(input.patch, /\+staged/);
    assert.doesNotMatch(input.patch, /unstaged|untracked/);
    assert.deepEqual(input.paths, ["tracked.txt"]);
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "staged");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "unstaged\n");
    assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update tracked content");
    assert.match(io.read().stdout, /tracked.txt/);
  });
});

test("terminal confirmation requires an exact yes", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    io.stdin = Readable.from(["yes\n"]);
    io.stdin.isTTY = true;
    assert.equal(await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      confirm: commitModule.confirmInTerminal,
    }), 0);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update fixture");
  });
});

test("terminal confirmation refuses every response except exact yes", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    for (const answer of ["YES\n", "yes \n", "\n", "no\n"]) {
      const io = output();
      io.stdin = Readable.from([answer]);
      io.stdin.isTTY = true;
      assert.equal(await commitModule.commitCommand(root, io, {
        async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
        confirm: commitModule.confirmInTerminal,
      }), 0);
      assert.match(io.read().stdout, /Commit cancelled/);
      assert.equal(await git(root, "rev-parse", "HEAD"), before);
    }
  });
});

test("an unchanged gitlink does not block an ordinary staged change", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    const gitlink = await git(root, "rev-parse", "HEAD");
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${gitlink},submodule`);
    await git(root, "commit", "--quiet", "-m", "chore: add fixture gitlink");
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    assert.equal(await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() { return true; },
    }), 0);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update fixture");
  });
});

test("a staged gitlink deletion is refused", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    const gitlink = await git(root, "rev-parse", "HEAD");
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${gitlink},submodule`);
    await git(root, "commit", "--quiet", "-m", "chore: add fixture gitlink");
    const before = await git(root, "rev-parse", "HEAD");
    await git(root, "rm", "--cached", "submodule");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "chore: remove gitlink", summary: "Removes the gitlink." }; },
      async confirm() { return true; },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    assert.match(io.read().stderr, /staged submodules are unsupported/i);
  });
});

test("commit refuses an index change after confirmation", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "first\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() {
        await writeFile(join(root, "tracked.txt"), "second\n");
        await git(root, "add", "tracked.txt");
        return true;
      },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    assert.match(io.read().stderr, /staged content changed/i);
  });
});

test("commit refuses a HEAD change after confirmation", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() {
        await git(root, "commit", "--quiet", "-m", "parallel commit");
        return true;
      },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "parallel commit");
    assert.match(io.read().stderr, /HEAD changed/i);
  });
});

test("commit refuses a branch change with the same HEAD commit", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() {
        await git(root, "switch", "--quiet", "-c", "other-branch");
        return true;
      },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    assert.equal(await git(root, "symbolic-ref", "HEAD"), "refs/heads/other-branch");
    assert.match(io.read().stderr, /HEAD changed/i);
  });
});

test("commit refuses blank, trailing-whitespace, or control-character proposals before confirmation", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    for (const proposal of [
      { subject: "   ", summary: "Updates the fixture." },
      { subject: "fix: update fixture ", summary: "Updates the fixture." },
      { subject: "fix: update fixture", summary: "\u001b[31mUpdates the fixture." },
    ]) {
      const io = output();
      let confirmed = false;
      const code = await commitModule.commitCommand(root, io, {
        async propose() { return proposal; },
        async confirm() { confirmed = true; return true; },
      });
      assert.equal(code, 1);
      assert.equal(confirmed, false);
      assert.equal(await git(root, "rev-parse", "HEAD"), before);
    }
  });
});

test("commit reports a message rewritten by a Git hook", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const hook = join(root, ".git", "hooks", "commit-msg");
    await writeFile(hook, "#!/bin/sh\nprintf 'hook changed subject\\n' > \"$1\"\n");
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() { return true; },
    });
    assert.equal(code, 1);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "hook changed subject");
    assert.match(io.read().stderr, /differs from the reviewed/i);
  });
});

test("commit does not suggest a blind retry after post-commit verification fails", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const hook = join(root, ".git", "hooks", "post-commit");
    await writeFile(hook, '#!/bin/sh\nrm -f "$(git rev-parse --git-path HEAD)"\n');
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async confirm() { return true; },
    });
    assert.equal(code, 3);
    assert.match(io.read().stderr, /commit may exist|successful commit/i);
    assert.match(io.read().stderr, /inspect HEAD/i);
  });
});

test("the default proposal path accepts a completed Codex response without committing in a pipe", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-runtime-"));
    const binary = join(runtime, "fake-codex");
    const response = [
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "Configuration warning" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ subject: "fix: update fixture", summary: "Updates the fixture." }) } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    await writeFile(binary, `#!/bin/sh\nfor required in "--ephemeral" "--ignore-user-config" "--disable shell_tool" "--sandbox read-only"; do\n  case " $* " in *" $required "*) ;; *) exit 42;; esac\ndone\ncat >/dev/null\nprintf '%s\\n' '${response.replaceAll("'", "'\\''").replaceAll("\n", "' '")}'\n`);
    await chmod(binary, 0o700);
    const previous = {
      source: process.env.ANDREW_AGENT_CODEX_SOURCE,
      state: process.env.ANDREW_AGENT_STATE_ROOT,
      binary: process.env.ANDREW_AGENT_CODEX_BIN,
    };
    process.env.ANDREW_AGENT_CODEX_SOURCE = root;
    process.env.ANDREW_AGENT_STATE_ROOT = join(runtime, "state");
    process.env.ANDREW_AGENT_CODEX_BIN = binary;
    try {
      const io = output();
      io.stdin.isTTY = false;
      assert.equal(await commitModule.commitCommand(root, io), 0);
      assert.match(io.read().stdout, /Message: fix: update fixture/);
      assert.match(io.read().stdout, /Commit cancelled/);
      assert.equal(await git(root, "log", "-1", "--format=%s"), "chore: initial fixture");
    } finally {
      for (const [key, value] of [["ANDREW_AGENT_CODEX_SOURCE", previous.source], ["ANDREW_AGENT_STATE_ROOT", previous.state], ["ANDREW_AGENT_CODEX_BIN", previous.binary]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(runtime, { recursive: true, force: true });
    }
  });
});

test("an early Codex exit reports a proposal failure without an unhandled stdin error", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "x".repeat(200_000));
    await git(root, "add", "tracked.txt");
    const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-early-exit-"));
    const binary = join(runtime, "fake-codex");
    await writeFile(binary, "#!/bin/sh\nexit 42\n");
    await chmod(binary, 0o700);
    try {
      const result = await execFile(process.execPath, [join(process.cwd(), "dist", "cli.js"), "commit"], {
        cwd: root,
        env: {
          ...process.env,
          ANDREW_AGENT_CODEX_SOURCE: root,
          ANDREW_AGENT_STATE_ROOT: join(runtime, "state"),
          ANDREW_AGENT_CODEX_BIN: binary,
        },
      }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Unable to propose a commit message/);
      assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });
});

test("a proposal timeout terminates a Codex process that ignores SIGTERM", async () => {
  assert.equal(typeof commitModule?.runCodex, "function");
  const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-timeout-"));
  const binary = join(runtime, "fake-codex");
  const pidFile = join(runtime, "pid");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
  await chmod(binary, 0o700);
  try {
    const proposal = commitModule.runCodex(binary, runtime, runtime, "test prompt", 1_200).then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", message: error.message }),
    );
    const readyDeadline = Date.now() + 1_000;
    let pid = 0;
    while (pid === 0 && Date.now() < readyDeadline) {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pid > 0, "the fake Codex process must start before timeout");
    assert.doesNotThrow(() => process.kill(pid, 0));
    const result = await Promise.race([
      proposal,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 2_500)),
    ]);
    assert.deepEqual(result, { kind: "rejected", message: "Codex proposal timed out." });
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(runtime, { recursive: true, force: true });
  }
});

test("a proposal timeout closes output pipes held by a Codex descendant", async () => {
  assert.equal(typeof commitModule?.runCodex, "function");
  const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-descendant-"));
  const binary = join(runtime, "fake-codex");
  const pidFile = join(runtime, "pids.json");
  await writeFile(binary, `#!${process.execPath}\nconst fs = require("node:fs");\nconst { spawn } = require("node:child_process");\nconst descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"] });\nfs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
  await chmod(binary, 0o700);
  let pids = { parent: 0, descendant: 0 };
  try {
    const proposal = commitModule.runCodex(binary, runtime, runtime, "test prompt", 1_200).then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", message: error.message }),
    );
    const readyDeadline = Date.now() + 1_000;
    while (pids.descendant === 0 && Date.now() < readyDeadline) {
      pids = JSON.parse(await readFile(pidFile, "utf8").catch(() => '{"parent":0,"descendant":0}'));
      if (pids.descendant === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(pids.parent > 0 && pids.descendant > 0, "the descendant must start before timeout");
    assert.doesNotThrow(() => process.kill(pids.descendant, 0));
    const result = await Promise.race([
      proposal,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 2_500)),
    ]);
    assert.deepEqual(result, { kind: "rejected", message: "Codex proposal timed out." });
  } finally {
    for (const pid of [pids.parent, pids.descendant]) {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await rm(runtime, { recursive: true, force: true });
  }
});
