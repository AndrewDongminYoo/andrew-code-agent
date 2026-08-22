import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const doctorModule = await import("../../dist/commands/doctor.js").catch(
  () => null,
);
const artifactModule = await import("../../dist/bundle/artifact.js");
const installModule = await import("../../dist/bundle/install.js");
const lockModule = await import("../../dist/runtime/lock.js");
const sourceFixture = new URL("../fixtures/source-codex/clean/", import.meta.url);
const authFileName = ["auth", ".json"].join("");

const findingOrder = [
  "PRODUCT_VERSION",
  "PLATFORM_VERSION",
  "SOURCE_PATH",
  "SOURCE_REVISION",
  "SOURCE_DIRTY",
  "MANIFEST_VALID",
  "CANDIDATE_BUNDLE",
  "ACTIVE_INSTALL",
  "BUNDLE_DIGEST",
  "CODEX_VERSION",
  "SCHEMA_COMPATIBILITY",
  "AUTH_CONFIGURATION",
  "PORTABLE_CONFIG_CLOSURE",
  "HOOK_READINESS",
  "INTERPRETER_READINESS",
  "STRICT_CONFIG",
  "OPTIONAL_ORACLE",
  "OPTIONAL_SHARED_MEMORY",
  "PROCESS_LOCK",
  "INSTALL_JOURNAL",
  "SCRATCH_CLEANUP",
];

const fixtureManifest = `allowed_tokens = ["HOME", "CODEX_HOME", "WORKSPACE_ROOT", "LLM_WIKI_ROOT"]
config_keys = ["model", "model_reasoning_effort", "personality", "service_tier", "agents.max_depth", "features.goals", "features.hooks", "features.multi_agent"]
config_source = "config.toml"
schema_version = 1

[[capabilities]]
instruction_sections = ["Consult the Oracle"]
name = "oracle"
read_only = true
required_tokens = ["LLM_WIKI_ROOT"]

[config_overrides]
analytics_enabled = false
approval_policy = "on-request"
approvals_reviewer = "user"

[[files]]
mode = "0644"
source = "AGENTS.md"
target = "AGENTS.md"

[[files]]
mode = "0644"
source = "agents/advisor.toml"
target = "agents/advisor.toml"

[[files]]
capability = "oracle"
mode = "0644"
source = "agents/oracle.toml"
target = "agents/oracle.toml"

[[files]]
mode = "0755"
source = "hooks/safety.sh"
target = "hooks/safety.sh"

[[files]]
mode = "0644"
source = "rules/default.rules"
target = "rules/default.rules"

[forbidden]
literals = ["/Users/dongminyu", "/Volumes/dongminyu"]
path_segments = ["auth\\u002Ejson", "sessions", "logs", "cache", "rollout", "hooks.state", "desktop"]
pattern_ids = ["private-key", "credential-assignment", "github-token", "openai-api-key"]

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
rendered_command = 'bash "\${CODEX_HOME}/hooks/safety.sh"'
required_script = "hooks/safety.sh"
source_command = 'bash "$HOME/.codex/hooks/safety.sh"'
timeout = 5

[[requirements]]
arguments = ["-c", "exit 0"]
executable = "/bin/sh"
name = "shell"
`;

function requireDoctor() {
  assert.notEqual(
    doctorModule,
    null,
    "the built doctor module must be available",
  );
  return doctorModule;
}

