import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const verifyFixModule = await import("../../dist/commands/verify-fix.js").catch(() => null);
const node = process.execPath;
const defaults = verifyFixModule === null ? {} : { timeoutMs: verifyFixModule.RUN_TIMEOUT_MS, outputLimitBytes: verifyFixModule.RUN_OUTPUT_LIMIT_BYTES, sandboxExecutable: verifyFixModule.SANDBOX_EXECUTABLE };

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(root, path), { force: true });
      continue;
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

// `base` is committed on main, `head` is applied on the feature branch; a
// null value deletes the path. `ignored` files are written after both commits
// and must be covered by a committed `.gitignore`.
async function withRepository({ base, head, ignored = {} }, run) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-"));
  try {
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFiles(root, base);
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "-m", "chore: initial fixture");
    const baseCommit = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/main", baseCommit);
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git(root, "switch", "--quiet", "-c", "feature");
    await writeFiles(root, head);
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "-m", "fix: change fixture");
    await writeFiles(root, ignored);
    assert.equal(await git(root, "status", "--porcelain"), "");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    read() { return { stdout, stderr }; },
  };
}

async function verify(root, options, dependencies = {}) {
  const io = output();
  const headBefore = await git(root, "rev-parse", "HEAD");
  const code = await verifyFixModule.verifyFixCommand(root, { withPaths: [], testPaths: [], ...options }, io, { ...defaults, ...dependencies });
  assert.equal(await git(root, "rev-parse", "HEAD"), headBefore, "the source HEAD must not move");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "", "the source worktree must stay clean");
  return { code, ...io.read() };
}

async function verificationDirectories() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("andrew-agent-verify-fix-") && !name.startsWith("andrew-agent-verify-fix-test-"));
}

const buggy = "export function add(a, b) {\n  return a - b;\n}\n";
const fixed = "export function add(a, b) {\n  return a + b;\n}\n";
const addTest = 'import { add } from "../src/add.mjs";\nif (add(2, 3) !== 5) {\n  console.error("add(2, 3) returned " + add(2, 3));\n  process.exit(1);\n}\nconsole.log("add ok");\n';

test("a source diff.orderFile that reorders changed tests does not fail the restore check", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/a.test.mjs": addTest, "test/z.test.mjs": addTest } }, async (root) => {
    const orderFile = join(root, ".git", "andrew-agent-test-order");
    await writeFile(orderFile, "test/z.test.mjs\ntest/a.test.mjs\nsrc/*\n");
    await git(root, "config", "diff.orderFile", orderFile);
    const reordered = await git(root, "diff", "--name-only", "main", "HEAD");
    assert.equal(reordered, "test/z.test.mjs\ntest/a.test.mjs\nsrc/add.mjs", "the fixture must reorder the source diff");
    const result = await verify(root, { command: [node, "test/a.test.mjs"] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^Test paths: 2\. Production paths: 1\.$/m);
  });
});

test("verify-fix exits 0 when the test fails without the fix and passes with it", async () => {
  assert.notEqual(verifyFixModule, null, "the built verify-fix command must exist");
  // The test also writes inside the checkout and inside TMPDIR, which the
  // sandbox must allow.
  const writingTest = `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { tmpdir } from "node:os";\nwriteFileSync("inside-checkout.txt", "x");\nwriteFileSync(join(tmpdir(), "inside-tmp.txt"), "x");\n${addTest}`;
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": writingTest } }, async (root) => {
    const before = await verificationDirectories();
    const result = await verify(root, { command: [node, "test/add.test.mjs"] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^Verifying refs\/heads\/feature \([0-9a-f]{40}\) against refs\/remotes\/origin\/main \([0-9a-f]{40}\)\.$/m);
    assert.match(result.stdout, /^Test paths: 1\. Production paths: 1\.$/m);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 1\.\n {2}\| add\(2, 3\) returned -1$/m);
    assert.match(result.stdout, /^Run B \(HEAD\): exit 0\.\n {2}\| add ok$/m);
    assert.match(result.stdout, /^Verified: the tests fail without the fix and pass with it\.$/m);
    assert.equal(result.stderr, "");
    assert.deepEqual(await verificationDirectories(), before, "both checkouts must be removed");
  });
});

