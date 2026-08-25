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

test("rejects a pre-existing permissive state root without chmod", async () => {
  await withFixture(async ({ root, home, source, codexBin }) => {
    const stateRoot = join(root, "permissive-state");
    await mkdir(stateRoot, { mode: 0o755 });
    await chmod(stateRoot, 0o755);
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

    await assert.rejects(requirePaths().initializeRuntimeState(paths), {
      code: "RUNTIME_STATE_UNSAFE",
    });
    assert.equal((await lstat(stateRoot)).mode & 0o777, 0o755);
  });
});

test("the Oracle root is resolved only when its capability is requested", async () => {
  await withFixture(async ({ root, home, source, codexBin }) => {
    const state = join(root, "state");
    const wiki = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-wiki-")));
    const baseEnv = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      ANDREW_AGENT_CODEX_SOURCE: source,
      ANDREW_AGENT_CODEX_BIN: codexBin,
      ANDREW_AGENT_STATE_ROOT: state,
    };
    const resolve = (env, capabilities) =>
      requirePaths().resolveRuntimePaths({ platform: "darwin", env, capabilities });
    try {
      // Requested: canonicalized like the other two roots.
      const viaSymlink = join(root, "wiki-link");
      await symlink(wiki, viaSymlink);
      const enabled = await resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: viaSymlink }, ["oracle"]);
      assert.equal(enabled.oracleRoot, wiki);

      // Not requested: the variable is never read, so a broken value cannot
      // fail an unrelated run. This is what keeps a no-flag run identical to
      // v0.1, and it is the case that fails if the gate is ever removed.
      for (const broken of [join(root, "missing"), join(state, "inside"), join(source, "inside"), "relative", ""]) {
        const paths = await resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: broken }, []);
        assert.equal(paths.oracleRoot, undefined, broken);
        assert.equal(paths.stateRoot, state);
      }
      const omitted = await resolve(baseEnv, []);
      assert.equal(omitted.oracleRoot, undefined);
      assert.equal(Object.hasOwn(omitted, "oracleRoot"), false);

      // Requested but unusable: rejected here, not deferred to the renderer.
      for (const [value, code] of [[undefined, "RUNTIME_PATH_INVALID"], ["", "RUNTIME_PATH_INVALID"], ["relative", "RUNTIME_PATH_INVALID"], [join(root, "missing"), "RUNTIME_PATH_INVALID"], [codexBin, "RUNTIME_PATH_INVALID"]]) {
        await assert.rejects(resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: value }, ["oracle"]), { code }, String(value));
      }

      // Each pairing is refused under its own code, in both directions.
      await mkdir(join(state, "inside"), { recursive: true });
      await mkdir(join(source, "inside"), { recursive: true });
      await assert.rejects(resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: join(state, "inside") }, ["oracle"]), { code: "ORACLE_ROOT_OVERLAPS_STATE" });
      await assert.rejects(resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: join(source, "inside") }, ["oracle"]), { code: "ORACLE_ROOT_OVERLAPS_SOURCE" });
      await assert.rejects(resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: root, ANDREW_AGENT_STATE_ROOT: join(root, "state") }, ["oracle"]), { code: "ORACLE_ROOT_OVERLAPS_STATE" });
      await assert.rejects(resolve({ ...baseEnv, ANDREW_AGENT_ORACLE_ROOT: root, ANDREW_AGENT_CODEX_SOURCE: source, ANDREW_AGENT_STATE_ROOT: join(tmpdir(), "andrew-agent-elsewhere-state") }, ["oracle"]), { code: "ORACLE_ROOT_OVERLAPS_SOURCE" });

      // initializeRuntimeState re-validates it the way it re-validates the
      // other roots, including which code each fault carries: a non-canonical
      // form is RUNTIME_STATE_UNSAFE, while a path that cannot be canonicalized
      // at all keeps canonicalExistingDirectory's own RUNTIME_PATH_INVALID,
      // exactly as sourceRoot does on the line above it.
      await assert.rejects(requirePaths().initializeRuntimeState({ ...enabled, oracleRoot: viaSymlink }), { code: "RUNTIME_STATE_UNSAFE" });
      await assert.rejects(requirePaths().initializeRuntimeState({ ...enabled, oracleRoot: "relative" }), { code: "RUNTIME_STATE_UNSAFE" });
      await assert.rejects(requirePaths().initializeRuntimeState({ ...enabled, oracleRoot: join(root, "missing") }), { code: "RUNTIME_PATH_INVALID" });
      await assert.rejects(requirePaths().initializeRuntimeState({ ...enabled, oracleRoot: join(state, "inside") }), { code: "RUNTIME_STATE_UNSAFE" });
    } finally {
      await rm(wiki, { recursive: true, force: true });
    }
  });
});