async function createFixture(options = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-doctor-test-")),
  );
  const sourceRoot = join(root, "source");
  const stateRoot = join(root, "state");
  const scratchParent = join(root, "scratch");
  const setupArtifacts = join(root, "setup-artifacts");
  const binRoot = join(root, "bin");
  await cp(sourceFixture, sourceRoot, { recursive: true });
  await mkdir(join(sourceRoot, "hooks"), { recursive: true });
  await mkdir(join(sourceRoot, "agents"), { recursive: true });
  await mkdir(scratchParent, { mode: 0o700 });
  await mkdir(setupArtifacts, { mode: 0o700 });
  await mkdir(binRoot, { mode: 0o700 });
  await writeFile(
    join(sourceRoot, "AGENTS.md"),
    "# Fixture Instructions\n\n## Core Rules\n\nKeep the base profile portable.\n\n## Consult the Oracle\n\nUse ${LLM_WIKI_ROOT} only for read-only precedent retrieval.\n\n## Closing Rules\n\nKeep working without the optional adapter.\n",
  );
  await writeFile(
    join(sourceRoot, "agents", "oracle.toml"),
    'name = "oracle"\nwiki_root = "${LLM_WIKI_ROOT}"\n',
  );
  await writeFile(
    join(sourceRoot, "hooks", "safety.sh"),
    '#!/bin/sh\nprintf "%s\\n" "${HOME}/.codex"\n',
  );
  await chmod(join(sourceRoot, "hooks", "safety.sh"), 0o755);
  await writeFile(join(sourceRoot, "agent-bundle.toml"), fixtureManifest);
  await execFile("git", ["init", "--quiet", sourceRoot]);
  await execFile("git", [
    "-C",
    sourceRoot,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFile("git", [
    "-C",
    sourceRoot,
    "config",
    "user.name",
    "Test User",
  ]);
  await execFile("git", ["-C", sourceRoot, "add", "--all"]);
  await execFile("git", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);

  const codexBin = join(binRoot, "codex");
  await writeCodexExecutable(codexBin, options.codex ?? {});
  const paths = { sourceRoot, stateRoot, codexHome: join(stateRoot, "codex-home"), codexBin };
  const buildInput = {
    sourceRoot,
    artifactsRoot: setupArtifacts,
    requestedCapabilities: [],
    capabilityInputs: {},
    builderVersion: "0.1.0-test",
  };
  if (options.active !== false) {
    const artifact = await artifactModule.buildBundle(buildInput);
    await installModule.installBundle(stateRoot, artifact);
  } else {
    await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  }
  await writeAuth(paths.codexHome, options.auth ?? { OPENAI_API_KEY: "fixture-secret" });
  await rm(setupArtifacts, { recursive: true, force: true });

  return {
    root,
    paths,
    scratchParent,
    dependencies: {
      productVersion: "0.1.0",
      platform: "darwin",
      platformVersion: "15.6.1",
      paths,
      builderVersion: "0.1.0-test",
      requestedCapabilities: [],
      capabilityInputs: {},
      scratchParent,
      commandTimeoutMs: 500,
    },
  };
}

async function writeCodexExecutable(path, options = {}) {
  const version = options.version ?? "codex-cli 0.148.0";
  const strict = options.strict ?? "success";
  const markerPath = options.markerPath;
  const invocationMarker =
    markerPath === undefined
      ? ""
      : `printf 'called\\n' >> ${JSON.stringify(markerPath)}`;
  const versionBody =
    options.versionBehavior === "stderr"
      ? `printf '%s\\n' ${JSON.stringify(version)} >&2`
      : options.versionBehavior === "overflow"
        ? `printf '%s\\n' ${JSON.stringify(version)}
/usr/bin/yes x | /usr/bin/head -c 70000 >&2`
        : options.versionBehavior === "write-home"
          ? `printf 'probe\\n' > "$CODEX_HOME/version-probe-canary"
printf '%s\\n' ${JSON.stringify(version)}`
          : options.versionBehavior === "late-descendant"
            ? `(trap '' TERM; while :; do :; done) &
printf '%s\\n' "$!" > ${JSON.stringify(markerPath)}
printf '%s\\n' ${JSON.stringify(version)}`
            : options.versionBehavior === "redirected-descendant"
              ? `(trap '' TERM; while :; do :; done) </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > ${JSON.stringify(markerPath)}
printf '%s\\n' ${JSON.stringify(version)}`
            : `printf '%s\\n' ${JSON.stringify(version)}`;
  const strictBody =
    strict === "timeout"
      ? "trap '' TERM\nwhile :; do :; done"
      : strict === "late-descendant"
        ? `(trap '' TERM; while :; do :; done) &
printf '%s\\n' "$!" > ${JSON.stringify(markerPath)}
exit 0`
        : strict === "redirected-descendant"
          ? `(trap '' TERM; while :; do :; done) </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > ${JSON.stringify(markerPath)}
exit 0`
      : strict === "failure"
        ? "exit 23"
        : options.strictBody ??
          `test -f "$CODEX_HOME/config.toml" || exit 31
test ! -e "$CODEX_HOME/${authFileName}" || exit 32
exit 0`;
  await writeFile(
    path,
    `#!/bin/sh
${invocationMarker}
if [ "$1" = "--version" ]; then
${versionBody}
  exit 0
fi
if [ "$1" = "app-server" ] && [ "$2" = "--strict-config" ] && [ "$3" = "--listen" ] && [ "$4" = "stdio://" ] && [ "$#" = "4" ]; then
${strictBody}
fi
exit 24
`,
  );
  await chmod(path, 0o755);
}

async function writeAuth(codexHome, value, mode = 0o600) {
  const path = join(codexHome, authFileName);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode });
  await chmod(path, mode);
}

async function commitFile(sourceRoot, path, contents) {
  await writeFile(join(sourceRoot, path), contents);
  await execFile("git", ["-C", sourceRoot, "add", "--", path]);
  await execFile("git", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "-m",
    "fixture change",
  ]);
}

async function snapshotTree(root) {
  const output = [];
  async function visit(path) {
    const metadata = await lstat(path);
    const entry = {
      path: relative(root, path) || ".",
      type: metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "other",
      mode: metadata.mode & 0o777,
    };
    if (metadata.isSymbolicLink()) {
      entry.target = await (await import("node:fs/promises")).readlink(path);
    } else if (metadata.isFile()) {
      entry.bytes = await readFile(path);
    }
    output.push(entry);
    if (metadata.isDirectory()) {
      const names = (await readdir(path)).sort();
      for (const name of names) await visit(join(path, name));
    }
  }
  await visit(root);
  return output;
}

