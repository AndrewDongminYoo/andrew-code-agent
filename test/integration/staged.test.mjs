import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const stagedModule = await import("../../dist/git/staged.js").catch(() => null);

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

async function rawGit(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-staged-"));
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

test("the staged reader returns an empty patch when nothing is staged", async () => {
  assert.notEqual(stagedModule, null, "the built staged reader must exist");
  await withRepository(async (root) => {
    const staged = await stagedModule.readStagedChanges(root);
    assert.equal(staged.patch, "");
    assert.deepEqual(staged.paths, []);
    assert.match(staged.indexDigest, /^[0-9a-f]{64}$/);
    assert.equal(staged.head, await git(root, "rev-parse", "HEAD"));
  });
});

test("the staged reader returns the same staged patch that commit reads", async () => {
  assert.notEqual(stagedModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    const staged = await stagedModule.readStagedChanges(root);
    assert.deepEqual(staged.paths, ["tracked.txt"]);
    assert.equal(staged.patch, await rawGit(root, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--"));
    assert.equal(staged.index, await rawGit(root, "ls-files", "--stage", "-z"));
    assert.equal(staged.headRef, (await git(root, "symbolic-ref", "HEAD")));
  });
});

test("the staged reader names a detached HEAD", async () => {
  assert.notEqual(stagedModule, null);
  await withRepository(async (root) => {
    await git(root, "switch", "--quiet", "--detach");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    const staged = await stagedModule.readStagedChanges(root);
    assert.equal(staged.headRef, "HEAD");
  });
});

test("the staged reader refuses a merge in progress with a typed reason", async () => {
  assert.notEqual(stagedModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, ".git", "MERGE_HEAD"), `${await git(root, "rev-parse", "HEAD")}\n`);
    await assert.rejects(stagedModule.readStagedChanges(root), (error) => error instanceof stagedModule.StagedInputError && error.reason === "MERGE_IN_PROGRESS");
  });
});

test("the staged reader refuses an unresolved conflict entry with a typed reason", async () => {
  assert.notEqual(stagedModule, null);
  await withRepository(async (root) => {
    await writeFile(join(root, "ours.txt"), "ours\n");
    await writeFile(join(root, "theirs.txt"), "theirs\n");
    const ours = await git(root, "hash-object", "-w", "ours.txt");
    const theirs = await git(root, "hash-object", "-w", "theirs.txt");
    await git(root, "update-index", "--force-remove", "tracked.txt");
    await execFile("sh", ["-c", `printf '100644 ${ours} 2\\ttracked.txt\\n100644 ${theirs} 3\\ttracked.txt\\n' | git -C "$1" update-index --index-info`, "sh", root]);
    await assert.rejects(stagedModule.readStagedChanges(root), (error) => error instanceof stagedModule.StagedInputError && error.reason === "UNRESOLVED_CONFLICT");
  });
});

test("the staged reader refuses a staged gitlink with a typed reason", async () => {
  assert.notEqual(stagedModule, null);
  await withRepository(async (root) => {
    const head = await git(root, "rev-parse", "HEAD");
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${head},module`);
    await assert.rejects(stagedModule.readStagedChanges(root), (error) => error instanceof stagedModule.StagedInputError && error.reason === "STAGED_SUBMODULE");
  });
});
