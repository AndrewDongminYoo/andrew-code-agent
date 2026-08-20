import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  mkdir,
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
const gitModule = await import("../../dist/runtime/git.js").catch(() => null);

function requireGit() {
  assert.notEqual(
    gitModule,
    null,
    "the built runtime git module must be available",
  );
  return gitModule;
}

async function git(repository, args) {
  return execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function withRepository(run) {
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-git-")),
  );
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await git(repository, ["config", "user.name", "Test User"]);
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "initial"]);
  try {
    await run(repository);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

test("captures a clean nested worktree exactly without mutation", async () => {
  await withRepository(async (repository) => {
    const nested = join(repository, "nested");
    await mkdir(nested);
    const before = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;
    const head = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const snapshot = await requireGit().readGitSnapshot(nested);
    const after = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;

    assert.deepEqual(snapshot, {
      repositoryRoot: repository,
      head,
      porcelainV2: before,
      clean: true,
    });
    assert.equal(after, before);
    assert.equal(await requireGit().resolveRepositoryRoot(nested), repository);
    assert.equal(requireGit().assertCleanGitSnapshot(snapshot), snapshot);
  });
});

test("reports tracked, staged, and untracked bytes and preserves an untracked canary", async () => {
  await withRepository(async (repository) => {
    await writeFile(join(repository, "tracked.txt"), "changed\n");
    let snapshot = await requireGit().readGitSnapshot(repository);
    assert.equal(snapshot.clean, false);
    assert.match(snapshot.porcelainV2, /^1 \.M /m);

    await git(repository, ["add", "tracked.txt"]);
    snapshot = await requireGit().readGitSnapshot(repository);
    assert.match(snapshot.porcelainV2, /^1 M\. /m);

    const canaryPath = join(repository, "untracked-canary.txt");
    await writeFile(canaryPath, "do not mutate\n");
    const beforeStatus = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;
    await assert.rejects(
      async () =>
        requireGit().assertCleanGitSnapshot(
          await requireGit().readGitSnapshot(repository),
        ),
      { code: "GIT_WORKTREE_DIRTY" },
    );
    assert.equal(await readFile(canaryPath, "utf8"), "do not mutate\n");
    assert.equal(
      (
        await git(repository, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ])
      ).stdout,
      beforeStatus,
    );
  });
});

test("rejects a non-worktree and accepts a later clean changed HEAD", async () => {
  const outside = await mkdtemp(join(tmpdir(), "andrew-agent-not-git-"));
  try {
    await assert.rejects(requireGit().resolveRepositoryRoot(outside), {
      code: "NOT_GIT_REPOSITORY",
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }

  await withRepository(async (repository) => {
    const first = await requireGit().readGitSnapshot(repository);
    await writeFile(join(repository, "second.txt"), "second\n");
    await git(repository, ["add", "second.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "second"]);
    const second = await requireGit().readGitSnapshot(repository);
    assert.notEqual(second.head, first.head);
    assert.equal(second.clean, true);
  });
});
