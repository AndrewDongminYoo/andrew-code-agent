import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const cleanGoneModule = await import("../../dist/commands/clean-gone.js").catch(() => null);

async function git(root, ...args) {
  return (await execFile("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "-C", root, ...args])).stdout.trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(root, name) {
  try {
    await git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

// A clone with a local bare remote, `main` pushed, and origin/HEAD pointing at
// origin/main, which is the shape every fixture below starts from.
async function withClone(run) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-clean-gone-")));
  try {
    const remote = join(base, "remote.git");
    const root = join(base, "work");
    await execFile("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
    await execFile("git", ["init", "--quiet", "--initial-branch=main", root]);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "chore: initial fixture");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "--quiet", "-u", "origin", "main");
    await git(root, "remote", "set-head", "origin", "main");
    await run({ base, root });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// Creates `name` with one commit, pushes it with an upstream, optionally merges
// it into main, then deletes the remote branch and prunes, leaving `[gone]`.
async function goneBranch(root, name, { merge = true } = {}) {
  await git(root, "switch", "--quiet", "-c", name, "main");
  await writeFile(join(root, `${name}.txt`), `${name}\n`);
  await git(root, "add", `${name}.txt`);
  await git(root, "commit", "--quiet", "-m", `feat: ${name}`);
  await git(root, "push", "--quiet", "-u", "origin", name);
  await git(root, "switch", "--quiet", "main");
  if (merge) {
    await git(root, "merge", "--quiet", "--no-ff", "-m", `Merge ${name}`, name);
    await git(root, "push", "--quiet", "origin", "main");
  }
  await git(root, "push", "--quiet", "origin", "--delete", name);
  await git(root, "fetch", "--quiet", "--prune");
  return await git(root, "rev-parse", name);
}

function output({ tty = true } = {}) {
  let stdout = "";
  let stderr = "";
  return {
    stdin: { isTTY: tty },
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    read() { return { stdout, stderr }; },
  };
}

test("a gone branch without a worktree is deleted", async () => {
  assert.notEqual(cleanGoneModule, null, "the built clean-gone command must exist");
  await withClone(async ({ root }) => {
    await goneBranch(root, "feature-a");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-a"), false);
    assert.match(io.read().stdout, /feature-a/);
    assert.match(io.read().stdout, /Deleted branch feature-a/);
  });
});

test("a gone branch with a clean worktree has the worktree removed and is then deleted", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-b");
    const worktree = join(base, "wt-b");
    await git(root, "worktree", "add", "--quiet", worktree, "feature-b");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await exists(worktree), false);
    assert.equal(await branchExists(root, "feature-b"), false);
    assert.match(io.read().stdout, /Removed worktree/);
  });
});

test("a gone branch whose worktree has an untracked file is refused and the file remains", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-c");
    const worktree = join(base, "wt-c");
    await git(root, "worktree", "add", "--quiet", worktree, "feature-c");
    await writeFile(join(worktree, "notes.txt"), "keep me\n");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await readFile(join(worktree, "notes.txt"), "utf8"), "keep me\n");
    assert.equal(await branchExists(root, "feature-c"), true);
    assert.match(io.read().stdout, /feature-c.*WORKTREE_DIRTY/);
  });
});

test("the current branch is refused even when its upstream is gone", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await goneBranch(root, "feature-d");
    await git(root, "switch", "--quiet", "feature-d");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-d"), true);
    assert.match(io.read().stdout, /feature-d.*CURRENT_BRANCH/);
  });
});

test("a branch checked out in the main worktree is refused when run from a linked worktree", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-m");
    await git(root, "switch", "--quiet", "feature-m");
    const linked = join(base, "wt-main");
    await git(root, "worktree", "add", "--quiet", "--detach", linked, "main");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(linked, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-m"), true);
    assert.match(io.read().stdout, /feature-m.*MAIN_WORKTREE/);
  });
});