test("verify-fix exits 1 when the test passes without the fix", async () => {
  assert.notEqual(verifyFixModule, null);
  const weakTest = 'import { add } from "../src/add.mjs";\nif (typeof add !== "function") process.exit(1);\n';
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": weakTest } }, async (root) => {
    const result = await verify(root, { command: [node, "test/add.test.mjs"] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 0\.$/m);
    assert.match(result.stdout, /^Not verified\.\nExpected run A to fail without the fix, but it passed\.$/m);
  });
});

test("verify-fix exits 1 when the test fails with the fix", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": buggy.replace("a - b", "a * b"), "test/add.test.mjs": addTest } }, async (root) => {
    const result = await verify(root, { command: [node, "test/add.test.mjs"] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Run B \(HEAD\): exit 1\.$/m);
    assert.match(result.stdout, /^Not verified\.\nExpected run B to pass with the fix, but it failed with exit 1\.$/m);
    assert.doesNotMatch(result.stdout, /Expected run A/);
  });
});

test("checkout A restores modified, added, deleted, and renamed production paths", async () => {
  assert.notEqual(verifyFixModule, null);
  // Exits 1 only in the exact merge-base production state, 0 only in the exact
  // HEAD state, and 2 otherwise; the run statuses are asserted below, because
  // the verdict alone also counts exit 2 as a failure without the fix.
  const stateTest = 'import { existsSync, readFileSync } from "node:fs";\nconst has = (p) => existsSync(p);\nconst merge = has("src/old.mjs") && has("src/deleted.mjs") && !has("src/added.mjs") && !has("src/new.mjs") && readFileSync("src/value.mjs", "utf8") === "before\\n";\nconst head = !has("src/old.mjs") && !has("src/deleted.mjs") && has("src/added.mjs") && has("src/new.mjs") && readFileSync("src/value.mjs", "utf8") === "after\\n";\nconsole.log(JSON.stringify({ merge, head }));\nprocess.exit(merge ? 1 : head ? 0 : 2);\n';
  const renamed = "export const renamed = 'a long enough body for rename detection';\n".repeat(4);
  await withRepository({
    base: { "src/value.mjs": "before\n", "src/old.mjs": renamed, "src/deleted.mjs": "gone\n" },
    head: { "src/value.mjs": "after\n", "src/old.mjs": null, "src/new.mjs": renamed, "src/deleted.mjs": null, "src/added.mjs": "new\n", "test/state.test.mjs": stateTest },
  }, async (root) => {
    const result = await verify(root, { command: [node, "test/state.test.mjs"] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^Test paths: 1\. Production paths: 5\.$/m);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 1\.\n {2}\| \{"merge":true,"head":false\}$/m);
    assert.match(result.stdout, /^Run B \(HEAD\): exit 0\.\n {2}\| \{"merge":false,"head":true\}$/m);
  });
});

