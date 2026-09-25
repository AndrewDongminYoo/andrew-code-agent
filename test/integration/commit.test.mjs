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
      async authorize() { return true; },
    });
    assert.equal(code, 0);
    assert.match(input.patch, /\+staged/);
    assert.doesNotMatch(input.patch, /unstaged|untracked/);
    assert.deepEqual(input.paths, ["tracked.txt"]);
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "staged");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "unstaged\n");
    assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update tracked content");
    assert.equal(
      await git(root, "log", "-1", "--format=%B"),
      "fix: update tracked content\n\nUpdates the tracked fixture.",
    );
    assert.match(io.read().stdout, /Body: Updates the tracked fixture\./);
    assert.match(io.read().stdout, /tracked.txt/);
  });
});

test("short format commits only the proposed subject", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() {
        return {
          subject: "fix: update fixture",
          summary: "Updates the fixture.",
        };
      },
      async authorize() { return true; },
    }, "short");
    assert.equal(code, 0);
    assert.equal(
      await git(root, "log", "-1", "--format=%B"),
      "fix: update fixture",
    );
    assert.match(io.read().stdout, /Body: \(omitted by --short\)/);
  });
});

test("commit accepts repository rules at 64 KiB", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "AGENTS.md"), "r".repeat(64 * 1024));
    await git(root, "add", "AGENTS.md");
    await git(root, "commit", "--quiet", "-m", "docs: add repository rules");
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    let input;
    const code = await commitModule.commitCommand(root, io, {
      async propose(value) {
        input = value;
        return {
          subject: "fix: update fixture",
          summary: "Updates the fixture.",
        };
      },
      async authorize() {
        return false;
      },
    });
    assert.equal(code, 0);
    assert.equal(Buffer.byteLength(input.rules, "utf8"), 64 * 1024);
    assert.match(io.read().stdout, /Commit cancelled/);
  });
});

test("commit refuses repository rules above 64 KiB before proposal", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "AGENTS.md"), "r".repeat(64 * 1024 + 1));
    await git(root, "add", "AGENTS.md");
    await git(root, "commit", "--quiet", "-m", "docs: add repository rules");
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    let proposed = false;
    const code = await commitModule.commitCommand(root, io, {
      async propose() {
        proposed = true;
        return {
          subject: "fix: update fixture",
          summary: "Updates the fixture.",
        };
      },
      async authorize() {
        return true;
      },
    });
    assert.equal(code, 3);
    assert.equal(proposed, false);
    assert.match(
      io.read().stderr,
      /Repository rules exceed the commit proposal limit/,
    );
  });
});

test("terminal invocation authorizes a commit without reading input", async () => {
  assert.equal(typeof commitModule?.authorizeInteractiveCommit, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    io.stdin = { isTTY: true };
    assert.equal(await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      authorize: commitModule.authorizeInteractiveCommit,
    }), 0);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update fixture");
    assert.doesNotMatch(io.read().stdout, /Type yes/);
  });
});

test("non-interactive input remains preview-only even when it contains yes", async () => {
  assert.equal(typeof commitModule?.authorizeInteractiveCommit, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    const io = output();
    io.stdin = Readable.from(["yes\n"]);
    io.stdin.isTTY = false;
    assert.equal(await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      authorize: commitModule.authorizeInteractiveCommit,
    }), 0);
    assert.match(io.read().stdout, /Commit cancelled/);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
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
      async authorize() { return true; },
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
      async authorize() { return true; },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    assert.match(io.read().stderr, /staged submodules are unsupported/i);
  });
});

