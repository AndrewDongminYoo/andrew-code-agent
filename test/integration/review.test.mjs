import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const reviewModule = await import("../../dist/commands/review.js").catch(
  () => null,
);
const pathsModule = await import("../../dist/runtime/paths.js").catch(() => null);

async function git(root, ...args) {
  return (
    await execFile("git", ["-C", root, ...args], { encoding: "utf8" })
  ).stdout.trim();
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-review-"));
  try {
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "tracked.txt"), "before\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "chore: initial fixture");
    const base = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/main", base);
    await git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    await git(root, "switch", "--quiet", "-c", "feature");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "fix: change fixture");
    await run(root, base);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(value) {
        stdout += String(value);
        return true;
      },
    },
    stderr: {
      write(value) {
        stderr += String(value);
        return true;
      },
    },
    read() {
      return { stdout, stderr };
    },
  };
}

test("review resolves origin/HEAD and reports the exact three-dot comparison", async () => {
  assert.notEqual(reviewModule, null, "the built review command must exist");
  await withRepository(async (root, base) => {
    const io = output();
    let input;
    const code = await reviewModule.reviewCommand(root, undefined, io, {
      async review(value) {
        input = value;
        return "## Findings\n\nNo findings.\n\n## Missing verification\n\n- Tests were not run.";
      },
    });
    const head = await git(root, "rev-parse", "HEAD");
    assert.equal(code, 0);
    assert.equal(input.baseRef, "refs/remotes/origin/main");
    assert.equal(input.base, base);
    assert.equal(input.mergeBase, base);
    assert.equal(input.headRef, "refs/heads/feature");
    assert.equal(input.head, head);
    assert.deepEqual(input.paths, ["tracked.txt"]);
    assert.match(input.prompt, /changed path and line/);
    assert.match(input.prompt, /missing verification/i);
    assert.match(input.prompt, new RegExp(base));
    assert.equal(
      io.read().stdout,
      `Reviewing refs/heads/feature (${head}) against refs/remotes/origin/main (${base}).\nMerge base: ${base}.\n## Findings\n\nNo findings.\n\n## Missing verification\n\n- Tests were not run.\n`,
    );
    assert.equal(io.read().stderr, "");
  });
});

test("review accepts one explicit base ref", async () => {
  assert.notEqual(reviewModule, null);
  await withRepository(async (root, base) => {
    let input;
    const code = await reviewModule.reviewCommand(root, "main", output(), {
      async review(value) {
        input = value;
        return "No findings.";
      },
    });
    assert.equal(code, 0);
    assert.equal(input.baseRef, "main");
    assert.equal(input.base, base);
  });
});

test("review classifies runtime preparation failures as exit 3", async () => {
  assert.notEqual(reviewModule, null);
  assert.notEqual(pathsModule, null);
  await withRepository(async (root) => {
    const io = output();
    const error = new pathsModule.RuntimePathError(
      "CODEX_BINARY_NOT_FOUND",
      "fixture secret path",
    );
    const code = await reviewModule.reviewCommand(root, undefined, io, {
      async review() {
        throw error;
      },
    });
    assert.equal(code, 3);
    assert.match(io.read().stderr, /Review runtime preparation failed: CODEX_BINARY_NOT_FOUND\./);
    assert.doesNotMatch(io.read().stderr, /fixture secret path/);
  });
});

test("review skips Codex when the three-dot comparison is empty", async () => {
  assert.notEqual(reviewModule, null);
  await withRepository(async (root) => {
    await git(root, "switch", "--quiet", "main");
    const io = output();
    let invoked = false;
    const code = await reviewModule.reviewCommand(root, undefined, io, {
      async review() {
        invoked = true;
        return "unexpected";
      },
    });
    assert.equal(code, 0);
    assert.equal(invoked, false);
    assert.match(io.read().stdout, /No changes to review against refs\/remotes\/origin\/main\./);
  });
});

test("review rejects dirty and detached worktrees before Codex", async () => {
  assert.notEqual(reviewModule, null);
  await withRepository(async (root) => {
    for (const prepare of [
      async () => writeFile(join(root, "untracked.txt"), "dirty\n"),
      async () => git(root, "switch", "--quiet", "--detach"),
    ]) {
      await prepare();
      const io = output();
      let invoked = false;
      const code = await reviewModule.reviewCommand(root, undefined, io, {
        async review() {
          invoked = true;
          return "unexpected";
        },
      });
      assert.equal(code, 3);
      assert.equal(invoked, false);
      assert.notEqual(io.read().stderr, "");
      await rm(join(root, "untracked.txt"), { force: true });
      if ((await git(root, "branch", "--show-current")) === "") {
        await git(root, "switch", "--quiet", "feature");
      }
    }
  });
});

