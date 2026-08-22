import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const installModule = await import("../../dist/bundle/install.js").catch(
  () => null,
);

function requireInstaller() {
  assert.notEqual(
    installModule,
    null,
    "the built transactional installer module must be available",
  );
  return installModule;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function updateFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function bundleDigest(metadata, files) {
  const hash = createHash("sha256");
  for (const value of [
    "andrew-code-agent.bundle.v1",
    "sourceRevision",
    metadata.sourceRevision,
    "manifestDigest",
    metadata.manifestDigest,
    "builderVersion",
    metadata.builderVersion,
    "requestedCapabilities",
    String(metadata.requestedCapabilities.length),
    ...metadata.requestedCapabilities,
    "enabledCapabilities",
    String(metadata.enabledCapabilities.length),
    ...metadata.enabledCapabilities,
    "files",
    String(files.length),
  ])
    updateFrame(hash, value);
  for (const file of files) {
    updateFrame(hash, file.path);
    updateFrame(hash, file.mode);
    updateFrame(hash, file.bytes);
  }
  return hash.digest("hex");
}

async function createArtifact(root, name, entries) {
  const artifactRoot = join(root, name);
  await mkdir(artifactRoot, { recursive: true });
  const files = entries
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode ?? "0644",
      bytes: Buffer.from(entry.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const file of files) {
    const target = join(artifactRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, {
      mode: Number.parseInt(file.mode, 8),
    });
    await chmod(target, Number.parseInt(file.mode, 8));
  }
  const base = {
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    manifestDigest: sha256(Buffer.from(`manifest:${name}`)),
    builderVersion: "0.1.0-test",
    requestedCapabilities: [],
    enabledCapabilities: [],
  };
  const metadata = {
    ...base,
    bundleDigest: bundleDigest(base, files),
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      sha256: sha256(file.bytes),
    })),
  };
  await writeFile(
    join(artifactRoot, "bundle-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o644 },
  );
  return { artifactRoot: await realpath(artifactRoot), metadata };
}

async function withFixture(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-install-")),
  );
  const context = {
    root,
    stateRoot: join(root, "state"),
    artifactsRoot: join(root, "artifacts"),
  };
  await mkdir(context.artifactsRoot);
  try {
    return await run(context);
  } finally {
    installModule?.__setInstallCheckpointHookForTests(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const firstEntries = [
  { path: "AGENTS.md", content: "first instructions\n" },
  { path: "config.toml", content: "model = 'first'\n" },
  { path: "skills/tool/SKILL.md", content: "first skill\n" },
  { path: "old.txt", content: "remove me\n", mode: "0755" },
];
const upgradeEntries = [
  { path: "AGENTS.md", content: "second instructions\n" },
  { path: "config.toml", content: "model = 'second'\n", mode: "0755" },
  { path: "skills/tool/SKILL.md", content: "first skill\n" },
  { path: "new.txt", content: "add me\n" },
];
const protectedEntries = [
  ["auth" + ".json", "credential-sentinel", 0o600],
  ["sessions/thread.jsonl", "session", 0o600],
  ["threads/index.json", "thread", 0o640],
  ["rollouts/rollout.jsonl", "rollout", 0o600],
  ["state.sqlite", "sqlite", 0o600],
  ["logs/agent.log", "log", 0o640],
  ["cache/models.json", "cache", 0o600],
  ["desktop/runtime.json", "desktop", 0o600],
  ["unknown/vendor.sentinel", "unknown", 0o604],
];

async function seedProtected(stateRoot) {
  const epoch = new Date("2025-01-02T03:04:05.000Z");
  for (const [path, content, mode] of protectedEntries) {
    const target = join(stateRoot, "codex-home", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode });
    await chmod(target, mode);
    await utimes(target, epoch, epoch);
  }
}

async function snapshotProtected(stateRoot) {
  return Object.fromEntries(
    await Promise.all(
      protectedEntries.map(async ([path]) => {
        const target = join(stateRoot, "codex-home", path);
        const stat = await lstat(target);
        return [
          path,
          {
            bytes: (await readFile(target)).toString("base64"),
            mode: stat.mode & 0o777,
            mtimeMs: stat.mtimeMs,
            type: stat.isFile() ? "file" : "other",
          },
        ];
      }),
    ),
  );
}

async function snapshotTree(root) {
  const output = [];
  async function visit(path, relativePath) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      output.push([
        relativePath,
        "symlink",
        await readlink(path),
        stat.mode & 0o777,
        stat.mtimeMs,
      ]);
    } else if (stat.isDirectory()) {
      output.push([relativePath, "directory", stat.mode & 0o777]);
      for (const name of (await readdir(path)).sort())
        await visit(
          join(path, name),
          relativePath === "" ? name : `${relativePath}/${name}`,
        );
    } else {
      output.push([
        relativePath,
        stat.isFile() ? "file" : "other",
        (await readFile(path)).toString("base64"),
        stat.mode & 0o777,
        stat.mtimeMs,
      ]);
    }
  }
  await visit(root, "");
  return output;
}