test("a resolved merge is refused before proposing an ordinary commit", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    const originalBranch = await git(root, "symbolic-ref", "--short", "HEAD");
    await git(root, "switch", "--quiet", "-c", "feature");
    await writeFile(join(root, "tracked.txt"), "feature\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "feat: branch change");
    await git(root, "switch", "--quiet", originalBranch);
    await writeFile(join(root, "tracked.txt"), "main\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "fix: current branch change");
    await assert.rejects(git(root, "merge", "feature"));
    await writeFile(join(root, "tracked.txt"), "resolved\n");
    await git(root, "add", "tracked.txt");
    assert.notEqual(await git(root, "rev-parse", "MERGE_HEAD"), "");
    assert.equal(await git(root, "ls-files", "--unmerged"), "");
    const before = await git(root, "rev-parse", "HEAD");
    let proposed = false;
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { proposed = true; return { subject: "fix: resolve merge", summary: "Resolves the merge." }; },
      async authorize() { return true; },
    });
    assert.equal(code, 3);
    assert.equal(proposed, false);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    assert.match(io.read().stderr, /merge/i);
  });
});

test("commit reports a merge parent introduced after the final check", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    const originalBranch = await git(root, "symbolic-ref", "--short", "HEAD");
    await git(root, "switch", "--quiet", "-c", "feature");
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "feat: other branch");
    await git(root, "switch", "--quiet", originalBranch);
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-merge-race-"));
    const realGit = (await execFile("which", ["git"])).stdout.trim();
    const wrapper = join(runtime, "git");
    await writeFile(wrapper, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
function run(...gitArgs) {
  const result = spawnSync(realGit, ["-C", args[1], ...gitArgs], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (args[2] === "commit" && args[3] === "--quiet") {
  run("reset", "--quiet", "--mixed", "HEAD");
  run("merge", "--no-commit", "--no-ff", "feature");
  run("add", "tracked.txt");
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    await chmod(wrapper, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${runtime}:${originalPath}`;
    try {
      const io = output();
      const code = await commitModule.commitCommand(root, io, {
        async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
        async authorize() { return true; },
      });
      assert.equal(code, 1);
      assert.equal((await git(root, "show", "-s", "--format=%P", "HEAD")).split(" ").length, 2);
      assert.match(io.read().stderr, /differs from the reviewed/i);
    } finally {
      process.env.PATH = originalPath;
      await rm(runtime, { recursive: true, force: true });
    }
  });
});

test("commit refuses an index change after authorization", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "first\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async authorize() {
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

test("commit refuses a HEAD change after authorization", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async authorize() {
        await git(root, "commit", "--quiet", "-m", "parallel commit");
        return true;
      },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "parallel commit");
    assert.match(io.read().stderr, /HEAD changed/i);
  });
});

test("commit refuses a HEAD change between its final reads", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-head-race-"));
    const realGit = (await execFile("which", ["git"])).stdout.trim();
    const trigger = join(runtime, "move-head");
    const wrapper = join(runtime, "git");
    await writeFile(wrapper, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, unlinkSync } = require("node:fs");
const realGit = ${JSON.stringify(realGit)};
const trigger = ${JSON.stringify(trigger)};
const args = process.argv.slice(2);
function run(...gitArgs) {
  const result = spawnSync(realGit, ["-C", args[1], ...gitArgs], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}
if (existsSync(trigger) && args[2] === "rev-parse" && args[3] === "--symbolic-full-name") {
  unlinkSync(trigger);
  const head = run("rev-parse", "HEAD");
  const tree = run("rev-parse", "HEAD^{tree}");
  const ref = run("symbolic-ref", "HEAD");
  const moved = run("commit-tree", tree, "-p", head, "-m", "parallel move");
  run("update-ref", ref, moved, head);
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    await chmod(wrapper, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${runtime}:${originalPath}`;
    try {
      const io = output();
      const code = await commitModule.commitCommand(root, io, {
        async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
        async authorize() { await writeFile(trigger, "ready"); return true; },
      });
      assert.equal(code, 3);
      assert.equal(await git(root, "log", "-1", "--format=%s"), "parallel move");
      assert.match(io.read().stderr, /HEAD changed/i);
    } finally {
      process.env.PATH = originalPath;
      await rm(runtime, { recursive: true, force: true });
    }
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
      async authorize() {
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

test("commit refuses blank, trailing-whitespace, control-character, or malformed Unicode proposals before authorization", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    for (const proposal of [
      { subject: "   ", summary: "Updates the fixture." },
      { subject: "fix: update fixture ", summary: "Updates the fixture." },
      { subject: "fix: update fixture", summary: " Updates the fixture." },
      { subject: "fix: update fixture", summary: "Updates the fixture. " },
      { subject: "fix: update fixture", summary: "\u001b[31mUpdates the fixture." },
      { subject: "fix: update fixture\ud800", summary: "Updates the fixture." },
      { subject: "fix: update fixture", summary: "Updates the fixture\udc00." },
    ]) {
      const io = output();
      let authorized = false;
      const code = await commitModule.commitCommand(root, io, {
        async propose() { return proposal; },
        async authorize() { authorized = true; return true; },
      });
      assert.equal(code, 1);
      assert.equal(authorized, false);
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
      async authorize() { return true; },
    });
    assert.equal(code, 1);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "hook changed subject");
    assert.match(io.read().stderr, /differs from the reviewed/i);
  });
});

test("commit reports a body rewritten by a Git hook", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const hook = join(root, ".git", "hooks", "commit-msg");
    await writeFile(hook, "#!/bin/sh\nprintf '\\nHook changed body.\\n' >> \"$1\"\n");
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() {
        return {
          subject: "fix: update fixture",
          summary: "Updates the fixture.",
        };
      },
      async authorize() { return true; },
    });
    assert.equal(code, 1);
    assert.equal(await git(root, "log", "-1", "--format=%s"), "fix: update fixture");
    assert.match(await git(root, "log", "-1", "--format=%B"), /Hook changed body/);
    assert.match(io.read().stderr, /differs from the reviewed/i);
  });
});