test("a network call from the test command fails under the sandbox", async () => {
  assert.notEqual(verifyFixModule, null);
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const connect = `const s = require("node:net").connect(${port}, "127.0.0.1"); s.on("connect", () => { console.log("connected"); process.exit(0); }); s.on("error", (e) => { console.log("network " + e.code); process.exit(1); });`;
  try {
    // Control: the same command reaches the listener outside the sandbox.
    const control = await execFile(node, ["-e", connect], { encoding: "utf8" });
    assert.equal(control.stdout, "connected\n");
    assert.equal(connections, 1);
    await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
      const result = await verify(root, { command: [node, "-e", connect] });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /^Run B \(HEAD\): exit 1\.\n {2}\| network EPERM$/m);
      assert.match(result.stdout, /Expected run B to pass with the fix, but it failed with exit 1\./);
    });
    assert.equal(connections, 1, "no sandboxed run may reach the listener");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a write outside the checkout is refused", async () => {
  assert.notEqual(verifyFixModule, null);
  const outside = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-outside-"));
  const target = join(outside, "escaped.txt");
  const existing = join(outside, "existing.txt");
  await writeFile(existing, "original\n");
  try {
    await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
      // A hard link inside the checkout must not be creatable, and a symbolic
      // link inside it must not carry a write out of it.
      const script = `const fs = require("node:fs"); const codes = []; try { fs.linkSync(${JSON.stringify(existing)}, "hard"); codes.push("link created"); } catch (e) { codes.push("link " + e.code); } fs.symlinkSync(${JSON.stringify(existing)}, "soft"); try { fs.appendFileSync("soft", "escaped"); codes.push("symlink written"); } catch (e) { codes.push("symlink " + e.code); } console.log(codes.join(", ")); process.exit(codes.join() === "link EPERM,symlink EPERM" ? 0 : 2);`;
      const result = await verify(root, { command: [node, "-e", script] });
      assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 0\.\n {2}\| link EPERM, symlink EPERM$/m);
      assert.match(result.stdout, /^Run B \(HEAD\): exit 0\.\n {2}\| link EPERM, symlink EPERM$/m);
    });
    assert.equal(await readFile(existing, "utf8"), "original\n");
    await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
      // Both writes are attempted, so each one is shown to be refused.
      const script = `const fs = require("node:fs"); const codes = []; for (const [label, path] of [["write", ${JSON.stringify(target)}], ["source", ${JSON.stringify(join(root, "escaped.txt"))}]]) { try { fs.writeFileSync(path, "x"); codes.push(label + " written"); } catch (e) { codes.push(label + " " + e.code); } } console.log(codes.join(", ")); process.exit(1);`;
      const result = await verify(root, { command: [node, "-e", script] });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 1\.\n {2}\| write EPERM, source EPERM$/m);
      assert.match(result.stdout, /^Run B \(HEAD\): exit 1\.\n {2}\| write EPERM, source EPERM$/m);
      await assert.rejects(stat(join(root, "escaped.txt")), { code: "ENOENT" });
    });
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("a run cannot read the source worktree, directly or through a symbolic link in a --with clone", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({
    base: { ".gitignore": "vendor/\n", "src/add.mjs": buggy },
    head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest },
    ignored: { "vendor/check.mjs": "export {};\n" },
  }, async (root) => {
    // `cp -R` copies this absolute link as a link, so the clone points back
    // into the source worktree at the HEAD production files.
    await symlink(join(root, "src"), join(root, "vendor", "link"));
    const script = `const fs = require("node:fs"); const codes = []; for (const [label, path] of [["clone", "vendor/check.mjs"], ["link", "vendor/link/add.mjs"], ["source", ${JSON.stringify(join(root, "src", "add.mjs"))}]]) { try { fs.readFileSync(path); codes.push(label + " read"); } catch (e) { codes.push(label + " " + e.code); } } console.log(codes.join(", ")); process.exit(1);`;
    const result = await verify(root, { command: [node, "-e", script], withPaths: ["vendor"] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): exit 1\.\n {2}\| clone read, link EPERM, source EPERM$/m);
    assert.match(result.stdout, /^Run B \(HEAD\): exit 1\.\n {2}\| clone read, link EPERM, source EPERM$/m);
  });
});

test("a timeout kills the whole process group and is neither a pass nor a fail", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
    const result = await verify(root, { command: ["/bin/sh", "-c", "/bin/sleep 120 & echo grandchild $!; wait"] }, { timeoutMs: 3000 });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): timed out after 3 seconds\.$/m);
    assert.match(result.stdout, /^Run B \(HEAD\): timed out after 3 seconds\.$/m);
    assert.match(result.stdout, /Expected run A to fail without the fix, but it timed out after 3 seconds\./);
    assert.match(result.stdout, /Expected run B to pass with the fix, but it timed out after 3 seconds\./);
    const pids = [...result.stdout.matchAll(/grandchild (\d+)/g)].map((match) => Number(match[1]));
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});