async function assertInstallError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    assert.doesNotMatch(
      String(error?.message),
      /credential-sentinel|first instructions|second instructions/,
    );
    return true;
  });
}

async function installBaseline(context) {
  const installer = requireInstaller();
  const first = await createArtifact(
    context.artifactsRoot,
    "first",
    firstEntries,
  );
  await seedProtected(context.stateRoot);
  const protectedBefore = await snapshotProtected(context.stateRoot);
  await installer.installBundle(context.stateRoot, first);
  return { installer, first, protectedBefore };
}

test("first install writes only the candidate ownership inventory", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    await seedProtected(context.stateRoot);
    const before = await snapshotProtected(context.stateRoot);
    const artifact = await createArtifact(
      context.artifactsRoot,
      "first",
      firstEntries,
    );
    await installer.installBundle(context.stateRoot, artifact);
    for (const entry of firstEntries)
      assert.equal(
        await readFile(
          join(context.stateRoot, "codex-home", entry.path),
          "utf8",
        ),
        entry.content,
      );
    assert.deepEqual(await snapshotProtected(context.stateRoot), before);
    const active = JSON.parse(
      await readFile(join(context.stateRoot, "active-install.json"), "utf8"),
    );
    assert.equal(active.schemaVersion, 2);
    assert.equal(active.bundleDigest, artifact.metadata.bundleDigest);
    assert.deepEqual(
      active.files,
      artifact.metadata.files.map((file) => ({
        ...file,
        lifecycle: file.path === "config.toml" ? "reset-before-run" : "immutable",
      })),
    );
    await assert.rejects(
      lstat(join(context.stateRoot, "install-journal.json")),
      { code: "ENOENT" },
    );
  });
});

test("upgrade adds changes and removes only inventory-owned files", async () => {
  await withFixture(async (context) => {
    const { installer, protectedBefore } = await installBaseline(context);
    const upgrade = await createArtifact(
      context.artifactsRoot,
      "upgrade",
      upgradeEntries,
    );
    await installer.installBundle(context.stateRoot, upgrade);
    assert.equal(
      await readFile(join(context.stateRoot, "codex-home/config.toml"), "utf8"),
      "model = 'second'\n",
    );
    assert.equal(
      (await lstat(join(context.stateRoot, "codex-home/config.toml"))).mode &
        0o777,
      0o755,
    );
    assert.equal(
      await readFile(join(context.stateRoot, "codex-home/new.txt"), "utf8"),
      "add me\n",
    );
    await assert.rejects(lstat(join(context.stateRoot, "codex-home/old.txt")), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await snapshotProtected(context.stateRoot),
      protectedBefore,
    );
  });
});

