import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
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
const stagedReviewModule = await import("../../dist/commands/staged-review.js").catch(() => null);

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
}

async function rawGit(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;
}

async function withRepository(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-staged-review-")));
  try {
    await git(root, "init", "--quiet", "--initial-branch=main");
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

async function withStateRoot(run) {
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-staged-state-")));
  try {
    await run(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function sourceIdentity(root) {
  return {
    head: await git(root, "rev-parse", "HEAD"),
    index: await rawGit(root, "ls-files", "--stage", "-z"),
    applyPatch: await stagedReviewModule.readApplyPatch(root),
  };
}

// Either the checkout reproduces the source index exactly, or the build is
// refused as a mismatch. Reviewing altered content is the one forbidden outcome.
async function assertMatchOrMismatch(root, stateRoot) {
  const identity = await sourceIdentity(root);
  let checkout;
  try {
    checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
  } catch (error) {
    assert.ok(error instanceof stagedReviewModule.StagedCheckoutMismatchError, String(error));
    return;
  }
  assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
}

test("the staged checkout carries staged content only", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function", "the built staged checkout must exist");
  await withRepository(async (root) => {
    await writeFile(join(root, "keep.txt"), "a\nb\n");
    await writeFile(join(root, "gone.txt"), "x\n");
    await writeFile(join(root, "old.txt"), "r\nr\nr\nr\n");
    await writeFile(join(root, "run.sh"), "s\n");
    await writeFile(join(root, "bin.dat"), randomBytes(300));
    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "chore: add boundary fixture");
    await writeFile(join(root, "keep.txt"), "a\nB\n");
    await git(root, "rm", "--quiet", "gone.txt");
    await git(root, "mv", "old.txt", "new.txt");
    await chmod(join(root, "run.sh"), 0o755);
    await writeFile(join(root, "bin.dat"), randomBytes(300));
    await writeFile(join(root, "added.txt"), "n\n");
    await git(root, "add", "-A");
    await writeFile(join(root, "keep.txt"), "a\nB\nunstaged\n");
    await writeFile(join(root, "untracked.txt"), "u\n");
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      const checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
      assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
      assert.equal(await git(checkout, "rev-parse", "HEAD"), identity.head);
      assert.equal(await readFile(join(checkout, "keep.txt"), "utf8"), "a\nB\n");
      assert.equal(await readFile(join(checkout, "new.txt"), "utf8"), "r\nr\nr\nr\n");
      await assert.rejects(readFile(join(checkout, "untracked.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(join(checkout, "gone.txt")), { code: "ENOENT" });
      await execFile("git", ["-C", checkout, "diff", "--quiet"]);
      assert.equal(await git(checkout, "ls-files", "--others"), "");
    });
  });
});

test("an intent-to-add entry makes the staged checkout a mismatch and leaves no checkout", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    await writeFile(join(root, "ita.txt"), "intent\n");
    await git(root, "add", "-N", "ita.txt");
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      await assert.rejects(stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity), (error) => error instanceof stagedReviewModule.StagedCheckoutMismatchError && error.message === stagedReviewModule.STAGED_MISMATCH_MESSAGE);
      assert.equal(stagedReviewModule.STAGED_MISMATCH_MESSAGE, "Staged checkout does not match the index. Intent-to-add entries from git add -N are one known cause.");
      assert.deepEqual((await readdir(stateRoot)).filter((entry) => entry.startsWith("review-")), []);
    });
  });
});

test("the staged checkout ignores source diff prefix and color settings", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await git(root, "config", "diff.noprefix", "true");
    await git(root, "config", "color.ui", "always");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      const checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
      assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
    });
  });
});

test("the staged checkout applies a quoted path with a space and a non-ASCII character", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "ä b.txt"), "quoted\n");
    await git(root, "add", "dir");
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      const checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
      assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
      assert.equal(await readFile(join(checkout, "dir", "ä b.txt"), "utf8"), "quoted\n");
    });
  });
});

