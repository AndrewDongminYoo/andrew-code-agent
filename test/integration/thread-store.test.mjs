import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const threadModule = await import("../../dist/runtime/thread-store.js").catch(
  () => null,
);

function requireThreads() {
  assert.notEqual(
    threadModule,
    null,
    "the built runtime thread store module must be available",
  );
  return threadModule;
}

const makeRecord = (threadId, repositoryRoot, overrides = {}) => ({
  threadId,
  repositoryRoot,
  startingHead: "a".repeat(40),
  terminalHead: null,
  bundleDigest: "b".repeat(64),
  productVersion: "0.1.0",
  codexVersion: "1.2.3",
  turnId: null,
  terminalStatus: "not-started",
  finalGitStatus: null,
  ...overrides,
});

async function withStore(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-threads-")),
  );
  const stateRoot = join(root, "state");
  const repositoryRoot = join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(repositoryRoot);
  try {
    await run({
      root,
      stateRoot,
      repositoryRoot: await realpath(repositoryRoot),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writes owner-only records atomically and maps only safe thread IDs", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    const record = makeRecord("thread_01-safe", repositoryRoot);
    await requireThreads().writeThreadRecord(stateRoot, record);
    const threadsRoot = join(stateRoot, "threads");
    const recordPath = join(threadsRoot, "thread_01-safe.json");
    assert.deepEqual(
      await requireThreads().readThreadRecord(
        stateRoot,
        record.threadId,
        repositoryRoot,
      ),
      record,
    );
    assert.equal((await lstat(threadsRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(recordPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(threadsRoot), ["thread_01-safe.json"]);
    assert.equal(
      JSON.parse(await readFile(recordPath, "utf8")).sessionId,
      undefined,
    );
    for (const invalid of ["../escape", "slash/name", "", "a".repeat(129)]) {
      await assert.rejects(
        requireThreads().writeThreadRecord(
          stateRoot,
          makeRecord(invalid, repositoryRoot),
        ),
        { code: "THREAD_ID_INVALID" },
      );
    }
  });
});

test("enforces canonical repository equality on reads and rewrites", async () => {
  await withStore(async ({ root, stateRoot, repositoryRoot }) => {
    const link = join(root, "repository-link");
    const other = join(root, "other");
    await symlink(repositoryRoot, link);
    await mkdir(other);
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("same", link),
    );
    assert.equal(
      (
        await requireThreads().readThreadRecord(
          stateRoot,
          "same",
          repositoryRoot,
        )
      ).repositoryRoot,
      repositoryRoot,
    );
    await assert.rejects(
      requireThreads().readThreadRecord(stateRoot, "same", other),
      { code: "THREAD_REPOSITORY_MISMATCH" },
    );
    await assert.rejects(
      requireThreads().writeThreadRecord(stateRoot, makeRecord("same", other)),
      { code: "THREAD_REPOSITORY_MISMATCH" },
    );
  });
});

test("selects latest valid repository record by mtimeNs then thread ID", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("alpha", repositoryRoot),
    );
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("beta", repositoryRoot),
    );
    const sameTime = new Date("2025-01-02T03:04:05.000Z");
    await utimes(join(stateRoot, "threads/alpha.json"), sameTime, sameTime);
    await utimes(join(stateRoot, "threads/beta.json"), sameTime, sameTime);
    assert.equal(
      (await requireThreads().findLatestThreadRecord(stateRoot, repositoryRoot))
        .threadId,
      "beta",
    );
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("newest", repositoryRoot),
    );
    assert.equal(
      (await requireThreads().findLatestThreadRecord(stateRoot, repositoryRoot))
        .threadId,
      "newest",
    );
  });
});

test("surfaces corrupt metadata instead of skipping or deleting it", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("valid", repositoryRoot),
    );
    const corruptPath = join(stateRoot, "threads/corrupt.json");
    const corruptBytes = Buffer.from(
      '{"threadId":"corrupt","sessionId":"forbidden"}\n',
    );
    await writeFile(corruptPath, corruptBytes, { mode: 0o600 });
    await assert.rejects(
      requireThreads().readThreadRecord(stateRoot, "corrupt", repositoryRoot),
      { code: "THREAD_CORRUPT" },
    );
    await assert.rejects(
      requireThreads().findLatestThreadRecord(stateRoot, repositoryRoot),
      { code: "THREAD_CORRUPT" },
    );
    assert.deepEqual(await readFile(corruptPath), corruptBytes);
  });
});
