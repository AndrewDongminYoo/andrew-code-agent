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
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  // The manifest declares this hook as 0755; the committed fixture copy is
  // 0644, so the acceptance source tree must set the mode it promises.
  await writeFile(
    join(sourceRoot, "hooks", "safety.sh"),
    '#!/bin/sh\nprintf "%s\\n" "${HOME}/.codex"\n',
  );
  await chmod(join(sourceRoot, "hooks", "safety.sh"), 0o755);
  await copyFile(acceptanceManifest, join(sourceRoot, "agent-bundle.toml"));
  await initializeRepository(sourceRoot);

  // Doctor requires owner-only authentication material inside the managed
  // home. Synthesize a non-secret fixture; real credentials are never read.
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(join(stateRoot, "codex-home"), { mode: 0o700 });
  await writeFile(
    join(stateRoot, "codex-home", ["auth", ".json"].join("")),
    `${JSON.stringify({ OPENAI_API_KEY: "fixture-only-not-a-credential" })}\n`,
    { mode: 0o600 },
  );

  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "tracked.txt"), "before\n");
  await initializeRepository(target);

  const binRoot = join(root, "bin");
  await mkdir(binRoot, { mode: 0o700 });
  const fixture = { root, home, sourceRoot, stateRoot, target, codexBin: join(binRoot, "codex") };
  await writeCodexWrapper(fixture);
  return fixture;
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
    ANDREW_AGENT_CODEX_BIN: fixture.codexBin,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...overrides,
  });
}

