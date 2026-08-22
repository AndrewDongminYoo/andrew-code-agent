// Black-box acceptance over the compiled CLI.
//
// Every scenario spawns dist/cli.js as a child process with an explicitly
// constructed environment. The child must never inherit process.env: the
// runtime resolves HOME and the ANDREW_AGENT_* roots from its own environment,
// so an inherited one would reach the operator's real Codex home and real
// Application Support directory.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRootUrl = new URL("../../", import.meta.url);
const productRoot = repositoryRootUrl.pathname;
const cliPath = join(productRoot, "dist", "cli.js");
const fixtureCodex = join(productRoot, "test", "fixtures", "fake-app-server.mjs");
const sourceFixture = join(productRoot, "test", "fixtures", "source-codex", "clean");
const acceptanceManifest = join(productRoot, "test", "fixtures", "manifests", "acceptance.toml");

const scopedKeys = ["HOME", "ANDREW_AGENT_CODEX_SOURCE", "ANDREW_AGENT_STATE_ROOT"];

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== "..";
}

// Refuses any environment whose runtime roots escape the fixture. Proven to
// refuse by the "guard refuses an inherited HOME" case below; without that
// proof a passing scenario cannot be distinguished from one that silently ran
// against the operator's real state.
export function acceptanceEnvironment(fixtureRoot, values) {
  for (const key of scopedKeys) {
    const value = values[key];
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`${key} must be set explicitly for the acceptance child`);
    if (!isInside(fixtureRoot, value))
      throw new Error(`${key} resolves outside the acceptance fixture: ${value}`);
  }
  return values;
}

async function createEnvironment() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-acceptance-")));
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const stateRoot = join(root, "state");
  const target = join(root, "repository");

  await mkdir(home, { mode: 0o700 });
  await cp(sourceFixture, sourceRoot, { recursive: true });
  await mkdir(join(sourceRoot, "agents"), { recursive: true });
  await writeFile(
    join(sourceRoot, "AGENTS.md"),
    "# Fixture Instructions\n\n## Core Rules\n\nKeep the base profile portable.\n\n## Consult the Oracle\n\nUse ${LLM_WIKI_ROOT} only for read-only precedent retrieval.\n\n## Closing Rules\n\nKeep working without the optional adapter.\n",
  );
  await writeFile(
    join(sourceRoot, "agents", "oracle.toml"),
    'name = "oracle"\nwiki_root = "${LLM_WIKI_ROOT}"\n',
  );
  await copyFile(acceptanceManifest, join(sourceRoot, "agent-bundle.toml"));
  await initializeRepository(sourceRoot);

  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "tracked.txt"), "before\n");
  await initializeRepository(target);

  return { root, home, sourceRoot, stateRoot, target };
}

async function initializeRepository(root) {
  await execFile("git", ["init", "--quiet", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFile("git", ["-C", root, "config", "user.name", "Test User"]);
  await execFile("git", ["-C", root, "add", "--all"]);
  await execFile("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
}

function environmentFor(fixture, overrides = {}) {
  return acceptanceEnvironment(fixture.root, {
    HOME: fixture.home,
    ANDREW_AGENT_CODEX_SOURCE: fixture.sourceRoot,
    ANDREW_AGENT_STATE_ROOT: fixture.stateRoot,
    ANDREW_AGENT_CODEX_BIN: fixtureCodex,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...overrides,
  });
}

// execFile rejects on a nonzero exit, but every scenario asserts an exact
// code, so normalize both outcomes into one shape.
async function runCli(environment, argv, options = {}) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [cliPath, ...argv], {
      env: environment,
      cwd: options.cwd ?? productRoot,
      timeout: options.timeoutMs ?? 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function findings(stdout) {
  const parsed = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^(blocker|warning|ready) ([A-Z_]+):/.exec(line);
    if (match !== null) parsed.set(match[2], match[1]);
  }
  return parsed;
}

test("the guard refuses an environment that escapes the fixture", async () => {
  const fixture = await createEnvironment();
  try {
    assert.throws(
      () => environmentFor(fixture, { HOME: process.env.HOME }),
      /HOME resolves outside the acceptance fixture/,
      "an inherited HOME must be refused before any child is spawned",
    );
    assert.throws(
      () => environmentFor(fixture, { ANDREW_AGENT_CODEX_SOURCE: "/Users" }),
      /ANDREW_AGENT_CODEX_SOURCE resolves outside the acceptance fixture/,
    );
    assert.doesNotThrow(() => environmentFor(fixture));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor reports a fresh machine as not yet installed", async () => {
  const fixture = await createEnvironment();
  try {
    const result = await runCli(environmentFor(fixture), ["doctor"]);
    const parsed = findings(result.stdout);
    assert.equal(parsed.get("CODEX_VERSION"), "ready", result.stdout);
    assert.equal(parsed.get("SCHEMA_COMPATIBILITY"), "ready", result.stdout);
    assert.equal(parsed.get("SOURCE_DIRTY"), "ready", result.stdout);
    assert.equal(parsed.get("MANIFEST_VALID"), "ready", result.stdout);
    assert.equal(parsed.get("ACTIVE_INSTALL"), "blocker", result.stdout);
    assert.equal(result.code, 1, result.stderr);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor blocks when the manifest is missing", async () => {
  const fixture = await createEnvironment();
  try {
    await rm(join(fixture.sourceRoot, "agent-bundle.toml"));
    await execFile("git", ["-C", fixture.sourceRoot, "add", "--all"]);
    await execFile("git", ["-C", fixture.sourceRoot, "commit", "--quiet", "-m", "drop manifest"]);
    const result = await runCli(environmentFor(fixture), ["doctor"]);
    assert.equal(findings(result.stdout).get("MANIFEST_VALID"), "blocker", result.stdout);
    assert.equal(result.code, 1, result.stderr);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an unknown command exits with the usage code", async () => {
  const fixture = await createEnvironment();
  try {
    const result = await runCli(environmentFor(fixture), ["nonsense"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Invalid command usage/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