test("the staged checkout applies a case-only rename", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "Foo.txt"), "case\n");
    await git(root, "add", "Foo.txt");
    await git(root, "commit", "--quiet", "-m", "chore: add mixed-case file");
    await git(root, "mv", "Foo.txt", "foo.txt");
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      const checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
      assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
      assert.ok((await readdir(checkout)).includes("foo.txt"));
      assert.equal(await readFile(join(checkout, "foo.txt"), "utf8"), "case\n");
    });
  });
});

test("a path name that is not UTF-8 never reaches review renamed", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await git(root, "config", "core.quotePath", "false");
    await writeFile(join(root, "blob.txt"), "latin1 path\n");
    const blob = await git(root, "hash-object", "-w", "blob.txt");
    await execFile("sh", ["-c", `printf '100644 ${blob} 0\\tcaf\\351.txt\\n' | git -C "$1" update-index --index-info`, "sh", root]);
    await withStateRoot(async (stateRoot) => {
      const identity = await sourceIdentity(root);
      let checkout;
      try {
        checkout = await stagedReviewModule.createStagedReviewCheckout(root, stateRoot, identity);
      } catch (error) {
        assert.ok(error instanceof stagedReviewModule.StagedCheckoutMismatchError, String(error));
        return;
      }
      const source = (await execFile("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "buffer" })).stdout;
      const copied = (await execFile("git", ["-C", checkout, "ls-files", "--stage", "-z"], { encoding: "buffer" })).stdout;
      assert.ok(source.equals(copied), "the checkout listing must equal the source listing byte for byte");
    });
  });
});

test("a staged text file that is not UTF-8 never reaches review altered", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await git(root, "add", "latin1.txt");
    await withStateRoot(async (stateRoot) => {
      await assertMatchOrMismatch(root, stateRoot);
    });
  });
});

test("line-ending attributes never let altered content reach review", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, ".gitattributes"), "* text=auto eol=crlf\n");
    await git(root, "add", ".gitattributes");
    await git(root, "commit", "--quiet", "-m", "chore: add attributes");
    await writeFile(join(root, "tracked.txt"), "after\nsecond\n");
    await git(root, "add", "tracked.txt");
    await withStateRoot(async (stateRoot) => {
      await assertMatchOrMismatch(root, stateRoot);
    });
  });
});

test("the staged checkout builds from a shallow source", async () => {
  assert.equal(typeof stagedReviewModule?.createStagedReviewCheckout, "function");
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "second\n");
    await git(root, "commit", "--quiet", "-am", "chore: second commit");
    const clone = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-staged-shallow-")));
    try {
      await execFile("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, clone]);
      assert.equal(await git(clone, "rev-parse", "--is-shallow-repository"), "true");
      await writeFile(join(clone, "tracked.txt"), "staged in clone\n");
      await git(clone, "add", "tracked.txt");
      await withStateRoot(async (stateRoot) => {
        const identity = await sourceIdentity(clone);
        const checkout = await stagedReviewModule.createStagedReviewCheckout(clone, stateRoot, identity);
        assert.equal(await rawGit(checkout, "ls-files", "--stage", "-z"), identity.index);
      });
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });
});

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    read() { return { stdout, stderr }; },
  };
}

function recordingReview(response = "No findings.") {
  const calls = [];
  return {
    calls,
    dependencies: {
      async review(input) {
        calls.push(input);
        return response;
      },
    },
  };
}

async function stageTrackedChange(root, content = "after\n") {
  await writeFile(join(root, "tracked.txt"), content);
  await git(root, "add", "tracked.txt");
}

async function withFakeCodex(root, run) {
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-staged-runtime-")));
  const stateRoot = join(runtime, "state");
  const record = join(runtime, "record.json");
  const binary = join(runtime, "codex");
  const script = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), untrackedVisible: existsSync("untracked.txt"), input }));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "No findings." } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  const environment = {
    ANDREW_AGENT_CODEX_SOURCE: process.env.ANDREW_AGENT_CODEX_SOURCE,
    ANDREW_AGENT_STATE_ROOT: process.env.ANDREW_AGENT_STATE_ROOT,
    ANDREW_AGENT_CODEX_BIN: process.env.ANDREW_AGENT_CODEX_BIN,
  };
  process.env.ANDREW_AGENT_CODEX_SOURCE = root;
  process.env.ANDREW_AGENT_STATE_ROOT = stateRoot;
  process.env.ANDREW_AGENT_CODEX_BIN = binary;
  try {
    await run({ stateRoot, record });
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(runtime, { recursive: true, force: true });
  }
}