test("a gone branch reachable only from another feature branch is refused as not on the default branch", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await goneBranch(root, "topic", { merge: false });
    await git(root, "switch", "--quiet", "-c", "other", "topic");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "topic"), true);
    assert.match(io.read().stdout, /topic.*NOT_ON_DEFAULT/);
  });
});

test("a merged gone branch not reachable from the current HEAD is refused before any deletion", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await git(root, "switch", "--quiet", "-c", "older", "main");
    await goneBranch(root, "feature-n");
    await git(root, "switch", "--quiet", "older");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-n"), true);
    assert.match(io.read().stdout, /feature-n.*NOT_MERGED/);
  });
});

test("a locked worktree and a missing worktree directory are refused", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-l");
    await goneBranch(root, "feature-x");
    await git(root, "worktree", "add", "--quiet", "--lock", join(base, "wt-l"), "feature-l");
    const missing = join(base, "wt-x");
    await git(root, "worktree", "add", "--quiet", missing, "feature-x");
    await rm(missing, { recursive: true, force: true });
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-l"), true);
    assert.equal(await branchExists(root, "feature-x"), true);
    assert.match(io.read().stdout, /feature-l.*WORKTREE_LOCKED/);
    assert.match(io.read().stdout, /feature-x.*WORKTREE_MISSING/);
  });
});

test("an unresolvable origin/HEAD deletes nothing and exits 3", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await goneBranch(root, "feature-e");
    await git(root, "remote", "set-head", "origin", "--delete");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 3);
    assert.equal(await branchExists(root, "feature-e"), true);
    assert.match(io.read().stderr, /origin\/HEAD/);
  });
});

test("piped input prints the preview and deletes nothing", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await goneBranch(root, "feature-f");
    const io = output({ tty: false });
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-f"), true);
    assert.match(io.read().stdout, /feature-f/);
    assert.match(io.read().stdout, /nothing was deleted/i);
  });
});

test("the preview lists ignored entries of a worktree before it is removed", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await writeFile(join(root, ".gitignore"), "secret.env\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "--quiet", "-m", "chore: ignore secrets");
    await git(root, "push", "--quiet", "origin", "main");
    await goneBranch(root, "feature-g");
    const worktree = join(base, "wt-g");
    await git(root, "worktree", "add", "--quiet", worktree, "feature-g");
    await writeFile(join(worktree, "secret.env"), "TOKEN=fixture\n");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    const stdout = io.read().stdout;
    assert.ok(stdout.indexOf("secret.env") >= 0 && stdout.indexOf("secret.env") < stdout.indexOf("Removed worktree"), stdout);
    assert.match(stdout, /Ignored entries \(1\)/);
    assert.equal(await exists(worktree), false);
  });
});

test("a branch whose tip moves between the preview and deletion is refused", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await goneBranch(root, "feature-h");
    const moved = await git(root, "rev-parse", "main~1");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io, {
      async authorize() {
        await git(root, "update-ref", "refs/heads/feature-h", moved);
        return true;
      },
    });
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await git(root, "rev-parse", "feature-h"), moved);
    assert.match(io.read().stdout, /feature-h.*CHANGED_SINCE_PREVIEW/);
  });
});

test("an untracked file counts as dirty even when status.showUntrackedFiles is no", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-u");
    await git(root, "config", "status.showUntrackedFiles", "no");
    const worktree = join(base, "wt-u");
    await git(root, "worktree", "add", "--quiet", worktree, "feature-u");
    await writeFile(join(worktree, "work-in-progress.txt"), "keep me\n");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await readFile(join(worktree, "work-in-progress.txt"), "utf8"), "keep me\n");
    assert.equal(await branchExists(root, "feature-u"), true);
    assert.match(io.read().stdout, /feature-u.*WORKTREE_DIRTY/);
  });
});