async function runUnchanged(fixture, overrides = {}, hooks) {
  const sourceBefore = await snapshotTree(fixture.paths.sourceRoot);
  const stateBefore = await snapshotTree(fixture.paths.stateRoot);
  const scratchBefore = await snapshotTree(fixture.scratchParent);
  const dependencies = {
    ...fixture.dependencies,
    ...overrides,
  };
  const result =
    hooks === undefined
      ? await requireDoctor().runDoctor(dependencies)
      : await requireDoctor().__runDoctorForTests(dependencies, hooks);
  assert.deepEqual(await snapshotTree(fixture.paths.sourceRoot), sourceBefore);
  assert.deepEqual(await snapshotTree(fixture.paths.stateRoot), stateBefore);
  assert.deepEqual(await snapshotTree(fixture.scratchParent), scratchBefore);
  assertNoSensitiveOutput(result);
  assertStableOrder(result.findings);
  return result;
}

function assertNoSensitiveOutput(result) {
  const rendered = JSON.stringify(result);
  for (const secret of [
    "fixture-secret",
    "fixture-id-token",
    "fixture-access-token",
    "fixture-refresh-token",
  ]) {
    assert.equal(rendered.includes(secret), false);
  }
}

function assertStableOrder(findings) {
  const severity = { blocker: 0, warning: 1, ready: 2 };
  const seen = new Set();
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    assert.equal(seen.has(finding.code), false, `duplicate ${finding.code}`);
    seen.add(finding.code);
    if (index === 0) continue;
    const previous = findings[index - 1];
    const comparison =
      severity[previous.severity] - severity[finding.severity] ||
      findingOrder.indexOf(previous.code) - findingOrder.indexOf(finding.code);
    assert.ok(comparison <= 0, `${previous.code} must sort before ${finding.code}`);
  }
}

function finding(result, code) {
  const found = result.findings.find((entry) => entry.code === code);
  assert.ok(found, `missing finding ${code}`);
  return found;
}

async function withFixture(options, run) {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function runDoctorIsolated(fixture, timeoutMs = 2000) {
  const script = join(fixture.root, "isolated-doctor.mjs");
  await writeFile(
    script,
    `import { runDoctor } from ${JSON.stringify(new URL("../../dist/commands/doctor.js", import.meta.url).href)};\nconst result = await runDoctor(JSON.parse(process.argv[2]));\nprocess.stdout.write(JSON.stringify(result));\n`,
  );
  try {
    const { stdout } = await execFile(
      process.execPath,
      [script, JSON.stringify(fixture.dependencies)],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    return { timedOut: false, result: JSON.parse(stdout) };
  } catch (error) {
    if (error?.killed) return { timedOut: true, result: null };
    throw error;
  }
}

async function assertRecordedProcessWasReaped(markerPath) {
  const pid = Number.parseInt(await readFile(markerPath, "utf8"), 10);
  let alive = true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        alive = false;
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (alive) process.kill(pid, "SIGKILL");
  assert.equal(alive, false, `descendant ${pid} must be reaped`);
}

test("reports a fully ready base installation with optional warnings", async () => {
  await withFixture({}, async (fixture) => {
    const result = await runUnchanged(fixture);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.findings.map((entry) => entry.code).sort(),
      [...findingOrder].sort(),
    );
    assert.equal(finding(result, "OPTIONAL_ORACLE").severity, "warning");
    assert.equal(finding(result, "OPTIONAL_SHARED_MEMORY").severity, "warning");
    for (const entry of result.findings.filter(
      (value) => !value.code.startsWith("OPTIONAL_"),
    )) {
      assert.equal(entry.severity, "ready", entry.code);
    }
  });
});

test("keeps unavailable optional capabilities nonblocking", async () => {
  await withFixture({}, async (fixture) => {
    const result = await runUnchanged(fixture, {
      requestedCapabilities: ["oracle"],
      capabilityInputs: {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(finding(result, "CANDIDATE_BUNDLE").severity, "ready");
    assert.equal(finding(result, "OPTIONAL_ORACLE").severity, "warning");
    assert.equal(finding(result, "OPTIONAL_SHARED_MEMORY").severity, "warning");
  });
});

test("reports Oracle ready only when requested and enabled", async () => {
  await withFixture({}, async (fixture) => {
    const wikiRoot = join(fixture.root, "wiki");
    await mkdir(wikiRoot, { mode: 0o700 });
    const result = await runUnchanged(fixture, {
      requestedCapabilities: ["oracle"],
      capabilityInputs: { oracle: { llmWikiRoot: wikiRoot } },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(finding(result, "OPTIONAL_ORACLE").severity, "ready");
    assert.equal(finding(result, "BUNDLE_DIGEST").severity, "warning");
  });
});

test("classifies unsupported platform, dirty source, invalid manifest, and candidate failure", async (t) => {
  await t.test("unsupported platform", async () => {
    await withFixture({}, async (fixture) => {
      const result = await runUnchanged(fixture, { platform: "linux" });
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "PLATFORM_VERSION").severity, "blocker");
    });
  });
  await t.test("dirty source", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(join(fixture.paths.sourceRoot, "dirty.txt"), "dirty\n");
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "SOURCE_DIRTY").severity, "blocker");
      assert.equal(finding(result, "CANDIDATE_BUNDLE").severity, "blocker");
    });
  });
  await t.test("invalid manifest", async () => {
    await withFixture({}, async (fixture) => {
      await commitFile(fixture.paths.sourceRoot, "agent-bundle.toml", "not = [valid\n");
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "MANIFEST_VALID").severity, "blocker");
      assert.equal(finding(result, "CANDIDATE_BUNDLE").severity, "blocker");
    });
  });
  await t.test("candidate failure", async () => {
    await withFixture({}, async (fixture) => {
      const failing = fixtureManifest.replace(
        'executable = "/bin/sh"',
        'executable = "/definitely/missing/doctor-fixture"',
      );
      await commitFile(fixture.paths.sourceRoot, "agent-bundle.toml", failing);
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "MANIFEST_VALID").severity, "ready");
      assert.equal(finding(result, "CANDIDATE_BUNDLE").severity, "blocker");
      assert.equal(finding(result, "HOOK_READINESS").severity, "blocker");
      assert.equal(finding(result, "INTERPRETER_READINESS").severity, "blocker");
    });
  });
});

