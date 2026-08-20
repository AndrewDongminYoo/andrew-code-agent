import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pathsModule = await import("../../dist/runtime/paths.js").catch(
  () => null,
);

function requirePaths() {
  assert.notEqual(
    pathsModule,
    null,
    "the built runtime paths module must be available",
  );
  return pathsModule;
}

async function withFixture(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-paths-")),
  );
  const home = join(root, "home");
  const source = join(root, "source");
  const binDirectory = join(root, "bin");
  const codexBin = join(binDirectory, "codex");
  await mkdir(home);
  await mkdir(source);
  await mkdir(binDirectory);
  await writeFile(codexBin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(codexBin, 0o700);
  try {
    await run({ root, home, source, binDirectory, codexBin });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolves all environment overrides canonically without creating state", async () => {
  await withFixture(async ({ root, home, source, codexBin }) => {
    const sourceLink = join(root, "source-link");
    await symlink(source, sourceLink);
    const stateRoot = join(root, "missing", "state");
    const resolved = await requirePaths().resolveRuntimePaths({
      platform: "darwin",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        ANDREW_AGENT_CODEX_SOURCE: sourceLink,
        ANDREW_AGENT_STATE_ROOT: stateRoot,
        ANDREW_AGENT_CODEX_BIN: codexBin,
      },
    });

    assert.deepEqual(resolved, {
      sourceRoot: source,
      stateRoot,
      codexHome: join(stateRoot, "codex-home"),
      codexBin,
    });
    await assert.rejects(lstat(stateRoot), { code: "ENOENT" });
  });
});

test("uses macOS defaults and finds codex on PATH", async () => {
  await withFixture(async ({ home, binDirectory, codexBin }) => {
    const source = join(home, ".codex");
    await mkdir(source);
    const resolved = await requirePaths().resolveRuntimePaths({
      platform: "darwin",
      env: { HOME: home, PATH: binDirectory },
    });

    assert.equal(resolved.sourceRoot, source);
    assert.equal(
      resolved.stateRoot,
      join(home, "Library/Application Support/andrew-code-agent"),
    );
    assert.equal(resolved.codexHome, join(resolved.stateRoot, "codex-home"));
    assert.equal(resolved.codexBin, codexBin);
  });
});

test("rejects unsupported platforms, relative overrides, and overlapping roots", async () => {
  await withFixture(async ({ home, source, codexBin }) => {
    const baseEnv = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      ANDREW_AGENT_CODEX_SOURCE: source,
      ANDREW_AGENT_CODEX_BIN: codexBin,
    };
    await assert.rejects(
      requirePaths().resolveRuntimePaths({ platform: "linux", env: baseEnv }),
      { code: "UNSUPPORTED_PLATFORM" },
    );
    await assert.rejects(
      requirePaths().resolveRuntimePaths({
        platform: "darwin",
        env: { ...baseEnv, ANDREW_AGENT_STATE_ROOT: "relative" },
      }),
      { code: "RUNTIME_PATH_INVALID" },
    );
    await assert.rejects(
      requirePaths().resolveRuntimePaths({
        platform: "darwin",
        env: { ...baseEnv, ANDREW_AGENT_STATE_ROOT: join(source, "state") },
      }),
      { code: "RUNTIME_PATH_OVERLAP" },
    );
  });
});

test("initializes only owner-only ordinary state directories and rejects symlinks", async () => {
  await withFixture(async ({ root, home, source, codexBin }) => {
    const stateRoot = join(root, "state");
    const paths = await requirePaths().resolveRuntimePaths({
      platform: "darwin",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        ANDREW_AGENT_CODEX_SOURCE: source,
        ANDREW_AGENT_STATE_ROOT: stateRoot,
        ANDREW_AGENT_CODEX_BIN: codexBin,
      },
    });
    await requirePaths().initializeRuntimeState(paths);
    for (const directory of [
      stateRoot,
      join(stateRoot, "codex-home"),
      join(stateRoot, "threads"),
    ]) {
      const metadata = await lstat(directory);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.mode & 0o777, 0o700);
      assert.equal(metadata.uid, process.getuid());
    }

    const unsafeRoot = join(root, "unsafe-state");
    await symlink(stateRoot, unsafeRoot);
    await assert.rejects(
      requirePaths().initializeRuntimeState({
        ...paths,
        stateRoot: unsafeRoot,
        codexHome: join(unsafeRoot, "codex-home"),
      }),
      { code: "RUNTIME_STATE_UNSAFE" },
    );
    assert.equal(
      (await readFile(codexBin, "utf8")).startsWith("#!/bin/sh"),
      true,
    );
  });
});