test("staged review reports the staged identity and the review response", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function", "the built staged review command must exist");
  await withRepository(async (root) => {
    await stageTrackedChange(root);
    const head = await git(root, "rev-parse", "HEAD");
    const io = output();
    const review = recordingReview("## Findings\n\nNo findings.");
    const code = await stagedReviewModule.stagedReviewCommand(root, io, review.dependencies);
    assert.equal(code, 0);
    assert.equal(review.calls.length, 1);
    const [input] = review.calls;
    assert.deepEqual(input.paths, ["tracked.txt"]);
    assert.equal(input.headRef, "refs/heads/main");
    assert.equal(input.head, head);
    assert.match(input.prompt, /git diff --cached/);
    assert.match(input.prompt, /changed path and line/);
    assert.match(input.prompt, new RegExp(head));
    assert.equal(io.read().stdout, `Reviewing staged changes on refs/heads/main (${head}).\n## Findings\n\nNo findings.\n`);
    assert.equal(io.read().stderr, "");
  });
});

test("staged review runs with unstaged and untracked content present", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  await withRepository(async (root) => {
    await stageTrackedChange(root);
    await writeFile(join(root, "tracked.txt"), "after\nunstaged\n");
    await writeFile(join(root, "untracked.txt"), "u\n");
    const review = recordingReview();
    assert.equal(await stagedReviewModule.stagedReviewCommand(root, output(), review.dependencies), 0);
    assert.equal(review.calls.length, 1);
  });
});

test("staged review skips Codex when nothing is staged, including an intent-to-add entry alone", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  for (const setup of ["nothing", "intent-to-add"]) {
    await withRepository(async (root) => {
      if (setup === "intent-to-add") {
        await writeFile(join(root, "ita.txt"), "intent\n");
        await git(root, "add", "-N", "ita.txt");
      }
      const io = output();
      const review = recordingReview();
      assert.equal(await stagedReviewModule.stagedReviewCommand(root, io, review.dependencies), 0, setup);
      assert.equal(review.calls.length, 0, setup);
      assert.equal(io.read().stdout, "No staged changes to review.\n", setup);
    });
  }
});

test("staged review refuses a merge, a conflict entry, and a staged submodule before Codex", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  const cases = [
    ["merge", "Complete or abort the merge before reviewing staged changes.\n"],
    ["conflict", "Resolve merge conflicts before reviewing staged changes.\n"],
    ["submodule", "Staged submodules are unsupported.\n"],
  ];
  for (const [setup, message] of cases) {
    await withRepository(async (root) => {
      const head = await git(root, "rev-parse", "HEAD");
      if (setup === "merge") {
        await stageTrackedChange(root);
        await writeFile(join(root, ".git", "MERGE_HEAD"), `${head}\n`);
      } else if (setup === "conflict") {
        await writeFile(join(root, "ours.txt"), "ours\n");
        await writeFile(join(root, "theirs.txt"), "theirs\n");
        const ours = await git(root, "hash-object", "-w", "ours.txt");
        const theirs = await git(root, "hash-object", "-w", "theirs.txt");
        await git(root, "update-index", "--force-remove", "tracked.txt");
        await execFile("sh", ["-c", `printf '100644 ${ours} 2\\ttracked.txt\\n100644 ${theirs} 3\\ttracked.txt\\n' | git -C "$1" update-index --index-info`, "sh", root]);
      } else {
        await git(root, "update-index", "--add", "--cacheinfo", `160000,${head},module`);
      }
      const io = output();
      const review = recordingReview();
      assert.equal(await stagedReviewModule.stagedReviewCommand(root, io, review.dependencies), 3, setup);
      assert.equal(review.calls.length, 0, setup);
      assert.equal(io.read().stderr, message, setup);
    });
  }
});