test("classifies missing and drifted active installations", async (t) => {
  await t.test("missing active install", async () => {
    await withFixture({ active: false }, async (fixture) => {
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "ACTIVE_INSTALL").severity, "blocker");
      assert.equal(finding(result, "BUNDLE_DIGEST").severity, "blocker");
    });
  });
  await t.test("managed state drift", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(join(fixture.paths.codexHome, "AGENTS.md"), "drift\n");
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "ACTIVE_INSTALL").severity, "blocker");
    });
  });
  await t.test("a reset-before-run rewrite is not drift", async () => {
    await withFixture({}, async (fixture) => {
      const config = join(fixture.paths.codexHome, "config.toml");
      const rendered = await readFile(config, "utf8");
      await writeFile(
        config,
        `${rendered}\n[projects."/tmp/repository"]\ntrust_level = "trusted"\n`,
      );
      await chmod(config, 0o600);
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 0);
      assert.equal(finding(result, "ACTIVE_INSTALL").severity, "ready");
      assert.equal(finding(result, "STRICT_CONFIG").severity, "ready");
    });
  });
  await t.test("a reset-before-run file at an unexpected mode still blocks", async () => {
    await withFixture({}, async (fixture) => {
      await chmod(join(fixture.paths.codexHome, "config.toml"), 0o666);
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 1);
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });
  await t.test("valid candidate difference requires installation", async () => {
    await withFixture({}, async (fixture) => {
      await commitFile(
        fixture.paths.sourceRoot,
        "rules/default.rules",
        "Always preserve the source boundary.\nKeep diagnostics read-only.\n",
      );
      const result = await runUnchanged(fixture);
      assert.equal(result.exitCode, 0);
      assert.equal(finding(result, "ACTIVE_INSTALL").severity, "ready");
      assert.deepEqual(finding(result, "BUNDLE_DIGEST"), {
        severity: "warning",
        code: "BUNDLE_DIGEST",
        message: "The candidate bundle differs from the active installation.",
        remediation: "Install the candidate bundle to make it active.",
      });
    });
  });
  await t.test("active FIFO fails closed without waiting for a writer", async () => {
    await withFixture({}, async (fixture) => {
      const activePath = join(
        fixture.paths.codexHome,
        "hooks",
        "safety.sh",
      );
      await rm(activePath);
      await execFile("/usr/bin/mkfifo", [activePath]);
      await chmod(activePath, 0o755);
      const sourceBefore = await snapshotTree(fixture.paths.sourceRoot);
      const stateBefore = await snapshotTree(fixture.paths.stateRoot);
      const isolated = await runDoctorIsolated(fixture);
      assert.equal(isolated.timedOut, false);
      assert.equal(finding(isolated.result, "ACTIVE_INSTALL").severity, "blocker");
      assert.deepEqual(await snapshotTree(fixture.paths.sourceRoot), sourceBefore);
      assert.deepEqual(await snapshotTree(fixture.paths.stateRoot), stateBefore);
    });
  });
});