test("review discards stale output when HEAD, branch, base, or worktree moves", async () => {
  assert.notEqual(reviewModule, null);
  for (const race of ["head", "branch", "base", "worktree"]) {
    await withRepository(async (root) => {
      const io = output();
      const code = await reviewModule.reviewCommand(root, "main", io, {
        async review() {
          if (race === "head") {
            await writeFile(join(root, "later.txt"), "later\n");
            await git(root, "add", "later.txt");
            await git(root, "commit", "--quiet", "-m", "fix: move head");
          } else if (race === "branch") {
            await git(root, "switch", "--quiet", "-c", "other-feature");
          } else if (race === "worktree") {
            await writeFile(join(root, "later.txt"), "later\n");
          } else {
            await git(root, "branch", "-f", "main", "HEAD");
          }
          return "stale review output";
        },
      });
      assert.equal(code, 3, race);
      assert.doesNotMatch(io.read().stdout, /stale review output/);
      assert.match(io.read().stderr, /Review inputs changed; run review again\./);
    });
  }
});

test("Codex review uses an ephemeral read-only child in the provided review repository", async () => {
  assert.equal(typeof reviewModule?.runCodexReview, "function");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-review-child-")),
  );
  try {
    const record = join(root, "record.json");
    const binary = join(root, "codex");
    const script = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, input }));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "No findings." } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`;
    await writeFile(binary, script);
    await chmod(binary, 0o755);
    const base = "a".repeat(40);
    const result = await reviewModule.runCodexReview(
      binary,
      join(root, "codex-home"),
      root,
      base,
      "review prompt",
      1_200,
    );
    assert.equal(result, "No findings.");
    const invocation = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual(invocation.argv, [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "-C",
      root,
      "review",
      "--base",
      base,
      "-",
    ]);
    assert.equal(invocation.cwd, root);
    assert.equal(invocation.env.CODEX_HOME, join(root, "codex-home"));
    assert.equal(invocation.input, "review prompt");
    assert.equal(invocation.env.HOME, undefined);
    assert.equal(invocation.env.ANDREW_AGENT_CODEX_SOURCE, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the isolated review checkout contains committed content but no source worktree dirt", async () => {
  assert.equal(typeof reviewModule?.createReviewCheckout, "function");
  await withRepository(async (root, base) => {
    const stateRoot = await realpath(
      await mkdtemp(join(tmpdir(), "andrew-agent-review-state-")),
    );
    let checkout;
    try {
      await writeFile(join(root, "transient-secret.txt"), "source-only\n");
      const head = await git(root, "rev-parse", "HEAD");
      checkout = await reviewModule.createReviewCheckout(
        root,
        stateRoot,
        base,
        head,
      );
      assert.equal(await readFile(join(checkout, "tracked.txt"), "utf8"), "after\n");
      await assert.rejects(readFile(join(checkout, "transient-secret.txt"), "utf8"), { code: "ENOENT" });
      assert.equal(await git(checkout, "rev-parse", "HEAD"), head);
      assert.equal(await git(checkout, "cat-file", "-t", base), "commit");
      assert.equal(await git(checkout, "remote"), "");
    } finally {
      if (checkout !== undefined)
        await rm(checkout, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

test("the default review path excludes ignored source content and removes its checkout", async () => {
  assert.notEqual(reviewModule, null);
  await withRepository(async (root) => {
    const runtime = await realpath(
      await mkdtemp(join(tmpdir(), "andrew-agent-review-runtime-")),
    );
    const stateRoot = join(runtime, "state");
    const record = join(runtime, "record.json");
    const binary = join(runtime, "codex");
    const script = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), secretVisible: existsSync("ignored-secret.txt"), input }));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "No findings." } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`;
    await writeFile(binary, script);
    await chmod(binary, 0o755);
    await writeFile(join(root, ".git", "info", "exclude"), "ignored-secret.txt\n", { flag: "a" });
    await writeFile(join(root, "ignored-secret.txt"), "source-only\n");
    const environment = {
      ANDREW_AGENT_CODEX_SOURCE: process.env.ANDREW_AGENT_CODEX_SOURCE,
      ANDREW_AGENT_STATE_ROOT: process.env.ANDREW_AGENT_STATE_ROOT,
      ANDREW_AGENT_CODEX_BIN: process.env.ANDREW_AGENT_CODEX_BIN,
    };
    process.env.ANDREW_AGENT_CODEX_SOURCE = root;
    process.env.ANDREW_AGENT_STATE_ROOT = stateRoot;
    process.env.ANDREW_AGENT_CODEX_BIN = binary;
    try {
      const io = output();
      assert.equal(
        await reviewModule.reviewCommand(root, "main", io),
        0,
      );
      const invocation = JSON.parse(await readFile(record, "utf8"));
      assert.notEqual(invocation.cwd, root);
      assert.equal(invocation.secretVisible, false);
      assert.match(io.read().stdout, /No findings\./);
      assert.equal(
        (await readdir(stateRoot)).some((entry) => entry.startsWith("review-")),
        false,
      );
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