test("tracked edits hidden by assume-unchanged or skip-worktree keep their worktree", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-v");
    await goneBranch(root, "feature-w");
    const assumed = join(base, "wt-v");
    const skipped = join(base, "wt-w");
    await git(root, "worktree", "add", "--quiet", assumed, "feature-v");
    await git(root, "worktree", "add", "--quiet", skipped, "feature-w");
    await git(assumed, "update-index", "--assume-unchanged", "tracked.txt");
    await writeFile(join(assumed, "tracked.txt"), "hidden edit\n");
    await git(skipped, "update-index", "--skip-worktree", "tracked.txt");
    await writeFile(join(skipped, "tracked.txt"), "hidden edit\n");
    assert.equal(await git(assumed, "status", "--porcelain"), "", "the fixture must hide the edit from status");
    assert.equal(await git(skipped, "status", "--porcelain"), "", "the fixture must hide the edit from status");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await readFile(join(assumed, "tracked.txt"), "utf8"), "hidden edit\n");
    assert.equal(await readFile(join(skipped, "tracked.txt"), "utf8"), "hidden edit\n");
    assert.match(io.read().stdout, /feature-v.*WORKTREE_DIRTY/);
    assert.match(io.read().stdout, /feature-w.*WORKTREE_DIRTY/);
  });
});

test("a worktree that gains an untracked or ignored file after the preview is kept", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await writeFile(join(root, ".gitignore"), "*.env\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "--quiet", "-m", "chore: ignore env files");
    await git(root, "push", "--quiet", "origin", "main");
    await goneBranch(root, "feature-i");
    await goneBranch(root, "feature-t");
    const ignoredWorktree = join(base, "wt-i");
    const untrackedWorktree = join(base, "wt-t");
    await git(root, "worktree", "add", "--quiet", ignoredWorktree, "feature-i");
    await git(root, "worktree", "add", "--quiet", untrackedWorktree, "feature-t");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io, {
      async authorize() {
        await writeFile(join(ignoredWorktree, "prod.env"), "TOKEN=fixture\n");
        await writeFile(join(untrackedWorktree, "notes.txt"), "keep me\n");
        return true;
      },
    });
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await readFile(join(ignoredWorktree, "prod.env"), "utf8"), "TOKEN=fixture\n");
    assert.equal(await readFile(join(untrackedWorktree, "notes.txt"), "utf8"), "keep me\n");
    assert.match(io.read().stdout, /feature-i.*CHANGED_SINCE_PREVIEW/);
    assert.match(io.read().stdout, /feature-t.*CHANGED_SINCE_PREVIEW/);
  });
});

test("a branch being rebased in a worktree is kept and later candidates are still deleted", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ base, root }) => {
    await goneBranch(root, "feature-r");
    await goneBranch(root, "feature-s");
    const worktree = join(base, "wt-r");
    await git(root, "worktree", "add", "--quiet", worktree, "feature-r");
    await assert.rejects(git(worktree, "rebase", "--quiet", "-x", "false", "HEAD~1"));
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "feature-r"), true);
    assert.equal(await exists(worktree), true);
    assert.equal(await branchExists(root, "feature-s"), false);
    assert.match(io.read().stdout, /feature-r.*WORKTREE_IN_PROGRESS/);
  });
});

test("no gone branch exits successfully without deleting anything", async () => {
  assert.notEqual(cleanGoneModule, null);
  await withClone(async ({ root }) => {
    await git(root, "branch", "local-only");
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(root, io);
    assert.equal(code, 0, io.read().stderr);
    assert.equal(await branchExists(root, "local-only"), true);
    assert.match(io.read().stdout, /No branches with a gone upstream/);
  });
});

test("a directory outside a Git repository exits 3", async () => {
  assert.notEqual(cleanGoneModule, null);
  const outside = await mkdtemp(join(tmpdir(), "andrew-agent-clean-gone-outside-"));
  try {
    const io = output();
    const code = await cleanGoneModule.cleanGoneCommand(outside, io);
    assert.equal(code, 3);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