// startAppServer spawns the codex binary with only CODEX_HOME and PATH, so
// scenario settings cannot reach the fixture through the CLI's environment.
// A per-scenario wrapper carries them instead.
async function writeCodexWrapper(fixture, settings = {}) {
  const assignments = Object.entries({
    ANDREW_AGENT_FAKE_SCRIPT: join(productRoot, "test", "fixtures", "protocol", "turn-success.jsonl"),
    ...settings,
  })
    .map(([key, value]) => `${key}=${JSON.stringify(value)}\nexport ${key}`)
    .join("\n");
  await writeFile(
    fixture.codexBin,
    `#!/bin/sh\n${assignments}\nexec ${JSON.stringify(fixtureCodex)} "$@"\n`,
    { mode: 0o755 },
  );
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

async function gitStatus(root) {
  const { stdout } = await execFile("git", [
    "-C", root, "status", "--porcelain=v2", "--untracked-files=all",
  ]);
  return stdout;
}

test("run installs a candidate, performs a contained edit, and reports the record", async () => {
  const fixture = await createEnvironment();
  try {
    const editTarget = join(fixture.target, "tracked.txt");
    await writeCodexWrapper(fixture, { ANDREW_AGENT_FAKE_EDIT_PATH: editTarget });

    const result = await runCli(environmentFor(fixture), [
      "run", fixture.target, "make one contained edit",
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Thread ID: thread-1/);
    assert.match(result.stdout, /Terminal status: completed/);
    assert.match(result.stdout, /Starting HEAD: [0-9a-f]{40}/);

    assert.equal(
      await readFile(editTarget, "utf8"),
      "before\nfixture edit\n",
      "the scripted turn must leave exactly its own edit",
    );
    assert.equal(
      await gitStatus(fixture.sourceRoot), "",
      "the bundle source tree must be left untouched",
    );
    assert.match(
      result.stdout, /Final Git status: 1 \.M/,
      "the final record must report the modified target file",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor reports every finding ready once a candidate is installed", async () => {
  const fixture = await createEnvironment();
  try {
    const environment = environmentFor(fixture);
    await runCli(environment, ["run", fixture.target, "install a candidate"]);
    const result = await runCli(environment, ["doctor"]);
    const parsed = findings(result.stdout);
    const blockers = [...parsed].filter(([, severity]) => severity === "blocker");
    assert.deepEqual(blockers, [], result.stdout);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// One scripted approval request followed by the completion notification.
async function writeApprovalScript(fixture) {
  const requests = await readFile(
    join(productRoot, "test", "fixtures", "protocol", "approval-requests.jsonl"), "utf8",
  );
  const turn = await readFile(
    join(productRoot, "test", "fixtures", "protocol", "turn-success.jsonl"), "utf8",
  );
  const scriptPath = join(fixture.root, "approval.jsonl");
  const first = requests.split("\n").find((line) => line.trim().length > 0);
  const completion = turn.trimEnd().split("\n").at(-1);
  await writeFile(scriptPath, `${first}\n${completion}\n`);
  return scriptPath;
}

async function decisions(logPath) {
  const contents = await readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

test("a gated action is declined fail-closed when stdin is not a terminal", async () => {
  const fixture = await createEnvironment();
  try {
    const scriptPath = await writeApprovalScript(fixture);
    const decisionLog = join(fixture.root, "decisions.jsonl");
    await writeCodexWrapper(fixture, {
      ANDREW_AGENT_FAKE_SCRIPT: scriptPath,
      ANDREW_AGENT_FAKE_DECISION_LOG: decisionLog,
    });

    const result = await runCli(environmentFor(fixture), [
      "run", fixture.target, "request a gated action",
    ]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

    const answered = await decisions(decisionLog);
    assert.equal(answered.length, 1, "the gated action must be answered exactly once");
    assert.equal(
      answered[0].result.decision, "decline",
      "a non-terminal stdin must never approve a gated action",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// answerApproval refuses to prompt unless stdin is a terminal, so the approve
// path can only be exercised over a pty. expect ships with macOS, which this
// product already requires.
async function runCliOnPty(fixture, argv, selection) {
  const script = join(fixture.root, "approve.exp");
  await writeFile(
    script,
    [
      "set timeout 60",
      `spawn ${process.execPath} ${cliPath} ${argv.map((value) => `{${value}}`).join(" ")}`,
      "expect {",
      `  "Selection:" { send "${selection}\\r" }`,
      '  timeout { puts "PROMPT_TIMEOUT"; exit 90 }',
      "}",
      "expect eof",
      "catch wait result",
      "exit [lindex $result 3]",
      "",
    ].join("\n"),
  );
  try {
    const { stdout } = await execFile("expect", ["-f", script], {
      env: environmentFor(fixture),
      timeout: 90_000,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "" };
  }
}

test("a gated action is approved when the operator answers on a terminal", async () => {
  const fixture = await createEnvironment();
  try {
    const scriptPath = await writeApprovalScript(fixture);
    const decisionLog = join(fixture.root, "decisions.jsonl");
    await writeCodexWrapper(fixture, {
      ANDREW_AGENT_FAKE_SCRIPT: scriptPath,
      ANDREW_AGENT_FAKE_DECISION_LOG: decisionLog,
    });

    const result = await runCliOnPty(
      fixture, ["run", fixture.target, "request a gated action"], "1",
    );
    assert.notEqual(result.code, 90, "the approval prompt must reach the terminal");
    assert.equal(result.code, 0, result.stdout);

    const answered = await decisions(decisionLog);
    assert.equal(answered.length, 1);
    assert.equal(
      answered[0].result.decision, "accept",
      "selecting the accept choice must send an accept decision",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a later process reads and resumes the thread the first process wrote", async () => {
  const fixture = await createEnvironment();
  try {
    const environment = environmentFor(fixture);
    const first = await runCli(environment, ["run", fixture.target, "start a thread"]);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);

    const byId = await runCli(environment, ["status", "thread-1"]);
    assert.equal(byId.code, 0, byId.stderr);
    assert.match(byId.stdout, /Persisted thread record:/);
    assert.match(byId.stdout, /Thread ID: thread-1/);
    assert.match(byId.stdout, /Live App Server status: idle/);

    // With no argument, status resolves the latest thread for the repository
    // the process is standing in.
    const byCwd = await runCli(environment, ["status"], { cwd: fixture.target });
    assert.equal(byCwd.code, 0, byCwd.stderr);
    assert.match(byCwd.stdout, /Thread ID: thread-1/);
    assert.match(byCwd.stdout, new RegExp(`Repository: ${fixture.target}`));

    // resume without a prompt reports the stored record and starts no turn.
    const record = await runCli(environment, ["resume", "thread-1"]);
    assert.equal(record.code, 0, record.stderr);
    assert.match(record.stdout, /Terminal status: completed/);

    const resumed = await runCli(environment, ["resume", "thread-1", "continue the work"]);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, /Terminal status: completed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a run releases its lock and leaves no residue in the state root", async () => {
  const fixture = await createEnvironment();
  try {
    const pidLog = join(fixture.root, "children.txt");
    await writeCodexWrapper(fixture, { ANDREW_AGENT_FAKE_PID_LOG: pidLog });
    const result = await runCli(environmentFor(fixture), [
      "run", fixture.target, "leave nothing behind",
    ]);
    assert.equal(result.code, 0, result.stderr);

    const entries = await readdir(fixture.stateRoot);
    assert.equal(entries.includes("run.lock"), false, entries.join(", "));
    assert.equal(
      entries.includes("install-journal.json"), false,
      "a completed install must not leave its journal behind",
    );
    assert.equal(
      entries.includes("install-preimages"), false,
      "a completed install must not leave its preimages behind",
    );
    assert.ok(entries.includes("active-install.json"), entries.join(", "));

    const spawned = (await readFile(pidLog, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(Number);
    assert.ok(spawned.length > 0, "the run must have spawned an app server session");
    for (const pid of spawned) {
      assert.throws(
        () => process.kill(pid, 0),
        /ESRCH/,
        `app server child ${pid} survived the run`,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an interrupted install blocks the next run instead of proceeding", async () => {
  const fixture = await createEnvironment();
  try {
    const environment = environmentFor(fixture);
    const installed = await runCli(environment, ["run", fixture.target, "install first"]);
    assert.equal(installed.code, 0, installed.stderr);
    const managedBefore = await readdir(join(fixture.stateRoot, "codex-home"));

    // A journal left behind means a previous install did not finish. v0.1
    // recovers a well-formed one and refuses anything it cannot account for;
    // test/integration/install.test.mjs owns the successful rollback path.
    await writeFile(
      join(fixture.stateRoot, "install-journal.json"),
      `${JSON.stringify({ version: 1, operations: [] })}\n`,
    );

    // The leftover journal invalidates the active installation rather than
    // surfacing under INSTALL_JOURNAL, which is what an operator will read.
    const doctor = await runCli(environment, ["doctor"]);
    assert.equal(findings(doctor.stdout).get("ACTIVE_INSTALL"), "blocker", doctor.stdout);
    assert.equal(doctor.code, 1);

    const blocked = await runCli(environment, ["run", fixture.target, "must not proceed"]);
    assert.equal(blocked.code, 3, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(blocked.stderr, /Runtime preparation failed/);

    assert.deepEqual(
      await readdir(join(fixture.stateRoot, "codex-home")), managedBefore,
      "a refused run must leave the managed home exactly as it found it",
    );
    assert.equal(await gitStatus(fixture.sourceRoot), "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