test("staged review discards the response when HEAD or the index moves, and keeps it for an unstaged edit", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  for (const race of ["head", "index", "patch", "unstaged"]) {
    await withRepository(async (root) => {
      await stageTrackedChange(root);
      const io = output();
      const code = await stagedReviewModule.stagedReviewCommand(root, io, {
        async review() {
          if (race === "head") {
            await git(root, "commit", "--quiet", "-m", "fix: move head");
          } else if (race === "index") {
            await writeFile(join(root, "later.txt"), "later\n");
            await git(root, "add", "later.txt");
          } else if (race === "patch") {
            await stageTrackedChange(root, "third\n");
          } else {
            await writeFile(join(root, "tracked.txt"), "after\nunstaged\n");
          }
          return "reviewed output";
        },
      });
      if (race === "unstaged") {
        assert.equal(code, 0, race);
        assert.match(io.read().stdout, /reviewed output/);
      } else {
        assert.equal(code, 3, race);
        assert.doesNotMatch(io.read().stdout, /reviewed output/, race);
        assert.equal(io.read().stderr, "Review inputs changed; run review again.\n", race);
      }
    });
  }
});

test("staged review runs on a detached HEAD", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  await withRepository(async (root) => {
    await git(root, "switch", "--quiet", "--detach");
    await stageTrackedChange(root);
    const head = await git(root, "rev-parse", "HEAD");
    const io = output();
    assert.equal(await stagedReviewModule.stagedReviewCommand(root, io, recordingReview().dependencies), 0);
    assert.match(io.read().stdout, new RegExp(`^Reviewing staged changes on HEAD \\(${head}\\)\\.\\n`));
  });
});

test("staged review refuses an unborn HEAD before Codex", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-staged-unborn-")));
  try {
    await git(root, "init", "--quiet");
    await writeFile(join(root, "first.txt"), "first\n");
    await git(root, "add", "first.txt");
    const io = output();
    const review = recordingReview();
    assert.equal(await stagedReviewModule.stagedReviewCommand(root, io, review.dependencies), 3);
    assert.equal(review.calls.length, 0);
    assert.equal(io.read().stderr, "Unable to prepare staged review.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged review bounds the prompt at 512 paths and counts the rest", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  await withRepository(async (root) => {
    await mkdir(join(root, "many"));
    for (let index = 0; index < 513; index += 1)
      await writeFile(join(root, "many", `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    await git(root, "add", "many");
    const review = recordingReview();
    assert.equal(await stagedReviewModule.stagedReviewCommand(root, output(), review.dependencies), 0);
    const metadata = JSON.parse(review.calls[0].prompt.split("\n\n").at(-1));
    assert.equal(metadata.paths.length, 512);
    assert.equal(metadata.omittedPathCount, 1);
    assert.equal(metadata.changedFileCount, 513);
  });
});

test("the default staged review path runs Codex outside the source and removes its checkout", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  await withRepository(async (root) => {
    await stageTrackedChange(root);
    await writeFile(join(root, "untracked.txt"), "u\n");
    await withFakeCodex(root, async ({ stateRoot, record }) => {
      const io = output();
      assert.equal(await stagedReviewModule.stagedReviewCommand(root, io), 0);
      const invocation = JSON.parse(await readFile(record, "utf8"));
      assert.notEqual(invocation.cwd, root);
      assert.equal(invocation.untrackedVisible, false);
      assert.match(io.read().stdout, /No findings\./);
      assert.equal((await readdir(stateRoot)).some((entry) => entry.startsWith("review-")), false);
    });
  });
});

test("the default staged review path stops at an intent-to-add mismatch before Codex", async () => {
  assert.equal(typeof stagedReviewModule?.stagedReviewCommand, "function");
  await withRepository(async (root) => {
    await stageTrackedChange(root);
    await writeFile(join(root, "ita.txt"), "intent\n");
    await git(root, "add", "-N", "ita.txt");
    await withFakeCodex(root, async ({ record }) => {
      const io = output();
      assert.equal(await stagedReviewModule.stagedReviewCommand(root, io), 3);
      assert.equal(io.read().stderr, "Staged checkout does not match the index. Intent-to-add entries from git add -N are one known cause.\n");
      await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });
    });
  });
});
