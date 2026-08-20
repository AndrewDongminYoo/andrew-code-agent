import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";

const lockModule = await import("../../dist/runtime/lock.js").catch(() => null);

function requireLock() {
  assert.notEqual(
    lockModule,
    null,
    "the built runtime lock module must be available",
  );
  return lockModule;
}

async function withState(run) {
  const stateRoot = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-lock-")),
  );
  try {
    await run(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

test("acquires exclusively, diagnoses a live owner, and releases only by its opaque handle", async () => {
  await withState(async (stateRoot) => {
    const handle = await requireLock().acquireProcessLock(stateRoot, [
      "test",
      "lock",
    ]);
    const lockPath = join(stateRoot, "run.lock");
    assert.equal(
      (await (await import("node:fs/promises")).lstat(lockPath)).mode & 0o777,
      0o600,
    );
    const before = await readFile(lockPath);
    const diagnosis = await requireLock().inspectProcessLock(stateRoot);
    assert.equal(diagnosis.status, "live");
    assert.equal(diagnosis.owner.pid, process.pid);
    assert.deepEqual(diagnosis.owner.command, ["test", "lock"]);
    assert.deepEqual(await readFile(lockPath), before);
    await assert.rejects(requireLock().acquireProcessLock(stateRoot), {
      code: "PROCESS_LOCK_HELD",
    });
    await assert.rejects(requireLock().releaseProcessLock({}), {
      code: "PROCESS_LOCK_NOT_OWNER",
    });
    await requireLock().releaseProcessLock(handle);
    assert.deepEqual(await requireLock().inspectProcessLock(stateRoot), {
      status: "absent",
    });
  });
});

test("diagnoses stale and malformed locks without changing their bytes", async () => {
  await withState(async (stateRoot) => {
    const lockPath = join(stateRoot, "run.lock");
    const stale = `${JSON.stringify({ pid: 99999999, processStartMarker: "never", hostname: hostname(), command: ["dead"], acquiredAt: "2025-01-02T03:04:05.000Z" })}\n`;
    await writeFile(lockPath, stale, { mode: 0o600, flag: "wx" });
    assert.equal(
      (await requireLock().inspectProcessLock(stateRoot)).status,
      "stale",
    );
    assert.equal(await readFile(lockPath, "utf8"), stale);
    await assert.rejects(requireLock().acquireProcessLock(stateRoot), {
      code: "PROCESS_LOCK_STALE",
    });
    assert.equal(await readFile(lockPath, "utf8"), stale);

    await rm(lockPath);
    const malformed = Buffer.from("{not-json}\n");
    await writeFile(lockPath, malformed, { mode: 0o600, flag: "wx" });
    assert.equal(
      (await requireLock().inspectProcessLock(stateRoot)).status,
      "malformed",
    );
    assert.deepEqual(await readFile(lockPath), malformed);
    await assert.rejects(requireLock().acquireProcessLock(stateRoot), {
      code: "PROCESS_LOCK_MALFORMED",
    });
    assert.deepEqual(await readFile(lockPath), malformed);
  });
});

test("uses process start identity so a terminated child lock becomes stale", async () => {
  requireLock();
  await withState(async (stateRoot) => {
    const childScript = join(stateRoot, "lock-child.mjs");
    await writeFile(
      childScript,
      `import { acquireProcessLock } from ${JSON.stringify(new URL("../../dist/runtime/lock.js", import.meta.url).href)};\nawait acquireProcessLock(process.argv[2], ["child"]);\nprocess.send("locked");\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(childScript, 0o700);
    const child = fork(childScript, [stateRoot], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await once(child, "message");
    assert.equal(
      (await requireLock().inspectProcessLock(stateRoot)).status,
      "live",
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(
      (await requireLock().inspectProcessLock(stateRoot)).status,
      "stale",
    );
  });
});