test("same digest is an exact mtime-preserving no-op", async () => {
  await withFixture(async (context) => {
    const { installer, first } = await installBaseline(context);
    const before = await snapshotTree(context.stateRoot);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await installer.installBundle(context.stateRoot, first);
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("a runtime rewrite of the managed config is reset by the next install", async () => {
  await withFixture(async (context) => {
    const { installer, first } = await installBaseline(context);
    const config = join(context.stateRoot, "codex-home", "config.toml");
    const rendered = await readFile(config, "utf8");
    // Codex appends project trust to its own config and rewrites it owner-only
    // on its first session in a repository.
    await writeFile(
      config,
      `${rendered}\n[projects."/tmp/repository"]\ntrust_level = "trusted"\n`,
    );
    await chmod(config, 0o600);
    await installer.installBundle(context.stateRoot, first);
    assert.equal(await readFile(config, "utf8"), rendered);
    assert.equal((await lstat(config)).mode & 0o777, 0o644);
  });
});

test("an unowned reset-before-run target is refused without mutation", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    const first = await createArtifact(
      context.artifactsRoot,
      "first",
      firstEntries,
    );
    await seedProtected(context.stateRoot);
    await writeFile(
      join(context.stateRoot, "codex-home/config.toml"),
      "third-party config\n",
      { mode: 0o644 },
    );
    const before = await snapshotTree(context.stateRoot);
    await assertInstallError(
      installer.installBundle(context.stateRoot, first),
      "OWNERSHIP_CONFLICT",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("a schema 1 active record is migrated in memory rather than rejected", async () => {
  await withFixture(async (context) => {
    const { installer, first } = await installBaseline(context);
    await writeCanonicalControl(
      join(context.stateRoot, "active-install.json"),
      {
        schemaVersion: 1,
        bundleDigest: first.metadata.bundleDigest,
        files: first.metadata.files,
      },
    );
    const inspection = await installer.inspectInstallState(context.stateRoot);
    assert.deepEqual(inspection.issues, []);
    assert.equal(inspection.active.schemaVersion, 2);
    assert.equal(
      inspection.active.files.find((file) => file.path === "config.toml")
        .lifecycle,
      "reset-before-run",
    );
    const config = join(context.stateRoot, "codex-home", "config.toml");
    const rendered = await readFile(config, "utf8");
    await writeFile(config, `${rendered}[projects."/tmp/repository"]\n`);
    await installer.installBundle(context.stateRoot, first);
    assert.equal(await readFile(config, "utf8"), rendered);
  });
});

test("ownership conflicts and managed drift are rejected without mutation", async () => {
  for (const scenario of ["matching-unowned", "managed-drift"]) {
    await withFixture(async (context) => {
      const { installer, first } = await installBaseline(context);
      const upgrade = await createArtifact(
        context.artifactsRoot,
        `upgrade-${scenario}`,
        upgradeEntries,
      );
      if (scenario === "matching-unowned")
        await writeFile(
          join(context.stateRoot, "codex-home/new.txt"),
          "add me\n",
          { mode: 0o644 },
        );
      else
        await writeFile(
          join(context.stateRoot, "codex-home/AGENTS.md"),
          "third-party drift\n",
        );
      const before = await snapshotTree(context.stateRoot);
      await assertInstallError(
        installer.installBundle(
          context.stateRoot,
          scenario === "managed-drift" ? first : upgrade,
        ),
        scenario === "matching-unowned"
          ? "OWNERSHIP_CONFLICT"
          : "MANAGED_STATE_DRIFT",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("invalid candidates are rejected before any state mutation", async () => {
  for (const scenario of [
    "traversal",
    "duplicate",
    "symlink",
    "reserved",
    "hash",
    "mode",
    "closure",
  ]) {
    await withFixture(async (context) => {
      const installer = requireInstaller();
      await seedProtected(context.stateRoot);
      const artifact = await createArtifact(
        context.artifactsRoot,
        `invalid-${scenario}`,
        [{ path: "safe.txt", content: "safe\n" }],
      );
      if (scenario === "traversal")
        artifact.metadata.files[0].path = "../escape.txt";
      else if (scenario === "duplicate")
        artifact.metadata.files.push({ ...artifact.metadata.files[0] });
      else if (scenario === "symlink") {
        await rm(join(artifact.artifactRoot, "safe.txt"));
        await symlink(
          "bundle-metadata.json",
          join(artifact.artifactRoot, "safe.txt"),
        );
      } else if (scenario === "reserved")
        artifact.metadata.files[0].path = "auth" + ".json";
      else if (scenario === "hash")
        await writeFile(join(artifact.artifactRoot, "safe.txt"), "changed\n");
      else if (scenario === "mode")
        await chmod(join(artifact.artifactRoot, "safe.txt"), 0o755);
      else
        await writeFile(
          join(artifact.artifactRoot, "undeclared.txt"),
          "extra\n",
        );
      if (["traversal", "duplicate", "reserved"].includes(scenario))
        await writeFile(
          join(artifact.artifactRoot, "bundle-metadata.json"),
          `${JSON.stringify(artifact.metadata, null, 2)}\n`,
        );
      const before = await snapshotTree(context.stateRoot);
      await assertInstallError(
        installer.installBundle(context.stateRoot, artifact),
        "INVALID_BUNDLE",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("malformed active state is rejected without mutation", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    await mkdir(context.stateRoot);
    await writeFile(
      join(context.stateRoot, "active-install.json"),
      '{"schemaVersion":2}\n',
    );
    const candidate = await createArtifact(
      context.artifactsRoot,
      "malformed-state",
      firstEntries,
    );
    const before = await snapshotTree(context.stateRoot);
    await assertInstallError(
      installer.installBundle(context.stateRoot, candidate),
      "INVALID_STATE",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("all journal-published ordinary failures roll back immediately", async () => {
  await withFixture(async (probe) => {
    const { installer } = await installBaseline(probe);
    const upgrade = await createArtifact(
      probe.artifactsRoot,
      "probe-upgrade",
      upgradeEntries,
    );
    const checkpoints = [];
    installer.__setInstallCheckpointHookForTests((checkpoint) => {
      if (
        !checkpoint.startsWith("preimage:") &&
        checkpoint !== "post-commit-cleanup"
      )
        checkpoints.push(checkpoint);
    });
    await installer.installBundle(probe.stateRoot, upgrade);
    installer.__setInstallCheckpointHookForTests(undefined);
    assert.deepEqual(checkpoints, [
      "journal-published",
      "operation:1",
      "operation:2",
      "operation:3",
      "active-metadata-published",
      "installation-verified",
    ]);

    for (const checkpoint of checkpoints) {
      await withFixture(async (context) => {
        const baseline = await installBaseline(context);
        const candidate = await createArtifact(
          context.artifactsRoot,
          `failure-${checkpoint}`,
          upgradeEntries,
        );
        const ownedBefore = await Promise.all(
          firstEntries.map(async (entry) => [
            entry.path,
            await readFile(join(context.stateRoot, "codex-home", entry.path)),
            (await lstat(join(context.stateRoot, "codex-home", entry.path)))
              .mode & 0o777,
          ]),
        );
        baseline.installer.__setInstallCheckpointHookForTests((seen) => {
          if (seen === checkpoint) throw new Error("injected ordinary failure");
        });
        await assertInstallError(
          baseline.installer.installBundle(context.stateRoot, candidate),
          "INSTALL_FAILED",
        );
        baseline.installer.__setInstallCheckpointHookForTests(undefined);
        for (const [path, bytes, mode] of ownedBefore) {
          assert.deepEqual(
            await readFile(join(context.stateRoot, "codex-home", path)),
            bytes,
            checkpoint,
          );
          assert.equal(
            (await lstat(join(context.stateRoot, "codex-home", path))).mode &
              0o777,
            mode,
            checkpoint,
          );
        }
        await assert.rejects(
          lstat(join(context.stateRoot, "codex-home/new.txt")),
          { code: "ENOENT" },
        );
        assert.deepEqual(
          await snapshotProtected(context.stateRoot),
          baseline.protectedBefore,
        );
        await assert.rejects(
          lstat(join(context.stateRoot, "install-journal.json")),
          { code: "ENOENT" },
        );
        await assert.rejects(
          lstat(join(context.stateRoot, "install-preimages")),
          { code: "ENOENT" },
        );
      });
    }
  });
});

test("rollback failure retains journal and preimages with both causes", async () => {
  await withFixture(async (context) => {
    const { installer } = await installBaseline(context);
    const upgrade = await createArtifact(
      context.artifactsRoot,
      "rollback-failure",
      upgradeEntries,
    );
    installer.__setInstallCheckpointHookForTests(async (checkpoint) => {
      if (checkpoint === "operation:2") {
        await chmod(join(context.stateRoot, "codex-home"), 0o500);
        throw new Error("primary failure");
      }
    });
    await assert.rejects(
      installer.installBundle(context.stateRoot, upgrade),
      (error) => {
        assert.equal(error?.code, "ROLLBACK_FAILED");
        assert.equal(error?.cause?.message, "primary failure");
        assert.equal(error?.rollbackCause instanceof Error, true);
        return true;
      },
    );
    await lstat(join(context.stateRoot, "install-journal.json"));
    assert.ok(
      (await readdir(join(context.stateRoot, "install-preimages"))).length > 0,
    );
    await chmod(join(context.stateRoot, "codex-home"), 0o700);
    await installer.recoverInterruptedInstall(context.stateRoot);
  });
});

async function interruptInstall(stateRoot, artifact, checkpoint) {
  const moduleUrl = new URL("../../dist/bundle/install.js", import.meta.url)
    .href;
  const script = `
    import { readFile } from "node:fs/promises";
    const module = await import(${JSON.stringify(moduleUrl)});
    const artifact = JSON.parse(await readFile(process.argv[1], "utf8"));
    module.__setInstallCheckpointHookForTests(async (seen) => {
      if (seen === process.argv[2]) {
        process.stdout.write("INTERRUPT_READY\\n");
        await new Promise(() => {});
      }
    });
    await module.installBundle(process.argv[3], artifact);
  `;
  const descriptor = join(
    dirname(artifact.artifactRoot),
    `child-${checkpoint.replaceAll(":", "-")}.json`,
  );
  await writeFile(descriptor, JSON.stringify(artifact));
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, descriptor, checkpoint, stateRoot],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("INTERRUPT_READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(
        new Error(
          `child exited early code=${code} signal=${signal} stderr=${stderr}`,
        ),
      ),
    );
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("parent recovery is idempotent after both process interruption windows", async () => {
  for (const checkpoint of ["operation:1", "active-metadata-published"]) {
    await withFixture(async (context) => {
      const { installer, first, protectedBefore } =
        await installBaseline(context);
      const upgrade = await createArtifact(
        context.artifactsRoot,
        `interrupt-${checkpoint}`,
        upgradeEntries,
      );
      await interruptInstall(context.stateRoot, upgrade, checkpoint);
      const interrupted = await snapshotTree(context.stateRoot);
      await assertInstallError(
        installer.installBundle(context.stateRoot, upgrade),
        "RECOVERY_REQUIRED",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), interrupted);
      assert.equal(
        (await lstat(join(context.stateRoot, "install-journal.json"))).mode &
          0o777,
        0o600,
      );
      const transactionNames = await readdir(
        join(context.stateRoot, "install-preimages"),
      );
      assert.equal(transactionNames.length, 1);
      const transactionRoot = join(
        context.stateRoot,
        "install-preimages",
        transactionNames[0],
      );
      assert.equal((await lstat(transactionRoot)).mode & 0o777, 0o700);
      for (const name of await readdir(transactionRoot))
        assert.equal(
          (await lstat(join(transactionRoot, name))).mode & 0o777,
          0o600,
        );
      await installer.recoverInterruptedInstall(context.stateRoot);
      await installer.recoverInterruptedInstall(context.stateRoot);
      assert.equal(
        JSON.parse(
          await readFile(
            join(context.stateRoot, "active-install.json"),
            "utf8",
          ),
        ).bundleDigest,
        first.metadata.bundleDigest,
      );
      for (const entry of firstEntries)
        assert.equal(
          await readFile(
            join(context.stateRoot, "codex-home", entry.path),
            "utf8",
          ),
          entry.content,
        );
      await assert.rejects(
        lstat(join(context.stateRoot, "codex-home/new.txt")),
        { code: "ENOENT" },
      );
      assert.deepEqual(
        await snapshotProtected(context.stateRoot),
        protectedBefore,
      );
      await assert.rejects(
        lstat(join(context.stateRoot, "install-journal.json")),
        { code: "ENOENT" },
      );
    });
  }
});

test("a schema 1 install journal is recovered rather than rejected", async () => {
  await withFixture(async (context) => {
    const { installer } = await installBaseline(context);
    // config.toml is identical in both bundles, so the previous release and
    // this one agree on the operation set and the journal below is a faithful
    // schema 1 record rather than a shape that never existed.
    const upgrade = await createArtifact(
      context.artifactsRoot,
      "legacy-journal",
      firstEntries.map((entry) =>
        entry.path === "AGENTS.md"
          ? { ...entry, content: "legacy journal instructions\n" }
          : entry,
      ),
    );
    await interruptInstall(context.stateRoot, upgrade, "operation:1");
    const journalPath = join(context.stateRoot, "install-journal.json");
    const journal = await readJournalFixture(context.stateRoot);
    const downgrade = (active) =>
      active === null
        ? null
        : {
            schemaVersion: 1,
            bundleDigest: active.bundleDigest,
            files: active.files.map(({ path, mode, sha256 }) => ({
              path,
              mode,
              sha256,
            })),
          };
    await writeCanonicalControl(journalPath, {
      ...journal,
      previousActive: downgrade(journal.previousActive),
      candidateActive: downgrade(journal.candidateActive),
    });

    await installer.recoverInterruptedInstall(context.stateRoot);

    await assert.rejects(lstat(journalPath), { code: "ENOENT" });
    assert.equal(
      await readFile(join(context.stateRoot, "codex-home/AGENTS.md"), "utf8"),
      "first instructions\n",
    );
  });
});

test("recovery conflict performs zero mutation", async () => {
  await withFixture(async (context) => {
    const { installer } = await installBaseline(context);
    const upgrade = await createArtifact(
      context.artifactsRoot,
      "recovery-conflict",
      upgradeEntries,
    );
    await interruptInstall(context.stateRoot, upgrade, "operation:1");
    await writeFile(
      join(context.stateRoot, "codex-home/AGENTS.md"),
      "third party\n",
    );
    const before = await snapshotTree(context.stateRoot);
    await assertInstallError(
      installer.recoverInterruptedInstall(context.stateRoot),
      "RECOVERY_CONFLICT",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("inspectInstallState is a strictly read-only stable snapshot", async () => {
  await withFixture(async (context) => {
    const { installer, first } = await installBaseline(context);
    const before = await snapshotTree(context.stateRoot);
    const inspection = await installer.inspectInstallState(context.stateRoot);
    assert.deepEqual(inspection, {
      active: {
        schemaVersion: 2,
        bundleDigest: first.metadata.bundleDigest,
        files: first.metadata.files.map((file) => ({
          ...file,
          lifecycle:
            file.path === "config.toml" ? "reset-before-run" : "immutable",
        })),
      },
      journal: null,
      issues: [],
    });
    assert.deepEqual(
      await installer.inspectInstallState(context.stateRoot),
      inspection,
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

async function readJournalFixture(stateRoot) {
  return JSON.parse(
    await readFile(join(stateRoot, "install-journal.json"), "utf8"),
  );
}

async function writeCanonicalControl(path, value, mode = 0o600) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(path, mode);
}

test("rejects nonordinary control ancestors without chmod outside stateRoot", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    const external = join(context.root, "external-control");
    await mkdir(external, { mode: 0o751 });
    await mkdir(context.stateRoot);
    await symlink(external, join(context.stateRoot, "install-preimages"));
    const candidate = await createArtifact(
      context.artifactsRoot,
      "external-control",
      firstEntries,
    );
    const before = await snapshotTree(context.root);
    const externalMode = (await lstat(external)).mode & 0o777;

    await assertInstallError(
      installer.installBundle(context.stateRoot, candidate),
      "INVALID_STATE",
    );

    assert.equal((await lstat(external)).mode & 0o777, externalMode);
    assert.deepEqual(await snapshotTree(context.root), before);
  });
});

test("recovery rejects forged and third-party created directories without mutation", async () => {
  for (const scenario of ["forged-unrelated", "third-party-same-path"]) {
    await withFixture(async (context) => {
      const { installer } = await installBaseline(context);
      const candidate = await createArtifact(
        context.artifactsRoot,
        `directory-${scenario}`,
        [
          ...firstEntries,
          { path: "generated/nested/new.txt", content: "new\n" },
        ],
      );
      await interruptInstall(context.stateRoot, candidate, "journal-published");
      const journalPath = join(context.stateRoot, "install-journal.json");
      const journal = await readJournalFixture(context.stateRoot);
      assert.ok(Array.isArray(journal.directoryWitnesses));
      assert.ok(
        journal.directoryWitnesses.every(
          (witness) =>
            typeof witness.path === "string" &&
            typeof witness.dev === "string" &&
            typeof witness.ino === "string",
        ),
      );
      if (scenario === "forged-unrelated") {
        journal.createdDirectories.push("codex-home/unrelated");
        journal.createdDirectories.sort();
        await writeCanonicalControl(journalPath, journal);
      } else {
        await mkdir(join(context.stateRoot, "codex-home/generated"));
      }
      const before = await snapshotTree(context.stateRoot);

      await assertInstallError(
        installer.recoverInterruptedInstall(context.stateRoot),
        scenario === "forged-unrelated" ? "INVALID_STATE" : "RECOVERY_CONFLICT",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("preimages publish atomically and incomplete material fails closed", async () => {
  await withFixture(async (context) => {
    const baseline = await installBaseline(context);
    const upgrade = await createArtifact(
      context.artifactsRoot,
      "preimage-publication",
      upgradeEntries,
    );
    const before = await snapshotTree(context.stateRoot);
    baseline.installer.__setInstallCheckpointHookForTests((checkpoint) => {
      if (checkpoint === "preimage:1") throw new Error("preimage interruption");
    });

    await assertInstallError(
      baseline.installer.installBundle(context.stateRoot, upgrade),
      "INSTALL_FAILED",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("nonexistent stateRoot rollback restores exact absence and journals control creation", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    const candidate = await createArtifact(
      context.artifactsRoot,
      "absent-state-root",
      firstEntries,
    );
    installer.__setInstallCheckpointHookForTests((checkpoint) => {
      if (checkpoint === "journal-published") {
        return readJournalFixture(context.stateRoot).then((journal) => {
          assert.equal(journal.stateRootCreated, true);
          assert.equal(journal.preimagesRootCreated, true);
          throw new Error("rollback absent root");
        });
      }
    });

    await assertInstallError(
      installer.installBundle(context.stateRoot, candidate),
      "INSTALL_FAILED",
    );
    await assert.rejects(lstat(context.stateRoot), { code: "ENOENT" });
  });
});

test("post-commit cleanup failure resolves committed and leaves an inspection issue", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    await seedProtected(context.stateRoot);
    const candidate = await createArtifact(
      context.artifactsRoot,
      "post-commit-cleanup",
      firstEntries,
    );
    installer.__setInstallCheckpointHookForTests((checkpoint) => {
      if (checkpoint === "post-commit-cleanup")
        throw new Error("cleanup unavailable");
    });

    await installer.installBundle(context.stateRoot, candidate);
    installer.__setInstallCheckpointHookForTests(undefined);

    assert.equal(
      JSON.parse(
        await readFile(join(context.stateRoot, "active-install.json"), "utf8"),
      ).bundleDigest,
      candidate.metadata.bundleDigest,
    );
    const inspection = await installer.inspectInstallState(context.stateRoot);
    assert.deepEqual(inspection.issues, ["ORPHAN_TRANSACTION_CONTROL"]);
    await assertInstallError(
      installer.installBundle(context.stateRoot, candidate),
      "INVALID_STATE",
    );
  });
});

test("inspection reports drift and invalid recovery material without mutation", async () => {
  for (const scenario of ["managed-drift", "invalid-preimage"]) {
    await withFixture(async (context) => {
      const { installer } = await installBaseline(context);
      if (scenario === "managed-drift") {
        await writeFile(
          join(context.stateRoot, "codex-home/AGENTS.md"),
          "inspection drift\n",
        );
      } else {
        const upgrade = await createArtifact(
          context.artifactsRoot,
          "inspection-preimage",
          upgradeEntries,
        );
        await interruptInstall(context.stateRoot, upgrade, "operation:1");
        const transaction = (
          await readdir(join(context.stateRoot, "install-preimages"))
        )[0];
        const preimage = (
          await readdir(
            join(context.stateRoot, "install-preimages", transaction),
          )
        ).find((name) => name.endsWith(".preimage"));
        await chmod(
          join(context.stateRoot, "install-preimages", transaction, preimage),
          0o644,
        );
      }
      const before = await snapshotTree(context.stateRoot);

      const inspection = await installer.inspectInstallState(context.stateRoot);

      assert.ok(
        inspection.issues.includes(
          scenario === "managed-drift"
            ? "MANAGED_STATE_DRIFT"
            : "INVALID_RECOVERY_MATERIAL",
        ),
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("same digest requires exact candidate active metadata", async () => {
  await withFixture(async (context) => {
    const { installer, first } = await installBaseline(context);
    const activePath = join(context.stateRoot, "active-install.json");
    const forged = {
      schemaVersion: 1,
      bundleDigest: first.metadata.bundleDigest,
      files: [],
    };
    await writeCanonicalControl(activePath, forged);
    const before = await snapshotTree(context.stateRoot);

    await assertInstallError(
      installer.installBundle(context.stateRoot, first),
      "INVALID_STATE",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});

test("candidate paths are ASCII and case-fold unique before state mutation", async () => {
  for (const scenario of ["case-fold", "non-ascii"]) {
    await withFixture(async (context) => {
      const installer = requireInstaller();
      const entries =
        scenario === "case-fold"
          ? [
              { path: "A.txt", content: "upper\n" },
              { path: "a.txt", content: "lower\n" },
            ]
          : [{ path: "café.txt", content: "unicode\n" }];
      const candidate = await createArtifact(
        context.artifactsRoot,
        `portable-${scenario}`,
        entries,
      );
      const before = await snapshotTree(context.stateRoot);

      await assertInstallError(
        installer.installBundle(context.stateRoot, candidate),
        "INVALID_BUNDLE",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("control files and directories require owner-only modes", async () => {
  for (const scenario of [
    "journal-0644",
    "preimages-0755",
    "transaction-0755",
    "staged-nested-0755",
  ]) {
    await withFixture(async (context) => {
      const { installer } = await installBaseline(context);
      const upgrade = await createArtifact(
        context.artifactsRoot,
        `control-mode-${scenario}`,
        scenario === "staged-nested-0755"
          ? [...firstEntries, { path: "generated/new.txt", content: "new\n" }]
          : upgradeEntries,
      );
      await interruptInstall(context.stateRoot, upgrade, "journal-published");
      const preimagesRoot = join(context.stateRoot, "install-preimages");
      if (scenario === "journal-0644")
        await chmod(join(context.stateRoot, "install-journal.json"), 0o644);
      else if (scenario === "preimages-0755") await chmod(preimagesRoot, 0o755);
      else {
        const transaction = (await readdir(preimagesRoot))[0];
        await chmod(
          scenario === "transaction-0755"
            ? join(preimagesRoot, transaction)
            : join(preimagesRoot, transaction, "created", "codex-home"),
          0o755,
        );
      }
      const before = await snapshotTree(context.stateRoot);

      await assertInstallError(
        installer.recoverInterruptedInstall(context.stateRoot),
        scenario === "staged-nested-0755"
          ? "RECOVERY_CONFLICT"
          : "INVALID_STATE",
      );
      assert.deepEqual(await snapshotTree(context.stateRoot), before, scenario);
    });
  }
});

test("allows a stateRoot below an external symlink alias while preserving direct-control safety", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    const realParent = join(context.root, "real-state-parent");
    const aliasParent = join(context.root, "state-parent-alias");
    await mkdir(realParent);
    await symlink(realParent, aliasParent);
    const aliasedStateRoot = join(aliasParent, "state");
    const candidate = await createArtifact(
      context.artifactsRoot,
      "aliased-state-root",
      firstEntries,
    );

    await installer.installBundle(aliasedStateRoot, candidate);

    assert.equal(
      await readFile(join(aliasedStateRoot, "codex-home/config.toml"), "utf8"),
      "model = 'first'\n",
    );
    const externalControl = join(context.root, "aliased-external-control");
    await mkdir(externalControl, { mode: 0o751 });
    const unsafeStateRoot = join(aliasParent, "unsafe-state");
    await mkdir(unsafeStateRoot);
    await symlink(externalControl, join(unsafeStateRoot, "install-preimages"));
    const externalMode = (await lstat(externalControl)).mode & 0o777;
    const before = await snapshotTree(context.root);
    await assertInstallError(
      installer.installBundle(unsafeStateRoot, candidate),
      "INVALID_STATE",
    );
    assert.equal((await lstat(externalControl)).mode & 0o777, externalMode);
    assert.deepEqual(await snapshotTree(context.root), before);
  });
});

test("accepts an empty owner-only preimages root without orphan issues", async () => {
  await withFixture(async (context) => {
    const installer = requireInstaller();
    await mkdir(join(context.stateRoot, "install-preimages"), {
      recursive: true,
      mode: 0o700,
    });
    const candidate = await createArtifact(
      context.artifactsRoot,
      "empty-preimages-root",
      firstEntries,
    );

    await installer.installBundle(context.stateRoot, candidate);
    const beforeNoOp = await snapshotTree(context.stateRoot);
    const inspection = await installer.inspectInstallState(context.stateRoot);
    await installer.installBundle(context.stateRoot, candidate);

    assert.deepEqual(inspection.issues, []);
    assert.deepEqual(await snapshotTree(context.stateRoot), beforeNoOp);
    assert.deepEqual(
      await readdir(join(context.stateRoot, "install-preimages")),
      [],
    );
  });
});

test("recovery rejects unexpected staged control directories without mutation", async () => {
  await withFixture(async (context) => {
    const { installer } = await installBaseline(context);
    const candidate = await createArtifact(
      context.artifactsRoot,
      "unexpected-staged-directory",
      [...firstEntries, { path: "generated/nested/new.txt", content: "new\n" }],
    );
    await interruptInstall(context.stateRoot, candidate, "journal-published");
    const transaction = (
      await readdir(join(context.stateRoot, "install-preimages"))
    )[0];
    await mkdir(
      join(
        context.stateRoot,
        "install-preimages",
        transaction,
        "created",
        "unexpected",
      ),
      { mode: 0o700 },
    );
    const before = await snapshotTree(context.stateRoot);

    await assertInstallError(
      installer.recoverInterruptedInstall(context.stateRoot),
      "RECOVERY_CONFLICT",
    );
    assert.deepEqual(await snapshotTree(context.stateRoot), before);
  });
});
