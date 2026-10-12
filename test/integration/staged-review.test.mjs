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