test("uses exact Codex version and schema compatibility", async () => {
  await withFixture({ codex: { version: "codex-cli 0.149.0" } }, async (fixture) => {
    let strictSpawns = 0;
    const result = await runUnchanged(fixture, {}, {
      beforeStrictSpawn() {
        strictSpawns += 1;
      },
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(finding(result, "CODEX_VERSION"), {
      severity: "blocker",
      code: "CODEX_VERSION",
      message: "Resolved Codex version does not match codex-cli 0.148.0.",
      remediation: "Install codex-cli 0.148.0 and retry.",
    });
    assert.equal(finding(result, "SCHEMA_COMPATIBILITY").severity, "blocker");
    assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    assert.equal(strictSpawns, 0);
  });
});

test("isolates and strictly validates the Codex version probe", async (t) => {
  await t.test("uses a fresh owner-only scratch home", async () => {
    await withFixture({ codex: { versionBehavior: "write-home" } }, async (fixture) => {
      let observedHome;
      const result = await runUnchanged(fixture, {}, {
        async beforeVersionSpawn(codexHome) {
          observedHome = codexHome;
          assert.equal((await lstat(codexHome)).mode & 0o777, 0o700);
        },
      });
      assert.equal(finding(result, "CODEX_VERSION").severity, "ready");
      assert.ok(observedHome.startsWith(`${fixture.scratchParent}/`));
      assert.equal(observedHome.startsWith(fixture.paths.stateRoot), false);
    });
  });

  await t.test("rejects an exact version emitted only on stderr", async () => {
    await withFixture({ codex: { versionBehavior: "stderr" } }, async (fixture) => {
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "CODEX_VERSION").severity, "blocker");
      assert.equal(finding(result, "SCHEMA_COMPATIBILITY").severity, "blocker");
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });

  await t.test("rejects combined output overflow", async () => {
    await withFixture({ codex: { versionBehavior: "overflow" } }, async (fixture) => {
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "CODEX_VERSION").severity, "blocker");
    });
  });

  await t.test("bounds a direct-exit child with inherited-pipe descendant", async () => {
    await withFixture({}, async (fixture) => {
      const markerPath = join(fixture.root, "late-version-marker");
      await writeCodexExecutable(fixture.paths.codexBin, {
        versionBehavior: "late-descendant",
        markerPath,
      });
      const result = await runUnchanged(fixture, { commandTimeoutMs: 40 });
      await assertRecordedProcessWasReaped(markerPath);
      assert.equal(finding(result, "CODEX_VERSION").severity, "blocker");
    });
  });

  await t.test("rejects a direct-exit child with redirected residual descendant", async () => {
    await withFixture({}, async (fixture) => {
      const markerPath = join(fixture.root, "redirected-version-pid");
      await writeCodexExecutable(fixture.paths.codexBin, {
        versionBehavior: "redirected-descendant",
        markerPath,
      });
      const result = await runUnchanged(fixture);
      await assertRecordedProcessWasReaped(markerPath);
      assert.equal(finding(result, "CODEX_VERSION").severity, "blocker");
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });
});

test("accepts only pinned owner-only file-backed authentication shapes", async (t) => {
  const valid = [
    { OPENAI_API_KEY: "fixture-secret" },
    { auth_mode: "apikey", OPENAI_API_KEY: "fixture-secret" },
    {
      auth_mode: "chatgpt",
      tokens: {
        id_token: "fixture-id-token",
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
      },
    },
    {
      tokens: {
        id_token: "fixture-id-token",
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        account_id: "fixture-account",
        upstream_extension: true,
      },
    },
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fixture-id-token",
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        account_id: null,
      },
      last_refresh: null,
      agent_identity: null,
      personal_access_token: null,
      bedrock_api_key: null,
    },
    {
      auth_mode: "apikey",
      OPENAI_API_KEY: "fixture-secret",
      last_refresh: "2026-08-21T00:00:00Z",
      agent_identity: {
        agent_runtime_id: "runtime",
        agent_private_key: "fixture-private",
        account_id: "account",
        chatgpt_user_id: "user",
        plan_type: "plus",
        chatgpt_account_is_fedramp: false,
        email: null,
        task_id: "task",
      },
      personal_access_token: "fixture-pat",
      bedrock_api_key: { api_key: "fixture-bedrock", region: "region", extension: true },
    },
  ];
  for (const value of valid) {
    await t.test(`valid ${value.auth_mode ?? "implicit API key"}`, async () => {
      await withFixture({ auth: value }, async (fixture) => {
        const result = await runUnchanged(fixture);
        assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "ready");
      });
    });
  }

  const invalid = [
    ["empty object", {}],
    ["unsupported mode", { auth_mode: "other", OPENAI_API_KEY: "fixture-secret" }],
    ["missing token", { auth_mode: "chatgpt", tokens: { id_token: "fixture-id-token", access_token: "fixture-access-token" } }],
    ["array", []],
    ["malformed nested data", { auth_mode: "chatgpt", tokens: "fixture-secret" }],
    ["unknown key", { OPENAI_API_KEY: "fixture-secret", extra: true }],
    ["invalid token account", { auth_mode: "chatgpt", tokens: { id_token: "fixture-id-token", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", account_id: 3 } }],
    ["invalid refresh timestamp", { OPENAI_API_KEY: "fixture-secret", last_refresh: "not-a-date" }],
    ["invalid agent identity", { OPENAI_API_KEY: "fixture-secret", agent_identity: { agent_runtime_id: "runtime" } }],
    ["invalid personal access token", { OPENAI_API_KEY: "fixture-secret", personal_access_token: 3 }],
    ["invalid bedrock key", { OPENAI_API_KEY: "fixture-secret", bedrock_api_key: { api_key: "fixture-bedrock" } }],
    ["PAT precedence without mode", { OPENAI_API_KEY: "fixture-secret", personal_access_token: "fixture-pat" }],
    ["Bedrock precedence without mode", { OPENAI_API_KEY: "fixture-secret", bedrock_api_key: { api_key: "fixture-bedrock", region: "region" } }],
    ["null mode", { auth_mode: null, OPENAI_API_KEY: "fixture-secret" }],
    ["API key plus tokens", { OPENAI_API_KEY: "fixture-secret", tokens: { id_token: "fixture-id-token", access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" } }],
  ];
  for (const [name, value] of invalid) {
    await t.test(name, async () => {
      await withFixture({ auth: value }, async (fixture) => {
        const result = await runUnchanged(fixture);
        assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
      });
    });
  }

  await t.test("missing configuration uses the exact managed-home remediation", async () => {
    await withFixture({}, async (fixture) => {
      await writeAuth(fixture.paths.codexHome, {});
      const result = await runUnchanged(fixture);
      assert.deepEqual(finding(result, "AUTH_CONFIGURATION"), {
        severity: "blocker",
        code: "AUTH_CONFIGURATION",
        message: "Codex authentication is not safely configured.",
        remediation: `CODEX_HOME=${JSON.stringify(fixture.paths.codexHome)} codex login`,
      });
    });
  });

  await t.test("symlink", async () => {
    await withFixture({}, async (fixture) => {
      const path = join(fixture.paths.codexHome, authFileName);
      const external = join(fixture.root, "external-auth-fixture");
      await writeFile(external, '{"OPENAI_API_KEY":"fixture-secret"}\n', { mode: 0o600 });
      await rm(path);
      await symlink(external, path);
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
    });
  });

  await t.test("oversized file", async () => {
    await withFixture({}, async (fixture) => {
      const path = join(fixture.paths.codexHome, authFileName);
      await writeFile(path, Buffer.alloc(65 * 1024, 0x20), { mode: 0o600 });
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
    });
  });

  await t.test("permissive mode", async () => {
    await withFixture({}, async (fixture) => {
      await chmod(join(fixture.paths.codexHome, authFileName), 0o644);
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
    });
  });

  await t.test("malformed JSON", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(
        join(fixture.paths.codexHome, authFileName),
        "not-json\n",
        { mode: 0o600 },
      );
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
    });
  });

  await t.test("FIFO fails closed without waiting for a writer", async () => {
    await withFixture({}, async (fixture) => {
      const authPath = join(fixture.paths.codexHome, authFileName);
      await rm(authPath);
      await execFile("/usr/bin/mkfifo", [authPath]);
      await chmod(authPath, 0o600);
      const sourceBefore = await snapshotTree(fixture.paths.sourceRoot);
      const stateBefore = await snapshotTree(fixture.paths.stateRoot);
      const isolated = await runDoctorIsolated(fixture);
      assert.equal(isolated.timedOut, false);
      assert.equal(
        finding(isolated.result, "AUTH_CONFIGURATION").severity,
        "blocker",
      );
      assert.deepEqual(await snapshotTree(fixture.paths.sourceRoot), sourceBefore);
      assert.deepEqual(await snapshotTree(fixture.paths.stateRoot), stateBefore);
    });
  });

  await t.test("caps a file that grows after descriptor validation", async () => {
    await withFixture({}, async (fixture) => {
      const authPath = join(fixture.paths.codexHome, authFileName);
      const original = await readFile(authPath);
      const sourceBefore = await snapshotTree(fixture.paths.sourceRoot);
      const stateBefore = await snapshotTree(fixture.paths.stateRoot);
      let readHookCalls = 0;
      let result;
      try {
        result = await requireDoctor().__runDoctorForTests(
          fixture.dependencies,
          {
            async beforeAuthenticationRead(openedPath) {
              assert.equal(openedPath, authPath);
              readHookCalls += 1;
              await writeFile(openedPath, Buffer.alloc(128 * 1024, 0x20));
              await chmod(openedPath, 0o600);
            },
          },
        );
      } finally {
        await writeFile(authPath, original);
        await chmod(authPath, 0o600);
      }
      assert.equal(readHookCalls, 1);
      assert.equal(finding(result, "AUTH_CONFIGURATION").severity, "blocker");
      assert.deepEqual(await snapshotTree(fixture.paths.sourceRoot), sourceBefore);
      assert.deepEqual(await snapshotTree(fixture.paths.stateRoot), stateBefore);
      assert.deepEqual(await readdir(fixture.scratchParent), []);
    });
  });
});

test("fails strict config on nonzero exit and timeout without leaking scratch", async (t) => {
  await t.test("nonzero", async () => {
    await withFixture({ codex: { strict: "failure" } }, async (fixture) => {
      const result = await runUnchanged(fixture);
      assert.deepEqual(finding(result, "STRICT_CONFIG"), {
        severity: "blocker",
        code: "STRICT_CONFIG",
        message: "Strict Codex configuration validation failed.",
        remediation: "Resolve the managed portable configuration before retrying.",
      });
    });
  });
  await t.test("timeout terminates and awaits the child", async () => {
    await withFixture({ codex: { strict: "timeout" } }, async (fixture) => {
      const result = await runUnchanged(fixture, { commandTimeoutMs: 40 });
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
      assert.equal(finding(result, "SCRATCH_CLEANUP").severity, "ready");
    });
  });
  await t.test("kills an inherited-pipe descendant before cleanup", async () => {
    await withFixture({}, async (fixture) => {
      const markerPath = join(fixture.root, "late-strict-marker");
      await writeCodexExecutable(fixture.paths.codexBin, {
        strict: "late-descendant",
        markerPath,
      });
      const result = await runUnchanged(fixture, { commandTimeoutMs: 40 });
      await assertRecordedProcessWasReaped(markerPath);
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });
  await t.test("rejects a redirected residual descendant after direct close", async () => {
    await withFixture({}, async (fixture) => {
      const markerPath = join(fixture.root, "redirected-strict-pid");
      await writeCodexExecutable(fixture.paths.codexBin, {
        strict: "redirected-descendant",
        markerPath,
      });
      const result = await runUnchanged(fixture);
      await assertRecordedProcessWasReaped(markerPath);
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });
});

test("cleans scratch when strict shadow materialization fails", async () => {
  await withFixture({}, async (fixture) => {
    const result = await runUnchanged(fixture, {}, {
      async beforeMaterialization() {
        throw new Error("fixture materialization failure");
      },
    });
    assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    assert.equal(finding(result, "SCRATCH_CLEANUP").severity, "ready");
  });
});

test("rejects hostile strict-shadow and active source ancestors", async (t) => {
  await t.test("target ancestor symlink", async () => {
    await withFixture({}, async (fixture) => {
      const result = await runUnchanged(fixture, {}, {
        async beforeMaterialization(shadowHome) {
          const redirect = join(shadowHome, "redirect");
          await mkdir(redirect, { mode: 0o700 });
          await symlink(redirect, join(shadowHome, "hooks"));
        },
      });
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
    });
  });

  await t.test("intermediate managed source symlink", async () => {
    await withFixture({}, async (fixture) => {
      const hooksPath = join(fixture.paths.codexHome, "hooks");
      await rename(hooksPath, join(fixture.paths.codexHome, "hooks-real"));
      await symlink("hooks-real", hooksPath);
      let materializationStarted = 0;
      const result = await runUnchanged(fixture, {}, {
        beforeMaterialization() {
          materializationStarted += 1;
        },
      });
      assert.equal(finding(result, "ACTIVE_INSTALL").severity, "ready");
      assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
      assert.equal(materializationStarted, 1);
    });
  });
});

test("strict shadow contains the complete active closure with sanitized environment", async () => {
  await withFixture({}, async (fixture) => {
    const active = JSON.parse(
      await readFile(join(fixture.paths.stateRoot, "active-install.json"), "utf8"),
    );
    const checks = [
      `test -z "$(/usr/bin/env | /usr/bin/grep -Ev '^(CODEX_HOME|PATH|PWD|SHLVL|_)=' || true)" || exit 40`,
      `test "$PATH" = ${JSON.stringify(dirname(process.execPath))} || exit 41`,
      `test "$(/usr/bin/find "$CODEX_HOME" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')" = ${JSON.stringify(String(active.files.length))} || exit 42`,
      ...active.files.flatMap((entry, index) => [
        `test "$(/usr/bin/stat -f '%Lp' "$CODEX_HOME/${entry.path}")" = ${JSON.stringify(entry.mode.slice(1))} || exit ${50 + index}`,
        `printf '%s  %s\\n' ${JSON.stringify(entry.sha256)} "$CODEX_HOME/${entry.path}" | /usr/bin/shasum -a 256 -c - >/dev/null || exit ${80 + index}`,
      ]),
      `test ! -e "$CODEX_HOME/${authFileName}" || exit 99`,
      "exit 0",
    ];
    await writeCodexExecutable(fixture.paths.codexBin, {
      strictBody: checks.join("\n"),
    });
    const result = await runUnchanged(fixture);
    assert.equal(finding(result, "STRICT_CONFIG").severity, "ready");
  });
});

test("rejects unsafe scratch parents without spawning Codex", async (t) => {
  for (const mode of [0o770, 0o707]) {
    await t.test(mode.toString(8), async () => {
      await withFixture({}, async (fixture) => {
        const markerPath = join(fixture.root, `spawn-${mode.toString(8)}`);
        await writeCodexExecutable(fixture.paths.codexBin, { markerPath });
        await chmod(fixture.scratchParent, mode);
        const result = await runUnchanged(fixture);
        assert.equal(finding(result, "SCRATCH_CLEANUP").severity, "blocker");
        assert.equal(finding(result, "CODEX_VERSION").severity, "blocker");
        assert.equal(finding(result, "SCHEMA_COMPATIBILITY").severity, "blocker");
        assert.equal(finding(result, "STRICT_CONFIG").severity, "blocker");
        await assert.rejects(lstat(markerPath), { code: "ENOENT" });
      });
    });
  }
});

test("retries outer cleanup after post-mkdtemp creation failure", async () => {
  await withFixture({}, async (fixture) => {
    let createdScratch;
    let initialCleanupAttempts = 0;
    const result = await runUnchanged(fixture, {}, {
      afterScratchMkdtemp(path) {
        createdScratch = path;
        throw new Error("fixture post-mkdtemp failure");
      },
      beforeScratchCreationCleanup() {
        initialCleanupAttempts += 1;
        throw new Error("fixture initial cleanup failure");
      },
    });
    assert.equal(initialCleanupAttempts, 1);
    assert.equal(finding(result, "SCRATCH_CLEANUP").severity, "blocker");
    assert.ok(createdScratch.startsWith(`${fixture.scratchParent}/`));
    await assert.rejects(lstat(createdScratch), { code: "ENOENT" });
  });
});

test("classifies process locks without acquiring, releasing, or deleting them", async (t) => {
  await t.test("absent", async () => {
    await withFixture({}, async (fixture) => {
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "PROCESS_LOCK").severity, "ready");
    });
  });
  await t.test("live", async () => {
    await withFixture({}, async (fixture) => {
      const handle = await lockModule.acquireProcessLock(fixture.paths.stateRoot, ["fixture"]);
      try {
        const result = await runUnchanged(fixture);
        assert.equal(finding(result, "PROCESS_LOCK").severity, "warning");
      } finally {
        await lockModule.releaseProcessLock(handle);
      }
    });
  });
  await t.test("stale", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(
        join(fixture.paths.stateRoot, "run.lock"),
        `${JSON.stringify({ pid: 99999999, processStartMarker: "never", hostname: hostname(), command: ["fixture"], acquiredAt: "2025-01-02T03:04:05.000Z" })}\n`,
        { mode: 0o600 },
      );
      const result = await runUnchanged(fixture);
      assert.deepEqual(finding(result, "PROCESS_LOCK"), {
        severity: "blocker",
        code: "PROCESS_LOCK",
        message: "A stale process lock is present.",
        remediation: "Confirm no managed process is running, then remove the stale lock.",
      });
    });
  });
  await t.test("unknown owner", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(
        join(fixture.paths.stateRoot, "run.lock"),
        `${JSON.stringify({ pid: 1, processStartMarker: "unknown", hostname: "remote.invalid", command: ["fixture"], acquiredAt: "2025-01-02T03:04:05.000Z" })}\n`,
        { mode: 0o600 },
      );
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "PROCESS_LOCK").severity, "blocker");
    });
  });
  await t.test("malformed", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(join(fixture.paths.stateRoot, "run.lock"), "not-json\n", { mode: 0o600 });
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "PROCESS_LOCK").severity, "blocker");
    });
  });
});

