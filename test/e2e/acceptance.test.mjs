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
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { probeStrictConfig } from "../helpers/strict-config.mjs";
import {
  acceptanceEnvironment,
  createSmokeFixture as createEnvironment,
  environmentFor,
  runCli,
  writeCodexWrapper,
} from "../helpers/live-smoke.mjs";

const execFile = promisify(execFileCallback);
// fileURLToPath, not pathname: a checkout under a path with spaces or
// non-ASCII bytes keeps its percent encoding in pathname and resolves to
// nothing on disk.
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(productRoot, "dist", "cli.js");

const { REQUIRED_CODEX_VERSION } = await import(new URL("../../dist/constants.js", import.meta.url).href);

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
  // A missing expect must say so, not surface as a generic nonzero exit that
  // reads like a product failure.
  await execFile("expect", ["-v"]).catch(() => {
    assert.fail("expect is required for the terminal approval scenario and was not found");
  });
  try {
    const { stdout } = await execFile("expect", ["-f", script], {
      env: environmentFor(fixture),
      timeout: 90_000,
    });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== "number")
      assert.fail(`expect could not run the approval scenario: ${error.code ?? error.message}`);
    return { code: error.code, stdout: error.stdout ?? "" };
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

test("an unaccountable install journal blocks the next run instead of proceeding", async () => {
  const fixture = await createEnvironment();
  try {
    const environment = environmentFor(fixture);
    const installed = await runCli(environment, ["run", fixture.target, "install first"]);
    assert.equal(installed.code, 0, installed.stderr);
    const managedBefore = await readdir(join(fixture.stateRoot, "codex-home"));

    // A journal left behind means a previous install did not finish. A
    // well-formed one is rolled back by the next run, which then proceeds;
    // test/integration/install.test.mjs owns that path. This one is
    // deliberately unaccountable, which is the case that must fail closed.
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

// The fixture synthesizes authentication into the managed home, which is the
// one step an operator has to perform themselves. Without this case the
// acceptance layer never exercises a machine that has not been logged in —
// the gap that let the README document a first-run sequence that could not
// work.
test("an unauthenticated managed home blocks doctor and refuses to run", async () => {
  const fixture = await createEnvironment();
  try {
    const environment = environmentFor(fixture);
    await rm(join(fixture.stateRoot, "codex-home", ["auth", ".json"].join("")));

    const doctor = await runCli(environment, ["doctor"]);
    assert.equal(findings(doctor.stdout).get("AUTH_CONFIGURATION"), "blocker", doctor.stdout);
    assert.equal(doctor.code, 1);

    const blocked = await runCli(environment, ["run", fixture.target, "must not reach the app server"]);
    assert.equal(blocked.code, 3, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(blocked.stderr, /Candidate readiness failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// The live smoke exercises the real Codex binary against the portable
// configuration this product installs. That is the one property the fixture
// app server cannot check, because a fixture accepts whatever it is given.
// A real turn additionally needs real credentials, which this smoke
// deliberately does not supply, so it stops at configuration acceptance.
const liveSmokeRequested = process.env.ANDREW_AGENT_REAL_SMOKE === "1";
const cacheBoundarySmokeRequested =
  process.env.ANDREW_AGENT_CACHE_BOUNDARY_SMOKE === "1";

function capturedStream() {
  const stream = new PassThrough();
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { text += chunk; });
  return { stream, text: () => text };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function createSyntheticBoundaryRoots() {
  const createdRoot = await mkdtemp("/Users/Shared/andrew-agent-cache-boundary-");
  let temporaryRoot;
  try {
    const root = await realpath(createdRoot);
    await chmod(root, 0o700);
    temporaryRoot = await mkdtemp("/tmp/andrew-agent-cache-boundary-");
    await chmod(temporaryRoot, 0o700);
    const roots = {
      root,
      temporaryRoot,
      cache: join(root, "cache"),
      home: join(root, "home"),
      sibling: join(root, "sibling"),
    };
    await Promise.all(
      [roots.cache, roots.home, roots.sibling].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    return roots;
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true });
    if (temporaryRoot !== undefined)
      await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeCacheBoundaryHelper(fixture, roots) {
  const helper = join(fixture.target, "managed-cache-boundary.mjs");
  const receipt = join(fixture.target, ".managed-cache-boundary-receipt.json");
  const paths = {
    repository: join(fixture.target, ".managed-cache-boundary-repository"),
    temporary: join(roots.temporaryRoot, "managed-cache-boundary"),
    cache: join(roots.cache, "managed-cache-boundary"),
    home: join(roots.home, "managed-cache-boundary"),
    sibling: join(roots.sibling, "managed-cache-boundary"),
  };
  await writeFile(
    helper,
    `import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\n\nconst paths = ${JSON.stringify(paths)};\nconst receipt = ${JSON.stringify(receipt)};\nconst result = {};\nfor (const [name, path] of Object.entries(paths)) {\n  try {\n    mkdirSync(dirname(path), { recursive: true });\n    writeFileSync(path, name + " canary\\n");\n    result[name] = "written";\n  } catch {\n    result[name] = "blocked";\n  }\n}\nwriteFileSync(receipt, JSON.stringify(result));\nprocess.stdout.write(JSON.stringify(result) + "\\n");\n`,
  );
  await execFile("git", ["-C", fixture.target, "add", helper]);
  await execFile("git", ["-C", fixture.target, "commit", "--quiet", "-m", "add measurement helper"]);
  return { receipt, paths };
}

async function runManagedCacheBoundaryMeasurement(
  fixture,
  codexBin,
  additionalWritableRoot,
) {
  const { defaultCommandDependencies, runCommand } = await import(
    new URL("../../dist/commands/run.js", import.meta.url).href
  );
  const environment = environmentFor(fixture, {
    ANDREW_AGENT_CODEX_BIN: codexBin,
  });
  const paths = await defaultCommandDependencies.resolveRuntimePaths({
    env: environment,
  });
  const stdout = capturedStream();
  const stderr = capturedStream();
  const stdin = new PassThrough();
  stdin.end();
  let record;
  let sandboxPolicy;
  const dependencies = {
    ...defaultCommandDependencies,
    resolveRuntimePaths: async () => paths,
    scratchParent: fixture.root,
    async startNewThread(request, coordinator) {
      const client = coordinator.client;
      const measurementClient = {
        threadStart: (params) => client.threadStart(params),
        threadResume: (params) => client.threadResume(params),
        threadRead: (params) => client.threadRead(params),
        turnStart: (params) => {
          const candidate =
            additionalWritableRoot === undefined
              ? params
              : {
                  ...params,
                  sandboxPolicy: {
                    ...params.sandboxPolicy,
                    writableRoots: [
                      ...params.sandboxPolicy.writableRoots,
                      additionalWritableRoot,
                    ],
                  },
                };
          sandboxPolicy = candidate.sandboxPolicy;
          return client.turnStart(candidate);
        },
        turnInterrupt: (params) => client.turnInterrupt(params),
        respond: (id, result) => client.respond(id, result),
        onNotification: (listener) => client.onNotification(listener),
        onRequest: (listener) => client.onRequest(listener),
        onFailure: (listener) => client.onFailure(listener),
        close: () => client.close(),
      };
      record = await defaultCommandDependencies.startNewThread(request, {
        ...coordinator,
        client: measurementClient,
      });
      return record;
    },
  };
  const code = await runCommand(
    fixture.target,
    "Run exactly `node ./managed-cache-boundary.mjs` once. Do not run any other command or modify any other file. Then reply only MEASUREMENT_DONE.",
    { stdin, stdout: stdout.stream, stderr: stderr.stream },
    dependencies,
  );
  const persistedRecord = record === undefined
    ? undefined
    : await defaultCommandDependencies.readThreadRecord(
        paths.stateRoot,
        record.threadId,
        fixture.target,
      );
  return {
    code,
    persistedRecord,
    sandboxPolicy,
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}

test(
  "live smoke: the real Codex accepts the installed portable configuration",
  {
    skip: liveSmokeRequested
      ? false
      : "ANDREW_AGENT_REAL_SMOKE is unset; the live smoke did not run",
  },
  async () => {
    const smokeCodexBin = process.env.ANDREW_AGENT_SMOKE_CODEX_BIN;
    assert.ok(
      smokeCodexBin,
      "ANDREW_AGENT_SMOKE_CODEX_BIN must name the codex binary to smoke against",
    );
    const version = await execFile(smokeCodexBin, ["--version"]);
    assert.equal(
      version.stdout.trim(),
      `codex-cli ${REQUIRED_CODEX_VERSION}`,
      "the live smoke refuses any Codex that is not the pinned version",
    );

    const fixture = await createEnvironment();
    try {
      // The managed home must be the fixture's, never the operator's.
      const productionStateRoot = join(
        process.env.HOME ?? "/nonexistent",
        "Library", "Application Support", "andrew-code-agent",
      );
      assert.notEqual(fixture.stateRoot, productionStateRoot);

      const installed = await runCli(environmentFor(fixture), [
        "run", fixture.target, "install a candidate to smoke",
      ]);
      assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);

      const probe = await probeStrictConfig(
        await realpath(smokeCodexBin),
        join(fixture.stateRoot, "codex-home"),
      );
      assert.equal(
        probe.code, 0,
        `the real Codex rejected the installed configuration:\n${probe.stderr}`,
      );

      // With dedicated test credentials the smoke goes one step further and
      // drives a real turn. The file is copied, never read: nothing here may
      // log, hash, or print authentication material.
      const smokeAuth = process.env.ANDREW_AGENT_SMOKE_AUTH;
      if (smokeAuth === undefined) {
        console.log(
          "ANDREW_AGENT_SMOKE_AUTH is unset; the real-turn gate did not run",
        );
        return;
      }
      const managedAuth = join(
        fixture.stateRoot, "codex-home", ["auth", ".json"].join(""),
      );
      await copyFile(smokeAuth, managedAuth);
      await chmod(managedAuth, 0o600);

      const turn = await runCli(
        environmentFor(fixture, { ANDREW_AGENT_CODEX_BIN: await realpath(smokeCodexBin) }),
        ["run", fixture.target, "Reply with the single word ACKNOWLEDGED and change nothing."],
        { timeoutMs: 300_000 },
      );

      // A real turn completes end to end: a thread and turn are created, the
      // model answers, the repository is untouched, and the product reports
      // it as completed. That last part only holds because the reducer
      // accepts the summary item view the real server sends.
      assert.match(turn.stdout, /Thread ID: [0-9a-f-]{36}/, turn.stderr);
      assert.match(turn.stdout, /agentMessage completed: ACKNOWLEDGED/, turn.stdout);
      assert.match(turn.stdout, /Final Git status: *$/m, turn.stdout);
      assert.match(turn.stdout, /Terminal status: completed/, turn.stdout);
      assert.equal(turn.code, 0, turn.stderr);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

// The gap this closes: every deterministic layer installs a bundle and never
// lets a real Codex write back into the managed home between two runs, so an
// install that served exactly one run passed every gate.
test(
  "live smoke: a second real run survives the config rewrite the first one caused",
  {
    skip:
      liveSmokeRequested && process.env.ANDREW_AGENT_SMOKE_AUTH !== undefined
        ? false
        : "ANDREW_AGENT_REAL_SMOKE or ANDREW_AGENT_SMOKE_AUTH is unset; the two-run gate did not run",
  },
  async () => {
    const smokeCodexBin = await realpath(
      process.env.ANDREW_AGENT_SMOKE_CODEX_BIN ?? "/nonexistent",
    );
    const version = await execFile(smokeCodexBin, ["--version"]);
    assert.equal(version.stdout.trim(), `codex-cli ${REQUIRED_CODEX_VERSION}`);

    const fixture = await createEnvironment();
    try {
      const managedAuth = join(
        fixture.stateRoot,
        "codex-home",
        ["auth", ".json"].join(""),
      );
      await mkdir(join(fixture.stateRoot, "codex-home"), {
        recursive: true,
        mode: 0o700,
      });
      await copyFile(process.env.ANDREW_AGENT_SMOKE_AUTH, managedAuth);
      await chmod(managedAuth, 0o600);

      const environment = environmentFor(fixture, {
        ANDREW_AGENT_CODEX_BIN: smokeCodexBin,
      });
      const prompt = "Reply with the single word ACKNOWLEDGED and change nothing.";
      const first = await runCli(environment, ["run", fixture.target, prompt], {
        timeoutMs: 300_000,
      });
      assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);

      // The rewrite must actually have happened, or the second run proves
      // nothing: a Codex that stopped writing project trust would make this
      // test pass without exercising the reset at all.
      const active = JSON.parse(
        await readFile(join(fixture.stateRoot, "active-install.json"), "utf8"),
      );
      const installedConfig = join(
        fixture.stateRoot,
        "codex-home",
        "config.toml",
      );
      const bundledConfig = join(
        fixture.stateRoot,
        "bundles",
        active.bundleDigest,
        "config.toml",
      );
      assert.notEqual(
        await readFile(installedConfig, "utf8"),
        await readFile(bundledConfig, "utf8"),
        "the real Codex did not rewrite the managed config, so this gate is vacuous",
      );

      // Doctor is read-only, so this is the rewrite seen exactly as an
      // operator sees it between runs. It reported ACTIVE_INSTALL as a blocker
      // and exited 1 before the reset-before-run class existed.
      const doctor = await runCli(environment, ["doctor"]);
      assert.equal(doctor.code, 0, `${doctor.stdout}\n${doctor.stderr}`);

      const second = await runCli(environment, ["run", fixture.target, prompt], {
        timeoutMs: 300_000,
      });
      assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
      assert.match(second.stdout, /Terminal status: completed/, second.stdout);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "live smoke: synthetic cache roots distinguish the current and narrow policies",
  {
    skip:
      cacheBoundarySmokeRequested &&
      process.env.ANDREW_AGENT_SMOKE_AUTH !== undefined
        ? false
        : "ANDREW_AGENT_CACHE_BOUNDARY_SMOKE or ANDREW_AGENT_SMOKE_AUTH is unset; the cache-boundary smoke did not run",
    timeout: 600_000,
  },
  async () => {
    const smokeCodexBin = await realpath(
      process.env.ANDREW_AGENT_SMOKE_CODEX_BIN ?? "/nonexistent",
    );
    const version = await execFile(smokeCodexBin, ["--version"]);
    assert.equal(version.stdout.trim(), `codex-cli ${REQUIRED_CODEX_VERSION}`);

    for (const mode of ["current", "narrow-cache"]) {
      const fixture = await createEnvironment();
      let roots;
      try {
        roots = await createSyntheticBoundaryRoots();
        const managedAuth = join(
          fixture.stateRoot,
          "codex-home",
          ["auth", ".json"].join(""),
        );
        await copyFile(process.env.ANDREW_AGENT_SMOKE_AUTH, managedAuth);
        await chmod(managedAuth, 0o600);
        const helper = await writeCacheBoundaryHelper(fixture, roots);
        const measurement = await runManagedCacheBoundaryMeasurement(
          fixture,
          smokeCodexBin,
          mode === "narrow-cache" ? roots.cache : undefined,
        );
        const expected = {
          repository: "written",
          temporary: "written",
          cache: mode === "narrow-cache" ? "written" : "blocked",
          home: "blocked",
          sibling: "blocked",
        };

        assert.equal(measurement.code, 0, "the managed run did not complete");
        assert.ok(
          measurement.persistedRecord,
          "the real managed turn did not persist a readable record",
        );
        assert.equal(measurement.persistedRecord.terminalStatus, "completed");
        assert.deepEqual(
          JSON.parse(await readFile(helper.receipt, "utf8")),
          expected,
        );
        assert.equal(await pathExists(helper.paths.repository), true);
        assert.equal(await pathExists(helper.paths.temporary), true);
        assert.equal(await pathExists(helper.paths.cache), mode === "narrow-cache");
        assert.equal(await pathExists(helper.paths.home), false);
        assert.equal(await pathExists(helper.paths.sibling), false);

        assert.ok(
          measurement.sandboxPolicy,
          "the test wrapper did not observe a sandbox policy",
        );
        const expectedWritableRootCount = mode === "narrow-cache" ? 2 : 1;
        const hasExpectedWritableRoots =
          measurement.sandboxPolicy.writableRoots.length === expectedWritableRootCount &&
          measurement.sandboxPolicy.writableRoots[0] === fixture.target &&
          (mode !== "narrow-cache" ||
            measurement.sandboxPolicy.writableRoots[1] === roots.cache);
        assert.equal(
          hasExpectedWritableRoots,
          true,
          "the turn did not use the expected writable-root roles",
        );
        assert.equal(measurement.sandboxPolicy.networkAccess, false);
        assert.equal(measurement.sandboxPolicy.excludeTmpdirEnvVar, false);
        assert.equal(measurement.sandboxPolicy.excludeSlashTmp, false);
        assert.equal(
          JSON.stringify(measurement.persistedRecord).includes(roots.root),
          false,
        );
        assert.equal(
          JSON.stringify(measurement.persistedRecord).includes(roots.temporaryRoot),
          false,
        );
        assert.equal(measurement.stdout.includes(roots.root), false);
        assert.equal(measurement.stdout.includes(roots.temporaryRoot), false);
        assert.equal(measurement.stderr.includes(roots.root), false);
        assert.equal(measurement.stderr.includes(roots.temporaryRoot), false);
      } finally {
        try {
          if (roots !== undefined)
            await Promise.all([
              rm(roots.root, { recursive: true, force: true }),
              rm(roots.temporaryRoot, { recursive: true, force: true }),
            ]);
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    }
  },
);