test("commit shows the output of a rejecting pre-commit hook and says no commit was created", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const before = await git(root, "rev-parse", "HEAD");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nprintf '\\033[0G\\r\\033[2K\\033[1mprettier\\033[22m  tracked.txt  .trunk/out/abc.yaml\\r\\n\\033[91m\\342\\234\\226 1 failure\\033[0m\\n' >&2\nexit 1\n");
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async authorize() { return true; },
    });
    assert.equal(code, 3);
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
    const { stderr } = io.read();
    assert.match(stderr, /no commit was created/i);
    assert.match(stderr, /hook/i);
    assert.match(stderr, /prettier {2}tracked\.txt {2}\.trunk\/out\/abc\.yaml\n/);
    assert.match(stderr, /✖ 1 failure\n/);
    assert.doesNotMatch(stderr, /\x1b|\r|\\x1B/);
    assert.doesNotMatch(stderr, /commit may exist/i);
  });
});

test("commit says when a rejecting pre-commit hook printed nothing", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async authorize() { return true; },
    });
    assert.equal(code, 3);
    const { stderr } = io.read();
    assert.match(stderr, /no commit was created/i);
    assert.match(stderr, /printed no output/i);
  });
});

test("commit does not claim silence when hook output exceeds the capture limit", async () => {
  assert.notEqual(commitModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "staged\n");
    await git(root, "add", "tracked.txt");
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nhead -c 17000000 /dev/zero | tr '\\000' a >&2\nexit 1\n");
    await chmod(hook, 0o700);
    const io = output();
    const code = await commitModule.commitCommand(root, io, {
      async propose() { return { subject: "fix: update fixture", summary: "Updates the fixture." }; },
      async authorize() { return true; },
    });
    assert.equal(code, 3);
    const { stderr } = io.read();
    assert.doesNotMatch(stderr, /printed no output/i);
    assert.match(stderr, /output was not captured/i);
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
      async authorize() { return true; },
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

test("the shared Codex runner preserves the commit tool-use refusal", async () => {
  assert.equal(typeof commitModule?.runCodex, "function");
  const runtime = await mkdtemp(join(tmpdir(), "andrew-agent-commit-tool-refusal-"));
  const binary = join(runtime, "fake-codex");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n  process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution" } }) + "\\n");\n  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }) + "\\n");\n  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");\n});\n`,
  );
  await chmod(binary, 0o700);
  try {
    await assert.rejects(
      commitModule.runCodex(binary, runtime, runtime, "test prompt", 1_200),
      /Codex attempted to use a tool during commit proposal/,
    );
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
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