test("blocks invalid or interrupted installation journals without recovery", async (t) => {
  await t.test("invalid journal", async () => {
    await withFixture({}, async (fixture) => {
      await writeFile(join(fixture.paths.stateRoot, "install-journal.json"), "not-json\n", { mode: 0o600 });
      const result = await runUnchanged(fixture);
      assert.equal(finding(result, "INSTALL_JOURNAL").severity, "blocker");
    });
  });
  await t.test("interrupted journal", async () => {
    await withFixture({}, async (fixture) => {
      const active = JSON.parse(await readFile(join(fixture.paths.stateRoot, "active-install.json"), "utf8"));
      const journal = {
        version: 1,
        transactionId: "11111111-1111-4111-8111-111111111111",
        previousDigest: active.bundleDigest,
        candidateDigest: active.bundleDigest,
        previousActive: active,
        candidateActive: active,
        operations: [],
        createdDirectories: [],
        directoryWitnesses: [],
        stateRootCreated: false,
        preimagesRootCreated: false,
      };
      await writeFile(
        join(fixture.paths.stateRoot, "install-journal.json"),
        `${JSON.stringify(journal, null, 2)}\n`,
        { mode: 0o600 },
      );
      const result = await runUnchanged(fixture);
      assert.deepEqual(finding(result, "INSTALL_JOURNAL"), {
        severity: "blocker",
        code: "INSTALL_JOURNAL",
        message: "An interrupted installation journal is present.",
        remediation: "Complete explicit installation recovery before retrying.",
      });
    });
  });
});

test("turns injected cleanup failure into the stable scratch blocker", async () => {
  await withFixture({}, async (fixture) => {
    const result = await runUnchanged(fixture, {}, {
      async beforeScratchCleanup() {
        throw new Error("fixture cleanup-stage failure");
      },
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(finding(result, "SCRATCH_CLEANUP"), {
      severity: "blocker",
      code: "SCRATCH_CLEANUP",
      message: "Doctor scratch cleanup failed.",
      remediation: "Remove the doctor scratch directory before retrying.",
    });
  });
});
