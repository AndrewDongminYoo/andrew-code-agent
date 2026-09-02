import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
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
  requestedCapabilities: [],
  oracleRootDigest: null,
  tokenUsage: null,
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

test("rejects a filename and payload thread ID mismatch without changing bytes", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("payload-id", repositoryRoot),
    );
    const threadsRoot = join(stateRoot, "threads");
    const mismatchedPath = join(threadsRoot, "filename-id.json");
    await rename(join(threadsRoot, "payload-id.json"), mismatchedPath);
    const before = await readFile(mismatchedPath);

    await assert.rejects(
      requireThreads().readThreadRecord(
        stateRoot,
        "filename-id",
        repositoryRoot,
      ),
      { code: "THREAD_CORRUPT" },
    );
    await assert.rejects(
      requireThreads().findLatestThreadRecord(stateRoot, repositoryRoot),
      { code: "THREAD_CORRUPT" },
    );
    assert.deepEqual(await readFile(mismatchedPath), before);
  });
});

test("refuses to overwrite an existing filename and payload ID mismatch", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    await requireThreads().writeThreadRecord(
      stateRoot,
      makeRecord("payload-id", repositoryRoot),
    );
    const threadsRoot = join(stateRoot, "threads");
    const mismatchedPath = join(threadsRoot, "filename-id.json");
    await rename(join(threadsRoot, "payload-id.json"), mismatchedPath);
    const before = await readFile(mismatchedPath);

    await assert.rejects(
      requireThreads().writeThreadRecord(
        stateRoot,
        makeRecord("filename-id", repositoryRoot),
      ),
      { code: "THREAD_CORRUPT" },
    );
    assert.deepEqual(await readFile(mismatchedPath), before);
  });
});

test("read and latest reject an unsafe threads directory without chmod", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    const threadsRoot = join(stateRoot, "threads");
    await mkdir(threadsRoot, { mode: 0o755 });
    await chmod(threadsRoot, 0o755);

    await assert.rejects(
      requireThreads().readThreadRecord(stateRoot, "missing", repositoryRoot),
      { code: "THREAD_STORE_UNSAFE" },
    );
    await assert.rejects(
      requireThreads().findLatestThreadRecord(stateRoot, repositoryRoot),
      { code: "THREAD_STORE_UNSAFE" },
    );
    assert.equal((await lstat(threadsRoot)).mode & 0o777, 0o755);
  });
});

test("the capability grant round-trips, migrates from schema 1, and refuses a corrupt one", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    const threads = requireThreads();
    const digest = "d".repeat(64);

    // The grant survives a write and a read in another process's shape.
    const granted = makeRecord("granted", repositoryRoot, { requestedCapabilities: ["oracle"], oracleRootDigest: digest });
    await threads.writeThreadRecord(stateRoot, granted);
    const readBack = await threads.readThreadRecord(stateRoot, "granted");
    assert.deepEqual(readBack.requestedCapabilities, ["oracle"]);
    assert.equal(readBack.oracleRootDigest, digest);

    // A record written before schema 2 reads as the empty grant rather than
    // as corruption, and nothing about it names a path.
    const legacy = makeRecord("legacy", repositoryRoot);
    delete legacy.requestedCapabilities;
    delete legacy.oracleRootDigest;
    delete legacy.tokenUsage;
    await writeFile(join(stateRoot, "threads", "legacy.json"), JSON.stringify(legacy), { mode: 0o600 });
    const migrated = await threads.readThreadRecord(stateRoot, "legacy");
    assert.deepEqual(migrated.requestedCapabilities, []);
    assert.equal(migrated.oracleRootDigest, null);

    // Each field is refused on its own terms rather than tolerated.
    const corrupt = [
      { requestedCapabilities: "oracle" },
      { requestedCapabilities: ["shared-memory"] },
      { requestedCapabilities: ["oracle", "oracle"] },
      { oracleRootDigest: "" },
      { oracleRootDigest: "not-a-digest" },
      { oracleRootDigest: "D".repeat(64) },
      { oracleRootDigest: "d".repeat(63) },
    ];
    for (const [index, override] of corrupt.entries()) {
      const name = `corrupt-${index}`;
      await writeFile(join(stateRoot, "threads", `${name}.json`), JSON.stringify(makeRecord(name, repositoryRoot, override)), { mode: 0o600 });
      await assert.rejects(threads.readThreadRecord(stateRoot, name), { code: "THREAD_CORRUPT" }, JSON.stringify(override));
    }
  });
});