test("a descendant that leaves the process group does not keep the CLI process alive", { timeout: 60_000 }, async () => {
  assert.notEqual(verifyFixModule, null);
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-survivor-"));
  let survivor;
  try {
    const checkout = join(root, "checkout");
    const temporaryDirectory = join(root, "tmp");
    const source = join(root, "source");
    for (const directory of [checkout, temporaryDirectory, source]) await mkdir(directory);
    // The survivor moves to its own process group, so killing the run's group
    // misses it, and it keeps the run's output pipes open for 30 seconds. The
    // shell waits one second so the survivor leaves the group before the shell
    // exits and the group is killed.
    const command = ["/bin/sh", "-c", "/usr/bin/perl -e '$| = 1; setpgrp(0, 0); print \"survivor $$\\n\"; sleep 30' & /bin/sleep 1"];
    const moduleUrl = new URL("../../dist/commands/verify-fix.js", import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(moduleUrl)}); const result = await m.runSandboxed({ timeoutMs: 20000, outputLimitBytes: 4096, sandboxExecutable: m.SANDBOX_EXECUTABLE }, ${JSON.stringify({ source, checkout, temporaryDirectory })}, ${JSON.stringify(command)}); process.stdout.write(JSON.stringify(result));`;
    const started = Date.now();
    const { stdout } = await execFile(node, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 45_000 });
    const elapsed = Date.now() - started;
    const result = JSON.parse(stdout);
    survivor = Number(/survivor (\d+)/.exec(result.tail)?.[1]);
    assert.ok(Number.isInteger(survivor) && survivor > 0, result.tail);
    assert.ok(elapsed < 15_000, `the process exited after ${elapsed} ms`);
    assert.doesNotThrow(() => process.kill(survivor, 0), "the survivor must still be running when the CLI process has exited");
    assert.deepEqual(result.outcome, { kind: "exited", code: 0 });
  } finally {
    if (survivor !== undefined && Number.isInteger(survivor)) {
      try {
        process.kill(survivor, "SIGKILL");
      } catch {
        // The survivor may already be gone.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the output limit stops the run and is neither a pass nor a fail", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
    const result = await verify(root, { command: [node, "-e", 'process.stdout.write("x".repeat(65536)); setTimeout(() => {}, 60000);'] }, { outputLimitBytes: 4096 });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Run A \(production paths at the merge base\): exceeded the output limit of 4096 bytes\.$/m);
    assert.match(result.stdout, /^Run B \(HEAD\): exceeded the output limit of 4096 bytes\.$/m);
  });
});

test("a command that cannot start is not counted as a failing run", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
    const result = await verify(root, { command: ["./missing-test-runner"] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Expected run A to fail without the fix, but it could not start the command\./);
  });
});

test("--with clones an ignored path into both checkouts", async () => {
  assert.notEqual(verifyFixModule, null);
  const vendorTest = 'import { check } from "../vendor/check.mjs";\nimport { add } from "../src/add.mjs";\nprocess.exit(check(add) ? 0 : 1);\n';
  await withRepository({
    base: { ".gitignore": "vendor/\n", "src/add.mjs": buggy },
    head: { "src/add.mjs": fixed, "test/add.test.mjs": vendorTest },
    ignored: { "vendor/check.mjs": "export const check = (add) => add(2, 3) === 5;\n" },
  }, async (root) => {
    const without = await verify(root, { command: [node, "test/add.test.mjs"] });
    assert.equal(without.code, 1, "without --with the ignored module is missing from both checkouts");
    assert.match(without.stdout, /Expected run B to pass with the fix/);
    const result = await verify(root, { command: [node, "test/add.test.mjs"], withPaths: ["vendor"] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
});

test("--with refuses tracked, absolute, parent, outside, missing, git, and overlapping paths", async () => {
  assert.notEqual(verifyFixModule, null);
  const outside = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-outside-"));
  try {
    await withRepository({
      base: { ".gitignore": "vendor/\nlink-out\nalias\nalias-relative\n", "src/add.mjs": buggy },
      head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest },
      ignored: { "vendor/check.mjs": "export {};\n" },
    }, async (root) => {
      await symlink(outside, join(root, "link-out"));
      await symlink(join(root, "src"), join(root, "alias"));
      await symlink("src", join(root, "alias-relative"));
      for (const [withPaths, message] of [
        [["src/add.mjs"], /A --with path is tracked by Git: src\/add\.mjs\./],
        [["src"], /A --with path is tracked by Git: src\./],
        [["alias"], /A --with path is tracked by Git: alias\./],
        [["alias-relative"], /A --with path is tracked by Git: alias-relative\./],
        [[join(root, "vendor")], /must be a relative path inside the worktree without '\.\.'/],
        [["vendor/../vendor"], /must be a relative path inside the worktree without '\.\.'/],
        [["."], /must be a relative path inside the worktree without '\.\.'/],
        [["link-out"], /A --with path resolves outside the worktree: link-out\./],
        [["missing"], /A --with path does not exist: missing\./],
        [[".git"], /cannot name a \.git directory/],
        [[".GIT/hooks"], /cannot name a \.git directory/],
        [["vendor", "vendor/check.mjs"], /A --with path overlaps another: vendor\/check\.mjs\./],
      ]) {
        const result = await verify(root, { command: [node, "test/add.test.mjs"], withPaths });
        assert.equal(result.code, 3, withPaths.join(" "));
        assert.match(result.stderr, message);
        assert.equal(result.stdout, "");
      }
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// Opens the FIFO for writing as soon as a sandboxed reader has it open, so
// the test acts while a run is in progress; gives up if verification settles.
async function whileRunning(fifo, settled, action) {
  for (;;) {
    if (settled.done) throw new Error("verification settled before the run started");
    try {
      const handle = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        await action();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error.code !== "ENXIO") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function track(promise) {
  const settled = { done: false };
  promise.finally(() => {
    settled.done = true;
  }).catch(() => {});
  return settled;
}

test("a comparison that moves during the runs discards the verdict", async () => {
  assert.notEqual(verifyFixModule, null);
  const gate = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-gate-"));
  // Each run reads its own FIFO, chosen by the production file it sees, so
  // the second writer cannot attach to the first run's reader.
  const withoutFixFifo = join(gate, "without-fix");
  const withFixFifo = join(gate, "with-fix");
  try {
    await execFile("mkfifo", [withoutFixFifo, withFixFifo]);
    await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
      const io = output();
      const command = ["/bin/sh", "-c", `if /usr/bin/grep -q "a + b" src/add.mjs; then /bin/cat ${withFixFifo}; else /bin/cat ${withoutFixFifo}; fi`];
      const running = verifyFixModule.verifyFixCommand(root, { withPaths: [], testPaths: [], command }, io, defaults);
      const settled = track(running);
      await whileRunning(withoutFixFifo, settled, async () => {
        await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      });
      await whileRunning(withFixFifo, settled, async () => {});
      assert.equal(await running, 3);
      assert.equal(io.read().stdout, "");
      assert.equal(io.read().stderr, "Verification inputs changed; run verify-fix again.\n");
    });
  } finally {
    await rm(gate, { recursive: true, force: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  // Without a listener for the signal the run would see the FIFO close and
  // go on to run B, which then blocks; the timeout turns that into a failure.
  test(`${signal} during a run starts no further run and removes the checkouts`, { timeout: 60_000 }, async () => {
    assert.notEqual(verifyFixModule, null);
    const gate = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-gate-"));
    const fifo = join(gate, "fifo");
    try {
      await execFile("mkfifo", [fifo]);
      await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
        const before = await verificationDirectories();
        const listeners = Object.fromEntries(["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [name, process.listenerCount(name)]));
        const io = output();
        const running = verifyFixModule.verifyFixCommand(root, { withPaths: [], testPaths: [], command: ["/bin/cat", fifo] }, io, defaults);
        const settled = track(running);
        await whileRunning(fifo, settled, async () => {
          process.emit(signal);
        });
        assert.equal(await running, 1);
        assert.equal(io.read().stdout, "");
        assert.equal(io.read().stderr, "Verification interrupted; no verdict was reported.\n");
        assert.deepEqual(await verificationDirectories(), before);
        for (const [name, count] of Object.entries(listeners)) assert.equal(process.listenerCount(name), count, name);
      });
    } finally {
      await rm(gate, { recursive: true, force: true });
    }
  });
}

test("SIGTERM to the CLI kills the run's process group and removes the checkouts", { timeout: 60_000 }, async () => {
  assert.notEqual(verifyFixModule, null);
  const gate = await mkdtemp(join(tmpdir(), "andrew-agent-verify-fix-test-gate-"));
  const fifo = join(gate, "fifo");
  try {
    await execFile("mkfifo", [fifo]);
    await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
      const before = await verificationDirectories();
      // A duration no other process uses, so pgrep finds only this grandchild.
      const sleeper = `/bin/sleep ${String(process.pid % 1000 + 3000)}`;
      const cli = spawn(node, [join(import.meta.dirname, "../../dist/cli.js"), "verify-fix", "--", "/bin/sh", "-c", `${sleeper} & /bin/cat ${fifo}`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      cli.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve) => cli.on("close", (code, signalName) => resolve({ code, signalName })));
      const settled = track(exited);
      let pid;
      await whileRunning(fifo, settled, async () => {
        pid = Number((await execFile("/usr/bin/pgrep", ["-f", `^${sleeper}$`], { encoding: "utf8" })).stdout.trim());
        cli.kill("SIGTERM");
        assert.deepEqual(await exited, { code: 1, signalName: null });
      });
      assert.equal(stderr, "Verification interrupted; no verdict was reported.\n");
      assert.deepEqual(await verificationDirectories(), before);
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    });
  } finally {
    await rm(gate, { recursive: true, force: true });
  }
});

test("classification refuses an empty test set or an empty production set", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed } }, async (root) => {
    const result = await verify(root, { command: [node, "-e", ""] });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, "No changed test files; name them with --test or add a test.\n");
  });
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "test/add.test.mjs": addTest } }, async (root) => {
    const result = await verify(root, { command: [node, "-e", ""] });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, "No changed production files; there is no fix to verify.\n");
  });
});

test("--test replaces the default test patterns", async () => {
  assert.notEqual(verifyFixModule, null);
  const check = addTest.replace("../src/add.mjs", "../src/add.mjs");
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "checks/add.mjs": check, "test/unrelated.test.mjs": "process.exit(0);\n" } }, async (root) => {
    const result = await verify(root, { command: [node, "checks/add.mjs"], testPaths: ["checks/"] });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    // `test/unrelated.test.mjs` is production under the selector, so run A
    // removes it.
    assert.match(result.stdout, /^Test paths: 1\. Production paths: 2\.$/m);
    const unmatched = await verify(root, { command: [node, "checks/add.mjs"], testPaths: ["elsewhere"] });
    assert.equal(unmatched.code, 3);
    assert.match(unmatched.stderr, /No changed test files/);
    const invalid = await verify(root, { command: [node, "checks/add.mjs"], testPaths: ["../checks"] });
    assert.equal(invalid.code, 3);
    assert.match(invalid.stderr, /A --test path must be a relative repository path/);
  });
});

test("default test patterns cover test directories and test file names", () => {
  assert.notEqual(verifyFixModule, null);
  const { testPaths, productionPaths } = verifyFixModule.classifyChangedPaths([
    "test/a.mjs", "pkg/tests/b.py", "src/__tests__/c.ts", "spec/d.rb", "src/e.test.ts", "src/f.spec.js", "pkg/g_test.go",
    "src/test.ts", "src/latest.ts", "testdata/h.json", "src/contest/i.ts", "src/spec.ts",
  ], []);
  assert.deepEqual(testPaths, ["test/a.mjs", "pkg/tests/b.py", "src/__tests__/c.ts", "spec/d.rb", "src/e.test.ts", "src/f.spec.js", "pkg/g_test.go"]);
  assert.deepEqual(productionPaths, ["src/test.ts", "src/latest.ts", "testdata/h.json", "src/contest/i.ts", "src/spec.ts"]);
});

test("verify-fix refuses to run when the sandbox is missing or cannot be applied", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
    for (const sandboxExecutable of ["/nonexistent/sandbox-exec", "/usr/bin/false"]) {
      const before = await verificationDirectories();
      const result = await verify(root, { command: [node, "test/add.test.mjs"] }, { sandboxExecutable });
      assert.equal(result.code, 3, sandboxExecutable);
      assert.equal(result.stderr, "The network sandbox could not be applied; the test command was not run.\n");
      assert.equal(result.stdout, "");
      assert.deepEqual(await verificationDirectories(), before);
    }
  });
});

test("verify-fix refuses a dirty worktree and a detached HEAD", async () => {
  assert.notEqual(verifyFixModule, null);
  await withRepository({ base: { "src/add.mjs": buggy }, head: { "src/add.mjs": fixed, "test/add.test.mjs": addTest } }, async (root) => {
    await writeFile(join(root, "src/add.mjs"), "dirty\n");
    const io = output();
    assert.equal(await verifyFixModule.verifyFixCommand(root, { withPaths: [], testPaths: [], command: [node, "test/add.test.mjs"] }, io, defaults), 3);
    assert.match(io.read().stderr, /Git worktree is not clean/);
    await git(root, "checkout", "--quiet", "--", "src/add.mjs");
    await git(root, "switch", "--quiet", "--detach");
    const detached = output();
    assert.equal(await verifyFixModule.verifyFixCommand(root, { withPaths: [], testPaths: [], command: [node, "test/add.test.mjs"] }, detached, defaults), 3);
    assert.equal(detached.read().stderr, "verify-fix requires a named current branch.\n");
  });
});