test("the token usage snapshot round-trips, migrates from every earlier schema, and refuses a corrupt one", async () => {
  await withStore(async ({ stateRoot, repositoryRoot }) => {
    const threads = requireThreads();

    // The measurement survives a write and a read in another process's shape.
    const measured = makeRecord("measured", repositoryRoot, { tokenUsage: { totalTokens: 204000, contextWindow: 272000 } });
    await threads.writeThreadRecord(stateRoot, measured);
    assert.deepEqual((await threads.readThreadRecord(stateRoot, "measured")).tokenUsage, { totalTokens: 204000, contextWindow: 272000 });

    // A window the server never reported is a value, not corruption.
    const windowless = makeRecord("windowless", repositoryRoot, { tokenUsage: { totalTokens: 1300, contextWindow: null } });
    await threads.writeThreadRecord(stateRoot, windowless);
    assert.deepEqual((await threads.readThreadRecord(stateRoot, "windowless")).tokenUsage, { totalTokens: 1300, contextWindow: null });

    // Records written before this field reads as no measurement rather than
    // as corruption, from both earlier schemas.
    const schema2 = makeRecord("schema-2", repositoryRoot);
    delete schema2.tokenUsage;
    await writeFile(join(stateRoot, "threads", "schema-2.json"), JSON.stringify(schema2), { mode: 0o600 });
    assert.equal((await threads.readThreadRecord(stateRoot, "schema-2")).tokenUsage, null);
    const schema1 = makeRecord("schema-1", repositoryRoot);
    delete schema1.requestedCapabilities;
    delete schema1.oracleRootDigest;
    delete schema1.tokenUsage;
    await writeFile(join(stateRoot, "threads", "schema-1.json"), JSON.stringify(schema1), { mode: 0o600 });
    const migrated = await threads.readThreadRecord(stateRoot, "schema-1");
    assert.deepEqual(migrated.requestedCapabilities, []);
    assert.equal(migrated.tokenUsage, null);

    // Each field is refused on its own terms rather than tolerated.
    const corrupt = [
      { tokenUsage: 204000 },
      { tokenUsage: [] },
      { tokenUsage: {} },
      { tokenUsage: { totalTokens: 204000 } },
      { tokenUsage: { totalTokens: 204000, contextWindow: 272000, ratio: 0.75 } },
      { tokenUsage: { totalTokens: -1, contextWindow: null } },
      { tokenUsage: { totalTokens: 1.5, contextWindow: null } },
      { tokenUsage: { totalTokens: "204000", contextWindow: null } },
      { tokenUsage: { totalTokens: 204000, contextWindow: 0 } },
      { tokenUsage: { totalTokens: 204000, contextWindow: -272000 } },
    ];
    for (const [index, override] of corrupt.entries()) {
      const name = `token-corrupt-${index}`;
      await writeFile(join(stateRoot, "threads", `${name}.json`), JSON.stringify(makeRecord(name, repositoryRoot, override)), { mode: 0o600 });
      await assert.rejects(threads.readThreadRecord(stateRoot, name), { code: "THREAD_CORRUPT" }, JSON.stringify(override));
    }
  });
});

test("a record whose repository is gone does not block the lookup for a live one", async () => {
  await withStore(async ({ root, stateRoot, repositoryRoot }) => {
    const threads = requireThreads();
    const departed = join(root, "departed");
    await mkdir(departed);
    await threads.writeThreadRecord(stateRoot, makeRecord("departed", departed));
    await threads.writeThreadRecord(stateRoot, makeRecord("live", repositoryRoot));
    await rm(departed, { recursive: true });

    // A repository that moved or was deleted says nothing about the records
    // of the repositories still here, and every stored record names some
    // repository, so one departure must not take the whole store with it.
    assert.equal((await threads.findLatestThreadRecord(stateRoot, repositoryRoot)).threadId, "live");

    // The record itself is intact, so reading it by ID reports it rather than
    // corruption. Its repository's absence surfaces where the repository is
    // actually used, which is the Git preflight.
    assert.equal((await threads.readThreadRecord(stateRoot, "departed")).repositoryRoot, departed);

    // The departed repository is still not the live one, so asking for it
    // under the live root is a mismatch rather than a match or a corruption.
    await assert.rejects(threads.readThreadRecord(stateRoot, "departed", repositoryRoot), { code: "THREAD_REPOSITORY_MISMATCH" });
  });
});
