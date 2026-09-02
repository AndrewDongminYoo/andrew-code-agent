import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const cliModule = await import("../../dist/cli.js").catch(() => null);
const runModule = await import("../../dist/commands/run.js").catch(() => null);
const resumeModule = await import("../../dist/commands/resume.js").catch(() => null);
const renderModule = await import("../../dist/bundle/render.js").catch(() => null);
const statusModule = await import("../../dist/commands/status.js").catch(() => null);
const rendererModule = await import("../../dist/app-server/renderer.js").catch(() => null);
const gitModule = await import("../../dist/runtime/git.js");
const threadStoreModule = await import("../../dist/runtime/thread-store.js");

function modules() {
  assert.notEqual(cliModule, null, "dist/cli.js must exist");
  assert.notEqual(runModule, null, "dist/commands/run.js must exist");
  assert.notEqual(resumeModule, null, "dist/commands/resume.js must exist");
  assert.notEqual(statusModule, null, "dist/commands/status.js must exist");
  return { cliModule, runModule, resumeModule, statusModule };
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    output() { return { stdout, stderr }; },
  };
}

async function createRepository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-cli-repo-")));
  await execFile("git", ["init", "--quiet", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFile("git", ["-C", root, "config", "user.name", "Test User"]);
  await writeFile(join(root, "tracked.txt"), "before\n");
  await execFile("git", ["-C", root, "add", "tracked.txt"]);
  await execFile("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  return root;
}

async function createRepositoryWithGitlink() {
  const sourceRoot = await createRepository();
  const repositoryRoot = await createRepository();
  const sourceHead = (await execFile("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout.trim();
  await execFile("git", [
    "-C",
    repositoryRoot,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${sourceHead},linked-source`,
  ]);
  await execFile("git", ["-C", repositoryRoot, "commit", "--quiet", "-m", "gitlink fixture"]);
  return { repositoryRoot, sourceRoot };
}

function terminalRecord(repositoryRoot, terminalStatus = "completed", grant = {}) {
  // readThreadRecord always yields the grant and the measurement, migrating an
  // earlier record to the empty grant and no measurement, so a fake that
  // omitted them would not be a record the product can produce.
  return { threadId: "thread-1", repositoryRoot, startingHead: "a".repeat(40), terminalHead: "b".repeat(40), bundleDigest: "c".repeat(64), productVersion: "0.1.0", codexVersion: "0.148.0", turnId: "turn-1", terminalStatus, finalGitStatus: "1 .M N... tracked.txt", requestedCapabilities: grant.requestedCapabilities ?? [], oracleRootDigest: grant.oracleRootDigest ?? null, tokenUsage: grant.tokenUsage ?? null };
}

function operationHarness(repositoryRoot, overrides = {}) {
  const order = [];
  const client = { async close() { order.push("client-close"); } };
  const paths = { sourceRoot: "/fixture/source", stateRoot: overrides.stateRoot ?? "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };
  const record = overrides.record ?? terminalRecord(repositoryRoot);
  const dependencies = {
    async resolveRuntimePaths() { order.push("paths"); return paths; },
    async readGitSnapshot(value) { order.push("snapshot"); return gitModule.readGitSnapshot(value); },
    assertCleanGitSnapshot(value) { order.push("clean"); return gitModule.assertCleanGitSnapshot(value); },
    async initializeRuntimeState() { order.push("initialize"); },
    async acquireProcessLock() { order.push("lock"); return { fixture: true }; },
    async recoverInterruptedInstall() { order.push("recover"); },
    async buildBundle() { order.push("build"); return { artifactRoot: "/fixture/artifact", metadata: { bundleDigest: "c".repeat(64) } }; },
    async installBundle() { order.push("install"); },
    async runDoctor() { order.push("readiness"); return { exitCode: overrides.doctorExit ?? 0, findings: overrides.doctorFindings ?? [] }; },
    async startAppServer() { order.push("app-server"); return client; },
    async startNewThread(_request, commandDependencies) { order.push("start-turn"); await commandDependencies.reportThreadId("thread-1"); await commandDependencies.reportTurnState({ fixture: true }); await client.close(); return record; },
    async resumeThread(_threadId, _prompt, commandDependencies) { order.push("resume-turn"); await commandDependencies.reportTurnState({ fixture: true }); await client.close(); return record; },
    async readLiveStatus() { order.push("live-read"); await client.close(); return { record, liveStatus: { type: "idle" } }; },
    async readThreadRecord() { order.push("read-record"); return record; },
    async findLatestThreadRecord(_stateRoot, input) { order.push("latest-record"); overrides.onFindLatest?.(input); return record; },
    async releaseProcessLock() { order.push("unlock"); if (overrides.releaseError) throw new Error("release"); },
    renderTurnState() { return ["event", "event", "Terminal status: completed"]; },
    createTerminalApprovalPromptWriter() { return { async writePrompt() {} }; },
    scratchParent: "/fixture/scratch",
    platform: "darwin",
    platformVersion: "fixture",
  };
  return { order, dependencies };
}

test("compiled CLI exposes exact help and routes the four-command grammar", async () => {
  const { cliModule } = modules();
  const output = capture();
  const calls = [];
  const handlers = { doctor: async () => { calls.push(["doctor"]); return 0; }, run: async (...args) => { calls.push(["run", ...args.slice(0, 2)]); return 0; }, resume: async (...args) => { calls.push(["resume", ...args.slice(0, 2)]); return 0; }, status: async (...args) => { calls.push(["status", ...args.slice(0, 1)]); return 0; } };
  assert.equal(await cliModule.main(["--help"], { ...output, handlers }), 0);
  assert.equal(output.output().stdout, "Usage:\nandrew-agent doctor\nandrew-agent run <repository> <prompt>\nandrew-agent resume <thread-id> [prompt]\nandrew-agent status [thread-id]\n");
  assert.equal(await cliModule.main(["doctor"], { ...capture(), handlers }), 0);
  assert.equal(await cliModule.main(["run", "/repo", "prompt"], { ...capture(), handlers }), 0);
  assert.equal(await cliModule.main(["resume", "thread-1"], { ...capture(), handlers }), 0);
  assert.equal(await cliModule.main(["resume", "thread-1", "next"], { ...capture(), handlers }), 0);
  assert.equal(await cliModule.main(["status"], { ...capture(), handlers }), 0);
  assert.equal(await cliModule.main(["status", "thread-1"], { ...capture(), handlers }), 0);
  assert.deepEqual(calls, [["doctor"], ["run", "/repo", "prompt"], ["resume", "thread-1", undefined], ["resume", "thread-1", "next"], ["status", undefined], ["status", "thread-1"]]);
});

test("command help exits before handlers and invalid grammar exits 2", async () => {
  const { cliModule } = modules();
  const calls = [];
  const handlers = Object.fromEntries(["doctor", "run", "resume", "status"].map((name) => [name, async () => { calls.push(name); return 0; }]));
  const topLevelUsage = "Usage:\nandrew-agent doctor\nandrew-agent run <repository> <prompt>\nandrew-agent resume <thread-id> [prompt]\nandrew-agent status [thread-id]\n";
  for (const [argv, usage] of [[["doctor", "-h"], "andrew-agent doctor"], [["run", "--help"], "andrew-agent run <repository> <prompt>"], [["resume", "-h"], "andrew-agent resume <thread-id> [prompt]"], [["status", "--help"], "andrew-agent status [thread-id]"]]) {
    const output = capture();
    assert.equal(await cliModule.main(argv, { ...output, handlers }), 0);
    assert.equal(output.output().stdout, `Usage: ${usage}\n`);
  }
  for (const [argv, expected] of [
    [[], `Invalid command usage.\n${topLevelUsage}`],
    [["unknown"], `Invalid command usage.\n${topLevelUsage}`],
    [["--bad"], `Invalid command usage.\n${topLevelUsage}`],
    [["doctor", "-hh"], "Invalid command usage.\nUsage: andrew-agent doctor\n"],
    [["doctor", "--help=true"], "Invalid command usage.\nUsage: andrew-agent doctor\n"],
    [["doctor", "--bad"], "Invalid command usage.\nUsage: andrew-agent doctor\n"],
    [["doctor", "extra"], "Invalid command usage.\nUsage: andrew-agent doctor\n"],
    [["run", "--bad"], "Invalid command usage.\nUsage: andrew-agent run <repository> <prompt>\n"],
    [["run", "", "p"], "Invalid command usage.\nUsage: andrew-agent run <repository> <prompt>\n"],
    [["run", "/r"], "Invalid command usage.\nUsage: andrew-agent run <repository> <prompt>\n"],
    [["run", "/r", "p", "extra"], "Invalid command usage.\nUsage: andrew-agent run <repository> <prompt>\n"],
    [["resume", "--bad"], "Invalid command usage.\nUsage: andrew-agent resume <thread-id> [prompt]\n"],
    [["resume", ""], "Invalid command usage.\nUsage: andrew-agent resume <thread-id> [prompt]\n"],
    [["resume", "thread", ""], "Invalid command usage.\nUsage: andrew-agent resume <thread-id> [prompt]\n"],
    [["resume", "thread", "p", "extra"], "Invalid command usage.\nUsage: andrew-agent resume <thread-id> [prompt]\n"],
    [["status", "a", "b"], "Invalid command usage.\nUsage: andrew-agent status [thread-id]\n"],
    [["status", "--bad"], "Invalid command usage.\nUsage: andrew-agent status [thread-id]\n"],
  ]) {
    const output = capture();
    assert.equal(await cliModule.main(argv, { ...output, handlers }), 2, argv.join(" "));
    assert.equal(output.output().stderr, expected);
  }
  assert.deepEqual(calls, []);
});

test("double dash preserves a dash-prefixed prompt", async () => {
  const { cliModule } = modules();
  const calls = [];
  const handlers = { doctor: async () => 0, run: async (repository, prompt) => { calls.push([repository, prompt]); return 0; }, resume: async () => 0, status: async () => 0 };
  assert.equal(await cliModule.main(["run", "/repo", "--", "-prompt"], { ...capture(), handlers }), 0);
  assert.deepEqual(calls, [["/repo", "-prompt"]]);
});

test("unexpected handler failures are redacted", async () => {
  const { cliModule } = modules();
  const output = capture();
  const secret = "fixture-secret-prompt";
  const handlers = { doctor: async () => { throw new Error(secret); }, run: async () => 0, resume: async () => 0, status: async () => 0 };
  assert.equal(await cliModule.main(["doctor"], { ...output, handlers }), 1);
  assert.equal(output.output().stderr, "Command failed.\n");
  assert.equal(`${output.output().stdout}${output.output().stderr}`.includes(secret), false);
});

test("an asynchronously broken output stream returns a stable command failure", async () => {
  const { cliModule } = modules();
  const diagnostic = capture();
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("secret-output-error"));
    },
  });
  assert.equal(
    await cliModule.main(["--help"], {
      stdout: broken,
      stderr: diagnostic.stderr,
    }),
    1,
  );
  assert.equal(diagnostic.output().stderr, "Command failed.\n");
  assert.equal(diagnostic.output().stderr.includes("secret-output-error"), false);
});

test("a stalled real Writable times out, removes listeners, and still unlocks", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let firstWrite = true;
  const stalled = new Writable({
    write(_chunk, _encoding, callback) {
      if (firstWrite) {
        firstWrite = false;
      } else {
        callback();
      }
    },
  });
  const initialErrorListeners = stalled.listenerCount("error");
  const harness = operationHarness(repositoryRoot);
  harness.dependencies.startNewThread = async (_request, commandDependencies) => {
    harness.order.push("start-turn");
    try {
      await commandDependencies.reportThreadId("thread-1");
    } finally {
      harness.order.push("client-close");
    }
    return terminalRecord(repositoryRoot);
  };
  const running = runModule.runCommand(repositoryRoot, "prompt", { ...capture(), stdout: stalled }, harness.dependencies);
  const result = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 1_500)),
  ]);
  assert.equal(result, 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(stalled.listenerCount("error"), initialErrorListeners);
  assert.deepEqual(harness.order.slice(-2), ["client-close", "unlock"]);
});

test("a late real Writable callback error is absorbed only within bounded cleanup", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let releaseLateWrite;
  const stalled = new Writable({
    write(_chunk, _encoding, callback) {
      releaseLateWrite = callback;
    },
  });
  const initialErrorListeners = stalled.listenerCount("error");
  const harness = operationHarness(repositoryRoot);
  harness.dependencies.startNewThread = async (_request, commandDependencies) => {
    harness.order.push("start-turn");
    try {
      await commandDependencies.reportThreadId("thread-1");
    } finally {
      harness.order.push("client-close");
    }
    return terminalRecord(repositoryRoot);
  };
  const running = runModule.runCommand(repositoryRoot, "prompt", { ...capture(), stdout: stalled }, harness.dependencies);
  assert.equal(await running, 1);
  assert.deepEqual(harness.order.slice(-2), ["client-close", "unlock"]);
  releaseLateWrite(new Error("secret-late-output-error"));
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(stalled.listenerCount("error"), initialErrorListeners);
});

test("a failed message chunk is delivered by the next real report", async (t) => {
  const { runModule } = modules();
  assert.notEqual(rendererModule, null, "the built renderer module must be available");
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const messageText = "answer ".repeat(180);
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([
      [
        "msg-1",
        {
          id: "msg-1",
          type: "agentMessage",
          phase: "completed",
          value: { text: messageText },
        },
      ],
    ]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  };
  let injectedFailure = false;
  const written = [];
  const output = {
    destroyed: false,
    once(event, _listener) {
      assert.equal(event, "error");
      return this;
    },
    removeListener(event, _listener) {
      assert.equal(event, "error");
      return this;
    },
    write(value, callback) {
      const line = String(value);
      if (!injectedFailure && /msg-1 agentMessage completed \[2\//.test(line)) {
        injectedFailure = true;
        callback(new Error("fixture write failure"));
        return false;
      }
      written.push(line);
      callback();
      return true;
    },
  };
  const harness = operationHarness(repositoryRoot);
  harness.dependencies.renderTurnState = rendererModule.renderTurnState;
  harness.dependencies.startNewThread = async (_request, commandDependencies) => {
    await assert.rejects(
      commandDependencies.reportTurnState(state),
      { code: "COMMAND_OUTPUT_FAILED" },
    );
    await commandDependencies.reportTurnState(state);
    return terminalRecord(repositoryRoot);
  };

  assert.equal(
    await runModule.runCommand(
      repositoryRoot,
      "prompt",
      { ...capture(), stdout: output },
      harness.dependencies,
    ),
    0,
  );
  assert.equal(injectedFailure, true, "the second message chunk must fail once");
  const deliveredText = written
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("msg-1 agentMessage completed"))
    .map((line) =>
      line.replace(
        /^msg-1 agentMessage completed(?: \[\d+\/\d+\])?: /,
        "",
      ),
    )
    .join("");
  assert.equal(deliveredText, messageText);
});

test("a callback-only output error does not retain an error listener forever", async () => {
  const { cliModule } = modules();
  const listeners = new Set();
  const callbackOnly = {
    destroyed: false,
    once(event, listener) {
      assert.equal(event, "error");
      listeners.add(listener);
      return this;
    },
    removeListener(event, listener) {
      assert.equal(event, "error");
      listeners.delete(listener);
      return this;
    },
    write(_value, callback) {
      callback(new Error("secret-callback-only-error"));
      return true;
    },
  };
  const initialErrorListeners = listeners.size;
  assert.equal(await cliModule.main(["--help"], { stdout: callbackOnly, stderr: capture().stderr }), 1);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(listeners.size, initialErrorListeners);
});

test("a healthy slow Writable callback completes within the write deadline", async () => {
  const { runModule } = modules();
  const slow = new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 25);
    },
  });
  const initialErrorListeners = slow.listenerCount("error");
  await runModule.writeLine(slow, "slow but healthy");
  assert.equal(slow.listenerCount("error"), initialErrorListeners);
});

test("terminal record rendering escapes controls within stable byte bounds", async () => {
  const { runModule } = modules();
  const controls = "\u001b[31m\u001b]0;owned\u0007\r\n\u009b31m\u202e";
  const longField = `${controls}${"가".repeat(2_000)}`;
  const record = {
    ...terminalRecord("/repo"),
    threadId: `thread-${longField}`,
    repositoryRoot: `repository-${longField}`,
    turnId: `turn-${longField}`,
    terminalStatus: `status-${longField}`,
    finalGitStatus: `git-${longField}`,
  };
  const originalRecord = structuredClone(record);
  const output = capture();

  await runModule.renderLocalRecord(record, output.stdout);

  const transcript = output.output().stdout;
  const lines = transcript.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 7);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/u.test(transcript), false);
  for (const visibleEscape of ["\\x1B", "\\x07", "\\x0D", "\\x0A", "\\x9B", "\\u{202E}"])
    assert.equal(transcript.includes(visibleEscape), true, visibleEscape);
  for (const label of [
    "Thread ID: ",
    "Repository: ",
    "Turn ID: ",
    "Terminal status: ",
    "Final Git status: ",
  ]) {
    const line = lines.find((candidate) => candidate.startsWith(label));
    assert.notEqual(line, undefined, label);
    const field = line.slice(label.length);
    assert.ok(Buffer.byteLength(field, "utf8") <= 4 * 1024, label);
    assert.equal(field.endsWith(" [truncated]"), true, label);
  }
  assert.deepEqual(record, originalRecord);

  const writeOutput = capture();
  await runModule.writeLine(
    writeOutput.stdout,
    `${controls}${"나".repeat(30_000)}`,
  );
  const write = writeOutput.output().stdout;
  assert.ok(Buffer.byteLength(write, "utf8") <= 64 * 1024);
  assert.equal(write.endsWith(" [truncated]\n"), true);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/u.test(write), false);

  const ordinary = capture();
  await runModule.writeLine(ordinary.stdout, "ordinary output");
  assert.equal(ordinary.output().stdout, "ordinary output\n");
});

test("run rejects tracked and untracked dirt before runtime mutation", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await writeFile(join(repositoryRoot, "tracked.txt"), "after\n");
  await writeFile(join(repositoryRoot, "untracked.txt"), "new\n");
  const beforeTracked = await readFile(join(repositoryRoot, "tracked.txt"));
  const beforeStatus = (await execFile("git", ["-C", repositoryRoot, "status", "--porcelain=v2", "--untracked-files=all"])).stdout;
  const stateRoot = join(repositoryRoot, "state-canary");
  const harness = operationHarness(repositoryRoot, { stateRoot });
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), harness.dependencies), 3);
  assert.deepEqual(harness.order, ["paths", "snapshot", "clean"]);
  assert.deepEqual(await readFile(join(repositoryRoot, "tracked.txt")), beforeTracked);
  assert.equal((await execFile("git", ["-C", repositoryRoot, "status", "--porcelain=v2", "--untracked-files=all"])).stdout, beforeStatus);
  await assert.rejects(readFile(stateRoot), { code: "ENOENT" });
});

test("run and prompted resume reject a gitlink before setup with the safe diagnostic", async (t) => {
  const { runModule, resumeModule } = modules();
  const { repositoryRoot, sourceRoot } = await createRepositoryWithGitlink();
  t.after(() => Promise.all([
    rm(repositoryRoot, { recursive: true, force: true }),
    rm(sourceRoot, { recursive: true, force: true }),
  ]));

  for (const command of ["run", "resume"]) {
    const harness = operationHarness(repositoryRoot);
    const output = capture();
    const exitCode = command === "run"
      ? await runModule.runCommand(repositoryRoot, "prompt", output, harness.dependencies)
      : await resumeModule.resumeCommand("thread-1", "prompt", output, harness.dependencies);

    assert.equal(exitCode, 3, command);
    assert.equal(output.output().stderr, "Submodules are unsupported in v0.1.\n", command);
    assert.deepEqual(
      harness.order,
      command === "run"
        ? ["paths", "snapshot"]
        : ["paths", "read-record", "snapshot"],
      command,
    );
  }
});

test("run observes clean Git before ordered setup and releases after close", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot);
  const output = capture();
  assert.equal(await runModule.runCommand(relative(process.cwd(), repositoryRoot), "prompt", output, harness.dependencies), 0);
  assert.deepEqual(harness.order, ["paths", "snapshot", "clean", "initialize", "lock", "recover", "build", "install", "readiness", "app-server", "start-turn", "client-close", "unlock"]);
  assert.equal(output.output().stdout.startsWith("Thread ID: thread-1\n"), true);
  assert.equal(output.output().stdout.match(/^event$/gm)?.length, 1);
  assert.match(output.output().stdout, /Final Git status:/);
});

test("readiness blocker prevents App Server and releases the lock", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot, { doctorExit: 1 });
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), harness.dependencies), 3);
  assert.deepEqual(harness.order, ["paths", "snapshot", "clean", "initialize", "lock", "recover", "build", "install", "readiness", "unlock"]);
});

test("a readiness blocker names itself on stderr instead of one bare line", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const findings = [
    { severity: "blocker", code: "ACTIVE_INSTALL", message: "The active installation is missing or invalid.", remediation: "Install a valid candidate before retrying." },
    { severity: "warning", code: "OPTIONAL_ORACLE", message: "Oracle was not requested for this candidate." },
    { severity: "blocker", code: "STRICT_CONFIG", message: "Strict Codex configuration validation could not run." },
  ];
  const harness = operationHarness(repositoryRoot, { doctorExit: 1, doctorFindings: findings });
  const output = capture();
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", output, harness.dependencies), 3);
  const { stderr } = output.output();
  assert.match(stderr, /ACTIVE_INSTALL/);
  assert.match(stderr, /STRICT_CONFIG/);
  // Only what stops the run, and never the passing checks around it.
  assert.doesNotMatch(stderr, /OPTIONAL_ORACLE/);
});

test("readiness reports only the version blocker after skipped checks", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const findings = [
    { severity: "blocker", code: "CODEX_VERSION", message: "Resolved Codex version does not match codex-cli 0.152.1." },
    { severity: "warning", code: "SCHEMA_COMPATIBILITY", message: "Codex schema compatibility was not evaluated because the pinned Codex version was unavailable." },
    { severity: "warning", code: "STRICT_CONFIG", message: "Strict Codex configuration validation was not evaluated because the pinned Codex version was unavailable." },
  ];
  const harness = operationHarness(repositoryRoot, { doctorExit: 1, doctorFindings: findings });
  const output = capture();
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", output, harness.dependencies), 3);
  assert.equal(
    output.output().stderr,
    "Candidate readiness failed: CODEX_VERSION.\n",
  );
});

test("resume blames the path check, not thread lookup, when paths fail", async (t) => {
  const { resumeModule } = modules();
  const pathsModule = await import("../../dist/runtime/paths.js");
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot, {});
  harness.dependencies.resolveRuntimePaths = async () => {
    throw new pathsModule.RuntimePathError("CODEX_BINARY_NOT_FOUND", "no codex");
  };
  const output = capture();
  assert.equal(await resumeModule.resumeCommand("thread-1", "prompt", output, harness.dependencies), 3);
  const { stderr } = output.output();
  assert.match(stderr, /CODEX_BINARY_NOT_FOUND/);
  assert.doesNotMatch(stderr, /thread lookup/i);
});

test("a preflight refusal names the check that refused", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await writeFile(join(repositoryRoot, "tracked.txt"), "after\n");
  const harness = operationHarness(repositoryRoot, {});
  const output = capture();
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", output, harness.dependencies), 3);
  assert.match(output.output().stderr, /GIT_WORKTREE_DIRTY/);
});

test("a summarized dirty preflight escapes and bounds affected paths", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const error = new gitModule.GitRuntimeError(
    "GIT_WORKTREE_DIRTY",
    "Git worktree is not clean.",
  );
  error.dirtyPathSummary = {
    paths: ["line\nbreak.txt", `long-${"가".repeat(2_000)}.txt`],
    omittedPathCount: 1,
  };
  const harness = operationHarness(repositoryRoot, {});
  harness.dependencies.assertCleanGitSnapshot = () => {
    throw error;
  };
  const output = capture();
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", output, harness.dependencies), 3);
  const { stderr } = output.output();
  const [headline, paths] = stderr.trimEnd().split("\n");
  assert.equal(headline, "Repository preflight failed: GIT_WORKTREE_DIRTY.");
  assert.match(paths, /^Affected paths: line\\x0Abreak\.txt, long-/);
  assert.match(paths, /\[truncated\]; 1 path\(s\) omitted\.$/);
  assert.equal(Buffer.byteLength(paths, "utf8") <= 8 * 4_096, true);
  assert.equal(stderr.includes(repositoryRoot), false);
});

test("a summarized dirty preflight bypasses an app-server phase fallback", () => {
  const { runModule } = modules();
  const error = new gitModule.GitRuntimeError(
    "GIT_WORKTREE_DIRTY",
    "Git worktree is not clean.",
  );
  error.dirtyPathSummary = {
    paths: ["changed.txt"],
    omittedPathCount: 0,
  };
  assert.equal(
    runModule.diagnosticFor(error, "app-server"),
    "Repository preflight failed: GIT_WORKTREE_DIRTY.\nAffected paths: changed.txt.",
  );
});

test("resume reports a readiness blocker the same way run does", async (t) => {
  const { resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const findings = [{ severity: "blocker", code: "BUNDLE_DIGEST", message: "Bundle digest compatibility cannot be established." }];
  const harness = operationHarness(repositoryRoot, { doctorExit: 1, doctorFindings: findings });
  const output = capture();
  assert.equal(await resumeModule.resumeCommand("thread-1", "prompt", output, harness.dependencies), 3);
  assert.match(output.output().stderr, /BUNDLE_DIGEST/);
});

test("a lock release failure is a runtime failure, never false success", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot, { releaseError: true });
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), harness.dependencies), 3);
  assert.equal(harness.order.at(-1), "unlock");
});

test("prompted resume reads the record before Git and uses mutating order", async (t) => {
  const { resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot);
  assert.equal(await resumeModule.resumeCommand("thread-1", "next", capture(), harness.dependencies), 0);
  assert.deepEqual(harness.order, ["paths", "read-record", "snapshot", "clean", "initialize", "lock", "recover", "build", "install", "readiness", "app-server", "resume-turn", "client-close", "unlock"]);
});

test("prompted resume reports changed clean HEAD before setup and is silent otherwise", async (t) => {
  const { resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const storedHead = (await execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(repositoryRoot, "tracked.txt"), "next\n");
  await execFile("git", ["-C", repositoryRoot, "add", "tracked.txt"]);
  await execFile("git", ["-C", repositoryRoot, "commit", "--quiet", "-m", "next fixture"]);
  const currentHead = (await execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();

  const changed = operationHarness(repositoryRoot, {
    record: { ...terminalRecord(repositoryRoot), terminalHead: storedHead },
  });
  const changedOutput = capture();
  const originalWrite = changedOutput.stdout.write.bind(changedOutput.stdout);
  changedOutput.stdout.write = (value) => {
    changed.order.push(`stdout:${String(value)}`);
    return originalWrite(value);
  };
  assert.equal(await resumeModule.resumeCommand("thread-1", "next", changedOutput, changed.dependencies), 0);
  assert.match(
    changedOutput.output().stdout,
    new RegExp(`Repository HEAD changed: stored ${storedHead}, current ${currentHead}\\.`),
  );
  const noticeIndex = changed.order.findIndex((entry) => entry.startsWith("stdout:Repository HEAD changed:"));
  assert.ok(changed.order.indexOf("clean") < noticeIndex);
  assert.ok(noticeIndex < changed.order.indexOf("initialize"));

  for (const terminalHead of [currentHead, null]) {
    const silent = operationHarness(repositoryRoot, {
      record: { ...terminalRecord(repositoryRoot), terminalHead },
    });
    const output = capture();
    assert.equal(await resumeModule.resumeCommand("thread-1", "next", output, silent.dependencies), 0);
    assert.doesNotMatch(output.output().stdout, /Repository HEAD changed:/);
  }

  const sha256Stored = "c".repeat(64);
  const sha256Current = "d".repeat(64);
  const sha256 = operationHarness(repositoryRoot, {
    record: { ...terminalRecord(repositoryRoot), terminalHead: sha256Stored },
  });
  sha256.dependencies.readGitSnapshot = async () => {
    sha256.order.push("snapshot");
    return {
      ...(await gitModule.readGitSnapshot(repositoryRoot)),
      head: sha256Current,
    };
  };
  const sha256Output = capture();
  assert.equal(
    await resumeModule.resumeCommand(
      "thread-1",
      "next",
      sha256Output,
      sha256.dependencies,
    ),
    0,
  );
  assert.match(
    sha256Output.output().stdout,
    new RegExp(
      `Repository HEAD changed: stored ${sha256Stored}, current ${sha256Current}\\.`,
    ),
  );
});

test("prompted resume rejects malformed stored and current HEADs without disclosure or setup", async (t) => {
  const { resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const snapshot = await gitModule.readGitSnapshot(repositoryRoot);
  const validHead = snapshot.head;
  const cases = [
    {
      name: "long multibyte stored secret",
      storedHead: `secret-stored-canary-${"가".repeat(2_000)}`,
      currentHead: validHead,
    },
    {
      name: "long multibyte current secret",
      storedHead: validHead,
      currentHead: `secret-current-canary-${"나".repeat(2_000)}`,
    },
    {
      name: "short stored value",
      storedHead: "secret-short",
      currentHead: validHead,
    },
    {
      name: "uppercase current value",
      storedHead: "c".repeat(64),
      currentHead: "A".repeat(40),
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const harness = operationHarness(repositoryRoot, {
        record: {
          ...terminalRecord(repositoryRoot),
          terminalHead: fixtureCase.storedHead,
        },
      });
      harness.dependencies.readGitSnapshot = async () => {
        harness.order.push("snapshot");
        return { ...snapshot, head: fixtureCase.currentHead };
      };
      const output = capture();

      assert.equal(
        await resumeModule.resumeCommand(
          "thread-1",
          "next",
          output,
          harness.dependencies,
        ),
        3,
        fixtureCase.name,
      );
      assert.deepEqual(
        harness.order,
        ["paths", "read-record", "snapshot", "clean"],
        fixtureCase.name,
      );
      assert.equal(output.output().stdout, "", fixtureCase.name);
      assert.equal(
        output.output().stderr,
        "Local thread lookup failed.\n",
        fixtureCase.name,
      );
      const transcript = `${output.output().stdout}${output.output().stderr}`;
      assert.equal(
        transcript.includes("Repository HEAD changed:"),
        false,
        fixtureCase.name,
      );
      assert.equal(
        transcript.includes(fixtureCase.storedHead),
        false,
        fixtureCase.name,
      );
      assert.equal(
        transcript.includes(fixtureCase.currentHead),
        false,
        fixtureCase.name,
      );
    });
  }
});

test("prompted resume rejects a stored repository identity change before mutation", async (t) => {
  const { resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const record = terminalRecord(repositoryRoot);
  record.repositoryRoot = `${repositoryRoot}-replaced`;
  const harness = operationHarness(repositoryRoot, { record });
  harness.dependencies.readGitSnapshot = async () => {
    harness.order.push("snapshot");
    return gitModule.readGitSnapshot(repositoryRoot);
  };
  assert.equal(await resumeModule.resumeCommand("thread-1", "next", capture(), harness.dependencies), 3);
  assert.deepEqual(harness.order, ["paths", "read-record", "snapshot"]);
});

test("promptless resume and local status only read records", async (t) => {
  const { resumeModule, statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const resumeHarness = operationHarness(repositoryRoot);
  assert.equal(await resumeModule.resumeCommand("thread-1", undefined, capture(), resumeHarness.dependencies), 0);
  assert.deepEqual(resumeHarness.order, ["paths", "read-record"]);
  const statusHarness = operationHarness(repositoryRoot);
  assert.equal(await statusModule.statusCommand(undefined, capture(), statusHarness.dependencies, repositoryRoot), 0);
  assert.deepEqual(statusHarness.order, ["paths", "latest-record"]);
});

test("local status resolves a repository subdirectory before latest lookup", async (t) => {
  const { statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const subdirectory = join(repositoryRoot, "nested", "working-directory");
  await mkdir(subdirectory, { recursive: true });
  let lookupRoot = null;
  const harness = operationHarness(repositoryRoot, {
    onFindLatest(value) {
      lookupRoot = value;
    },
  });

  assert.equal(
    await statusModule.statusCommand(
      undefined,
      capture(),
      harness.dependencies,
      subdirectory,
    ),
    0,
  );
  assert.equal(lookupRoot, repositoryRoot);
  assert.deepEqual(harness.order, ["paths", "latest-record"]);
});

test("read-only summaries succeed even when they describe a failed turn", async (t) => {
  const { resumeModule, statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const failed = terminalRecord(repositoryRoot, "failed");
  assert.equal(await resumeModule.resumeCommand("thread-1", undefined, capture(), operationHarness(repositoryRoot, { record: failed }).dependencies), 0);
  assert.equal(await statusModule.statusCommand(undefined, capture(), operationHarness(repositoryRoot, { record: failed }).dependencies, repositoryRoot), 0);
  assert.equal(await statusModule.statusCommand("thread-1", capture(), operationHarness(repositoryRoot, { record: failed }).dependencies, repositoryRoot), 0);
});

test("named status holds the lock around one live read", async (t) => {
  const { statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot);
  const output = capture();
  assert.equal(await statusModule.statusCommand("thread-1", output, harness.dependencies, repositoryRoot), 0);
  assert.deepEqual(harness.order, ["paths", "read-record", "lock", "app-server", "live-read", "client-close", "unlock"]);
  assert.match(output.output().stdout, /^Persisted thread record:\n/m);
  assert.match(output.output().stdout, /^Terminal status: completed$/m);
  assert.match(output.output().stdout, /^Live App Server status: idle$/m);
});

test("local status renders only persisted state without claiming live status", async (t) => {
  const { statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const harness = operationHarness(repositoryRoot);
  const output = capture();

  assert.equal(
    await statusModule.statusCommand(
      undefined,
      output,
      harness.dependencies,
      repositoryRoot,
    ),
    0,
  );
  assert.match(output.output().stdout, /^Terminal status: completed$/m);
  assert.equal(output.output().stdout.includes("Live App Server status:"), false);
  assert.equal(output.output().stdout.includes("Persisted thread record:"), false);
  assert.deepEqual(harness.order, ["paths", "latest-record"]);
});

test("resume and named status surface their lock release failures", async (t) => {
  const { resumeModule, statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const resumeHarness = operationHarness(repositoryRoot, { releaseError: true });
  assert.equal(await resumeModule.resumeCommand("thread-1", "next", capture(), resumeHarness.dependencies), 3);
  const statusHarness = operationHarness(repositoryRoot, { releaseError: true });
  assert.equal(await statusModule.statusCommand("thread-1", capture(), statusHarness.dependencies, repositoryRoot), 3);
});

test("terminal statuses map to stable exits", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const [terminalStatus, exitCode] of [["completed", 0], ["failed", 1], ["not-started", 1], ["interrupted", 130]]) {
    const harness = operationHarness(repositoryRoot, { record: terminalRecord(repositoryRoot, terminalStatus) });
    assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), harness.dependencies), exitCode);
  }
});

async function fakeAppServerHarness(repositoryRoot, mode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-cli-server-")));
  const sourceRoot = join(root, "source");
  const stateRoot = join(root, "state");
  const codexHome = join(stateRoot, "codex-home");
  const codexBin = join(root, "codex");
  await mkdir(sourceRoot);
  const script = `#!${process.execPath}
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-cli 0.152.1\\n"); process.exit(0); }
await mkdir(process.env.CODEX_HOME, { recursive: true });
const marker = join(process.env.CODEX_HOME, "fake-server.log");
await writeFile(join(process.env.CODEX_HOME, "fake-server.pid"), String(process.pid));
if (${JSON.stringify(mode)} === "exit") { process.stderr.write("secret-child-stderr"); process.exit(47); }
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await appendFile(marker, (message.method ?? ("response:" + JSON.stringify(message.result))) + "\\n");
  if (message.id === "approval-1" && message.method === undefined) {
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-fake", turn: { id: "turn-fake", itemsView: "full", items: [], status: "completed" } } }) + "\\n");
    continue;
  }
  if ((${JSON.stringify(mode)} === "resume-fail" && message.method === "thread/resume") || (${JSON.stringify(mode)} === "status-fail" && message.method === "thread/read")) {
    process.stderr.write("secret-live-operation-failure");
    process.exit(47);
  }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: ${JSON.stringify(mode)} === "malformed" ? {} : { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } }) + "\\n");
  } else if (message.method === "thread/start") {
    if (${JSON.stringify(mode)} === "pre-start-close") process.exit(47);
    if (${JSON.stringify(mode)} !== "pre-start-interrupt" && ${JSON.stringify(mode)} !== "pre-start-close") process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thread-fake" } } }) + "\\n");
  } else if (message.method === "thread/resume") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thread-fake" } } }) + "\\n");
  } else if (message.method === "thread/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thread-fake", status: { type: "idle" } } } }) + "\\n");
  } else if (message.method === "turn/start") {
    if (${JSON.stringify(mode)} === true) await writeFile(join(message.params.cwd, "tracked.txt"), "after\\n");
    if (${JSON.stringify(mode)} === "active-exit-run" || ${JSON.stringify(mode)} === "active-exit-resume") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn-fake" } } }) + "\\n", () => process.exit(47));
      continue;
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn-fake" } } }) + "\\n");
    if (${JSON.stringify(mode)} === "approval") setTimeout(() => process.stdout.write(JSON.stringify({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId: "thread-fake", turnId: "turn-fake", itemId: "command-1", startedAtMs: 1, environmentId: null, reason: "Needed", command: "pwd", cwd: ${JSON.stringify(repositoryRoot)}, commandActions: [], proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: [] } }) + "\\n"), 10);
    if (${JSON.stringify(mode)} === true || ${JSON.stringify(mode)} === "resume") setTimeout(() => {
      const command = { type: "commandExecution", id: "command-1", pluginId: null, scriptPath: null, command: "git status --short", cwd: ${JSON.stringify(repositoryRoot)}, processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "clean", exitCode: 7, durationMs: 1 };
      const frames = [
        { method: "item/started", params: { threadId: "thread-fake", turnId: "turn-fake", startedAtMs: 1, item: { ...command, status: "inProgress", aggregatedOutput: null, exitCode: null } } },
        { method: "item/completed", params: { threadId: "thread-fake", turnId: "turn-fake", completedAtMs: 2, item: command } },
        { method: "turn/diff/updated", params: { threadId: "thread-fake", turnId: "turn-fake", diff: "diff --git a/tracked.txt b/tracked.txt\\n+safe" } },
        { method: "turn/completed", params: { threadId: "thread-fake", turn: { id: "turn-fake", itemsView: "full", items: [command, { type: "fileChange", id: "files-1", changes: [{ path: "tracked.txt", kind: "update", diff: "+safe" }], status: "completed" }], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } },
      ];
      for (const frame of frames) process.stdout.write(JSON.stringify(frame) + "\\n");
    }, 10);
  } else if (message.method === "turn/interrupt") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    if (${JSON.stringify(mode)} === "approval") setTimeout(() => process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-fake", turn: { id: "turn-fake", itemsView: "full", items: [], status: "completed" } } }) + "\\n"), 10);
  }
}
`;
  await writeFile(codexBin, script);
  await chmod(codexBin, 0o755);
  const paths = { sourceRoot, stateRoot, codexHome, codexBin };
  const dependencies = {
    ...runModule.defaultCommandDependencies,
    async resolveRuntimePaths() { return paths; },
    async buildBundle() { return { artifactRoot: join(stateRoot, "artifact"), metadata: { bundleDigest: "c".repeat(64) } }; },
    async installBundle() {},
    async recoverInterruptedInstall() {},
    async runDoctor() { return { exitCode: 0, findings: [] }; },
    scratchParent: root,
    platform: "darwin",
    platformVersion: "fixture",
  };
  return { root, stateRoot, codexHome, dependencies };
}

async function seedThreadRecord(repositoryRoot, fixture) {
  await fixture.dependencies.initializeRuntimeState({ sourceRoot: join(fixture.root, "source"), stateRoot: fixture.stateRoot, codexHome: fixture.codexHome, codexBin: join(fixture.root, "codex") });
  const snapshot = await gitModule.readGitSnapshot(repositoryRoot);
  await threadStoreModule.writeThreadRecord(fixture.stateRoot, {
    threadId: "thread-fake",
    repositoryRoot,
    startingHead: snapshot.head,
    terminalHead: snapshot.head,
    bundleDigest: "c".repeat(64),
    productVersion: "0.1.0",
    codexVersion: "0.148.0",
    turnId: "turn-old",
    terminalStatus: "completed",
    finalGitStatus: "",
  });
}

async function assertFakeServerCleanup(fixture) {
  const childPid = Number(await readFile(join(fixture.codexHome, "fake-server.pid"), "utf8"));
  await waitFor(() => { assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }); return true; });
  await assert.rejects(lstat(join(fixture.stateRoot, "run.lock")), { code: "ENOENT" });
}

async function cleanupFakeAppServerFixture(fixture) {
  try {
    const childPid = Number(await readFile(join(fixture.codexHome, "fake-server.pid"), "utf8"));
    try {
      process.kill(childPid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitFor(() => {
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      return true;
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function observeUnlockAfterChildExit(fixture) {
  const release = fixture.dependencies.releaseProcessLock;
  let calls = 0;
  fixture.dependencies.releaseProcessLock = async (handle) => {
    const childPid = Number(await readFile(join(fixture.codexHome, "fake-server.pid"), "utf8"));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    calls += 1;
    await release(handle);
  };
  return () => assert.equal(calls, 1);
}

function observeClientCloseBeforeUnlock(fixture) {
  const start = fixture.dependencies.startAppServer;
  const release = fixture.dependencies.releaseProcessLock;
  let closeCalls = 0;
  fixture.dependencies.startAppServer = async (input) => {
    const client = await start(input);
    const close = client.close.bind(client);
    client.close = async () => {
      closeCalls += 1;
      await close();
    };
    return client;
  };
  fixture.dependencies.releaseProcessLock = async (handle) => {
    assert.equal(closeCalls, 1);
    await release(handle);
  };
  return () => assert.equal(closeCalls, 1);
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error("fixture timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settleWithin(settlement, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      settlement,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("real command composition drives and reaps one fake App Server", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  const fixture = await fakeAppServerHarness(repositoryRoot, true);
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(fixture.root, { recursive: true, force: true })]));
  const headBefore = (await execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  const output = capture();
  assert.equal(await runModule.runCommand(repositoryRoot, "fixture prompt", output, fixture.dependencies), 0);
  assert.equal(output.output().stdout.startsWith("Thread ID: thread-fake\n"), true);
  assert.match(output.output().stdout, /Observed command: git status --short .* exit 7/);
  assert.match(output.output().stdout, /Final diff:/);
  assert.match(output.output().stdout, /tracked\.txt/);
  assert.match(output.output().stdout, /Terminal status: completed/);
  assert.equal(await readFile(join(repositoryRoot, "tracked.txt"), "utf8"), "after\n");
  const headAfter = (await execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  const dirtyStatus = (await execFile("git", ["-C", repositoryRoot, "status", "--porcelain=v2", "--untracked-files=all"])).stdout;
  assert.equal(headAfter, headBefore);
  assert.match(dirtyStatus, /^1 \.M /m);
  assert.match(output.output().stdout, /Final Git status: 1 \.M /);
  assert.equal((await execFile("git", ["-C", repositoryRoot, "stash", "list"])).stdout, "");
  assert.equal((await execFile("git", ["-C", repositoryRoot, "remote"])).stdout, "");
  const log = await readFile(join(fixture.codexHome, "fake-server.log"), "utf8");
  assert.match(log, /^initialize\ninitialized\nthread\/start\nturn\/start\n$/);
  const childPid = Number(await readFile(join(fixture.codexHome, "fake-server.pid"), "utf8"));
  await waitFor(() => { assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }); return true; });
  await assert.rejects(lstat(join(fixture.stateRoot, "run.lock")), { code: "ENOENT" });
});

test("real fake App Server supports prompted resume and named status", async (t) => {
  const { resumeModule, statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const command of ["resume", "status"]) {
    const fixture = await fakeAppServerHarness(repositoryRoot, command);
    try {
      await seedThreadRecord(repositoryRoot, fixture);
      const assertReleaseOrder = observeUnlockAfterChildExit(fixture);
      const output = capture();
      const exitCode = command === "resume"
        ? await resumeModule.resumeCommand("thread-fake", "continue", output, fixture.dependencies)
        : await statusModule.statusCommand("thread-fake", output, fixture.dependencies, repositoryRoot);
      assert.equal(exitCode, 0, command);
      const transcript = await readFile(join(fixture.codexHome, "fake-server.log"), "utf8");
      assert.match(transcript, command === "resume" ? /thread\/resume/ : /thread\/read/);
      assertReleaseOrder();
      await assertFakeServerCleanup(fixture);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("real fake resume and status failures stay stable and clean up", async (t) => {
  const { resumeModule, statusModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const command of ["resume", "status"]) {
    const fixture = await fakeAppServerHarness(repositoryRoot, `${command}-fail`);
    const cleanupFixture = () => cleanupFakeAppServerFixture(fixture);
    t.after(cleanupFixture);
    try {
      await seedThreadRecord(repositoryRoot, fixture);
      const assertReleaseOrder = observeUnlockAfterChildExit(fixture);
      const output = capture();
      const exitCode = command === "resume"
        ? await resumeModule.resumeCommand("thread-fake", "continue", output, fixture.dependencies)
        : await statusModule.statusCommand("thread-fake", output, fixture.dependencies, repositoryRoot);
      assert.equal(exitCode, 4, command);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("secret-live-operation-failure"), false);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("47"), false);
      assertReleaseOrder();
      await assertFakeServerCleanup(fixture);
    } finally {
      await cleanupFixture();
    }
  }
});

test("active fake-server exit persists failure before cleanup for run and resume", async (t) => {
  const { runModule, resumeModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const command of ["run", "resume"]) {
    const fixture = await fakeAppServerHarness(repositoryRoot, `active-exit-${command}`);
    const cleanupFixture = () => cleanupFakeAppServerFixture(fixture);
    t.after(cleanupFixture);
    try {
      if (command === "resume") await seedThreadRecord(repositoryRoot, fixture);
      const assertReleaseOrder = observeUnlockAfterChildExit(fixture);
      const assertClientCloseOrder = observeClientCloseBeforeUnlock(fixture);
      const output = capture();
      const running = command === "run"
        ? runModule.runCommand(repositoryRoot, "continue", output, fixture.dependencies)
        : resumeModule.resumeCommand("thread-fake", "continue", output, fixture.dependencies);
      const settlement = running.then(
        (value) => ({ kind: "resolved", value }),
        (error) => ({ kind: "rejected", error }),
      );
      let result = await settleWithin(settlement, 1_000);
      if (result.kind === "timeout") {
        process.emit("SIGINT");
        process.emit("SIGINT");
        result = await settleWithin(settlement, 1_000);
        if (result.kind === "timeout") {
          await cleanupFixture();
          throw new Error(`active-exit ${command} did not settle after signals`);
        }
      }
      if (result.kind === "rejected") throw result.error;
      assert.equal(result.value, 4, command);
      const record = await threadStoreModule.readThreadRecord(fixture.stateRoot, "thread-fake");
      assert.equal(record.terminalStatus, "failed", command);
      assert.equal(record.turnId, "turn-fake", command);
      assertReleaseOrder();
      assertClientCloseOrder();
      await assertFakeServerCleanup(fixture);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("47"), false);
    } finally {
      await cleanupFixture();
    }
  }
});

test("malformed and failed fake App Servers map to 4 without raw leakage", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  for (const mode of ["malformed", "exit"]) {
    const fixture = await fakeAppServerHarness(repositoryRoot, mode);
    const cleanupFixture = () => cleanupFakeAppServerFixture(fixture);
    t.after(cleanupFixture);
    try {
      const output = capture();
      assert.equal(await runModule.runCommand(repositoryRoot, "secret-prompt", output, fixture.dependencies), 4);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("secret-prompt"), false);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("secret-child-stderr"), false);
      assert.equal(`${output.output().stdout}${output.output().stderr}`.includes("47"), false);
      await assertFakeServerCleanup(fixture);
    } finally {
      await cleanupFixture();
    }
  }
});

test("closed approval input declines safely and lets the fake server settle", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  const fixture = await fakeAppServerHarness(repositoryRoot, "approval");
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(fixture.root, { recursive: true, force: true })]));
  const output = capture();
  output.stdin = Readable.from([]);
  Object.defineProperty(output.stdin, "isTTY", { value: true });
  fixture.dependencies.createTerminalApprovalPromptWriter = () => ({ async writePrompt() {} });
  assert.equal(await runModule.runCommand(repositoryRoot, "fixture prompt", output, fixture.dependencies), 0);
  assert.match(output.output().stdout, /Terminal status: completed/);
  assert.match(await readFile(join(fixture.codexHome, "fake-server.log"), "utf8"), /response:\{"decision":"decline"\}/);
});

test("two interrupts settle a real fake-server turn at 130 without listeners or locks", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  const fixture = await fakeAppServerHarness(repositoryRoot, false);
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(fixture.root, { recursive: true, force: true })]));
  const listenersBefore = process.listenerCount("SIGINT");
  const running = runModule.runCommand(repositoryRoot, "fixture prompt", capture(), fixture.dependencies);
  await waitFor(async () => (await readFile(join(fixture.codexHome, "fake-server.log"), "utf8")).includes("turn/start"));
  process.emit("SIGINT");
  await waitFor(async () => (await readFile(join(fixture.codexHome, "fake-server.log"), "utf8")).includes("turn/interrupt"));
  process.emit("SIGINT");
  assert.equal(await running, 130);
  assert.equal(process.listenerCount("SIGINT"), listenersBefore);
  await assert.rejects(lstat(join(fixture.stateRoot, "run.lock")), { code: "ENOENT" });
  assert.match(await readFile(join(fixture.codexHome, "fake-server.log"), "utf8"), /turn\/interrupt/);
});

test("two pre-thread-start interrupts settle at 130 without a record or leaks", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  const fixture = await fakeAppServerHarness(repositoryRoot, "pre-start-interrupt");
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(fixture.root, { recursive: true, force: true })]));
  const listenersBefore = process.listenerCount("SIGINT");
  const running = runModule.runCommand(repositoryRoot, "fixture prompt", capture(), fixture.dependencies);
  await waitFor(async () => (await readFile(join(fixture.codexHome, "fake-server.log"), "utf8")).includes("thread/start"));
  process.emit("SIGINT");
  process.emit("SIGINT");
  assert.equal(await running, 130);
  assert.equal(process.listenerCount("SIGINT"), listenersBefore);
  await assert.rejects(threadStoreModule.readThreadRecord(fixture.stateRoot, "thread-fake"), (error) => error.code === "THREAD_NOT_FOUND");
  await assertFakeServerCleanup(fixture);
});

test("ordinary pre-thread-start App Server close remains infrastructure exit 4", async (t) => {
  const { runModule } = modules();
  const repositoryRoot = await createRepository();
  const fixture = await fakeAppServerHarness(repositoryRoot, "pre-start-close");
  t.after(() => Promise.all([rm(repositoryRoot, { recursive: true, force: true }), rm(fixture.root, { recursive: true, force: true })]));
  assert.equal(await runModule.runCommand(repositoryRoot, "fixture prompt", capture(), fixture.dependencies), 4);
  await assert.rejects(threadStoreModule.readThreadRecord(fixture.stateRoot, "thread-fake"), (error) => error.code === "THREAD_NOT_FOUND");
  await assertFakeServerCleanup(fixture);
});

test("package bin targets the executable compiled CLI", async () => {
  modules();
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.bin, { "andrew-agent": "dist/cli.js" });
  const source = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node\n"), true);
  const { stdout } = await execFile(process.execPath, [fileURLToPath(new URL("../../dist/cli.js", import.meta.url)), "--help"]);
  assert.match(stdout, /andrew-agent run <repository> <prompt>/);
});

test("the capability flag is parsed, validated, and gated on its declared input", async () => {
  const { cliModule } = modules();
  const oracleEnv = { ANDREW_AGENT_ORACLE_ROOT: "/wiki" };
  const calls = [];
  const handlers = { doctor: async () => { calls.push(["doctor"]); return 0; }, run: async (...args) => { calls.push(["run", args[0], args[1], args[4]]); return 0; }, resume: async (...args) => { calls.push(["resume", args[0], args[1], args[4]]); return 0; }, status: async (...args) => { calls.push(["status", args[0]]); return 0; } };

  // Accepted: both spellings, a repeat collapsing to one, and resume, which
  // compares the flag against the thread's recorded grant rather than acting
  // on it directly.
  for (const argv of [["run", "--capability", "oracle", "/repo", "prompt"], ["run", "--capability=oracle", "/repo", "prompt"], ["run", "/repo", "prompt", "--capability", "oracle", "--capability", "oracle"]]) {
    assert.equal(await cliModule.main(argv, { ...capture(), handlers, env: oracleEnv }), 0, argv.join(" "));
  }
  assert.equal(await cliModule.main(["resume", "--capability", "oracle", "thread-1"], { ...capture(), handlers, env: oracleEnv }), 0);
  assert.deepEqual(calls, [["run", "/repo", "prompt", ["oracle"]], ["run", "/repo", "prompt", ["oracle"]], ["run", "/repo", "prompt", ["oracle"]], ["resume", "thread-1", undefined, ["oracle"]]]);

  // The default is an empty set, and it does not consult the environment.
  calls.length = 0;
  assert.equal(await cliModule.main(["run", "/repo", "prompt"], { ...capture(), handlers, env: {} }), 0);
  assert.equal(await cliModule.main(["resume", "thread-1"], { ...capture(), handlers, env: {} }), 0);
  assert.deepEqual(calls, [["run", "/repo", "prompt", []], ["resume", "thread-1", undefined, []]]);

  // Rejected at exit 2. A near-miss token reaches this outcome through strict
  // parseArgs rather than the dash guard, so these cases assert the outcome
  // and do not distinguish which of the two gates produced it.
  calls.length = 0;
  const usageByCommand = {
    doctor: "andrew-agent doctor",
    run: "andrew-agent run <repository> <prompt>",
    resume: "andrew-agent resume <thread-id> [prompt]",
    status: "andrew-agent status [thread-id]",
  };
  for (const argv of [["run", "--capability", "bogus", "/repo", "prompt"], ["run", "--capability=bogus", "/repo", "prompt"], ["run", "--capabilityx", "oracle", "/repo", "prompt"], ["run", "--capability-foo", "/repo", "prompt"], ["run", "-c", "oracle", "/repo", "prompt"], ["run", "--capability", "/repo", "prompt"], ["doctor", "--capability", "oracle"], ["status", "--capability", "oracle"], ["status", "thread-1", "--capability", "oracle"], ["run", "--capability", "ORACLE", "/repo", "prompt"], ["run", "--capability", "", "/repo", "prompt"]]) {
    const output = capture();
    assert.equal(await cliModule.main(argv, { ...output, handlers, env: oracleEnv }), 2, argv.join(" "));
    assert.equal(
      output.output().stderr,
      `Invalid command usage.\nUsage: ${usageByCommand[argv[0]]}\n`,
      argv.join(" "),
    );
  }
  assert.deepEqual(calls, []);

  // Requested without its declared input: a named diagnostic, never a silent downgrade.
  for (const argv of [["run", "--capability", "oracle", "/repo", "prompt"], ["resume", "--capability", "oracle", "thread-1"]]) {
    for (const env of [{}, { ANDREW_AGENT_ORACLE_ROOT: "" }]) {
      const output = capture();
      assert.equal(await cliModule.main(argv, { ...output, handlers, env }), 3, argv.join(" "));
      assert.equal(output.output().stderr, "Capability preparation failed: ORACLE_ROOT_UNSET.\n");
      assert.equal(output.output().stdout, "");
    }
  }
  assert.deepEqual(calls, []);

  // The trailing separator still carries a dash-prefixed prompt through.
  assert.equal(await cliModule.main(["run", "--capability", "oracle", "/repo", "--", "-prompt"], { ...capture(), handlers, env: oracleEnv }), 0);
  assert.deepEqual(calls, [["run", "/repo", "-prompt", ["oracle"]]]);

  // Help still short-circuits ahead of the capability gate.
  const helpOutput = capture();
  assert.equal(await cliModule.main(["run", "--capability", "oracle", "--help"], { ...helpOutput, handlers, env: {} }), 0);
  assert.equal(helpOutput.output().stdout, "Usage: andrew-agent run <repository> <prompt>\n");
});

test("the requested capability set and its resolved root reach the bundle and the doctor gate", async () => {
  const repositoryRoot = await createRepository();
  const seen = [];
  const harness = operationHarness(repositoryRoot);
  const resolveCalls = [];
  const paths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex", oracleRoot: "/fixture/wiki" };
  const dependencies = {
    ...harness.dependencies,
    async resolveRuntimePaths(options) { resolveCalls.push(options); return options?.capabilities?.includes("oracle") ? paths : { ...paths, oracleRoot: undefined }; },
    async buildBundle(input) { seen.push(["build", input.requestedCapabilities, input.capabilityInputs]); return { artifactRoot: "/fixture/artifact", metadata: { bundleDigest: "c".repeat(64) } }; },
    async runDoctor(input) { seen.push(["doctor", input.requestedCapabilities, input.capabilityInputs]); return { exitCode: 0, findings: [] }; },
  };

  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, ["oracle"]), 0);
  assert.deepEqual(resolveCalls, [{ capabilities: ["oracle"] }]);
  // Both literal pairs move together: a doctor that validated an empty set
  // would be admitting a bundle it was never shown.
  assert.deepEqual(seen, [["build", ["oracle"], { oracle: { llmWikiRoot: "/fixture/wiki" } }], ["doctor", ["oracle"], { oracle: { llmWikiRoot: "/fixture/wiki" } }]]);

  seen.length = 0;
  resolveCalls.length = 0;
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, []), 0);
  assert.deepEqual(resolveCalls, [{ capabilities: [] }]);
  assert.deepEqual(seen, [["build", [], {}], ["doctor", [], {}]]);

  // resume carries the empty set until step 4 gives it a record to compare.
  seen.length = 0;
  assert.equal(await resumeModule.resumeCommand("thread-1", "prompt", capture(), dependencies), 0);
  assert.deepEqual(seen, [["build", [], {}], ["doctor", [], {}]]);
});

test("requesting a capability the bundle source does not declare aborts the run", async () => {
  const repositoryRoot = await createRepository();
  const harness = operationHarness(repositoryRoot);
  const refusal = new renderModule.RenderError("CAPABILITY_INPUT_INVALID", "Oracle input was provided without an Oracle capability declaration.");
  const output = capture();
  const dependencies = {
    ...harness.dependencies,
    async resolveRuntimePaths() { return { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex", oracleRoot: "/fixture/wiki" }; },
    async buildBundle() { throw refusal; },
    async installBundle() { throw new Error("install must not run after a refusal"); },
  };
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", output, dependencies, ["oracle"]), 3);
  assert.equal(output.output().stderr, "Runtime preparation failed: CAPABILITY_INPUT_INVALID.\n");
});

test("the resolved Oracle root reaches the App Server input, and only when it exists", async () => {
  const repositoryRoot = await createRepository();
  const basePaths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };

  // Directly, because appServerInput is the link between the resolved paths
  // and the spawn: without this the whole chain still passes while the child
  // is launched without the variable it needs.
  assert.equal(Object.hasOwn(runModule.appServerInput(basePaths), "llmWikiRoot"), false);
  assert.equal(runModule.appServerInput({ ...basePaths, oracleRoot: "/fixture/wiki" }).llmWikiRoot, "/fixture/wiki");

  // And through a run, so the chain from the requested set to the child input
  // is asserted end to end rather than at its two ends.
  const harness = operationHarness(repositoryRoot);
  const starts = [];
  const dependencies = {
    ...harness.dependencies,
    async resolveRuntimePaths(options) { return options?.capabilities?.includes("oracle") ? { ...basePaths, oracleRoot: "/fixture/wiki" } : basePaths; },
    async startAppServer(input) { starts.push(input.llmWikiRoot); return harness.dependencies.startAppServer(input); },
  };
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, ["oracle"]), 0);
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, []), 0);
  assert.deepEqual(starts, ["/fixture/wiki", undefined]);
});

test("resume derives its boundary from the record and refuses to be widened", async () => {
  const repositoryRoot = await createRepository();
  const rootA = "/fixture/wiki-a";
  const rootB = "/fixture/wiki-b";
  const digestOf = (root) => createHash("sha256").update(root, "utf8").digest("hex");
  const basePaths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };

  const attempt = async ({ grant, flag, currentRoot }) => {
    const harness = operationHarness(repositoryRoot, { record: terminalRecord(repositoryRoot, "completed", grant) });
    const output = capture();
    const dependencies = {
      ...harness.dependencies,
      async resolveRuntimePaths(options) {
        harness.order.push("paths");
        return options?.capabilities?.includes("oracle") ? { ...basePaths, oracleRoot: currentRoot } : basePaths;
      },
    };
    const code = await resumeModule.resumeCommand("thread-1", "prompt", output, dependencies, flag);
    return { code, stderr: output.output().stderr, order: harness.order };
  };

  // A thread granted nothing cannot be resumed with a capability.
  const widened = await attempt({ grant: {}, flag: ["oracle"], currentRoot: rootA });
  assert.equal(widened.code, 3);
  assert.equal(widened.stderr, "Resume refused: THREAD_CAPABILITY_MISMATCH.\n");
  assert.equal(widened.order.includes("lock"), false);

  // And a granted thread cannot be resumed as if it had none.
  const narrowed = await attempt({ grant: { requestedCapabilities: ["oracle"], oracleRootDigest: digestOf(rootA) }, flag: [], currentRoot: rootA });
  assert.equal(narrowed.code, 3);
  assert.equal(narrowed.stderr, "Resume refused: THREAD_CAPABILITY_MISMATCH.\n");

  // The set agreeing is not enough: the same ["oracle"] can name two wikis.
  const moved = await attempt({ grant: { requestedCapabilities: ["oracle"], oracleRootDigest: digestOf(rootA) }, flag: ["oracle"], currentRoot: rootB });
  assert.equal(moved.code, 3);
  assert.equal(moved.stderr, "Resume refused: THREAD_ORACLE_ROOT_CHANGED.\n");
  // Neither root is disclosed, and no path reaches the operator at all.
  for (const path of [rootA, rootB]) assert.equal(moved.stderr.includes(path), false);
  assert.equal(moved.order.includes("lock"), false);

  // Agreement on both admits the resume, and the grant reaches the turn.
  const agreed = await attempt({ grant: { requestedCapabilities: ["oracle"], oracleRootDigest: digestOf(rootA) }, flag: ["oracle"], currentRoot: rootA });
  assert.equal(agreed.code, 0);
  assert.equal(agreed.stderr, "");

  // A pre-capability thread resumes exactly as it did before this step.
  const untouched = await attempt({ grant: {}, flag: [], currentRoot: undefined });
  assert.equal(untouched.code, 0);
  assert.deepEqual(untouched.order.filter((entry) => entry === "paths"), ["paths"]);
});

test("a run records the grant it was given, so a later resume has something true to compare", async () => {
  const repositoryRoot = await createRepository();
  const oracleRoot = "/fixture/wiki-a";
  const expected = createHash("sha256").update(oracleRoot, "utf8").digest("hex");
  const basePaths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };

  // Directly: the digest is of the canonical root, and the path itself is
  // nowhere in the identity the records are built from.
  assert.equal(runModule.oracleRootDigest(basePaths), null);
  assert.equal(runModule.oracleRootDigest({ ...basePaths, oracleRoot }), expected);

  // And through a run, because the line that puts it on the release identity
  // is the only link between what was granted and what a resume reads back.
  const identities = [];
  const harness = operationHarness(repositoryRoot);
  const dependencies = {
    ...harness.dependencies,
    async resolveRuntimePaths(options) { return options?.capabilities?.includes("oracle") ? { ...basePaths, oracleRoot } : basePaths; },
    async startNewThread(request, coordinator) { identities.push(coordinator.releaseIdentity); return harness.dependencies.startNewThread(request, coordinator); },
  };
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, ["oracle"]), 0);
  assert.equal(await runModule.runCommand(repositoryRoot, "prompt", capture(), dependencies, []), 0);
  assert.deepEqual(identities.map((identity) => [identity.requestedCapabilities, identity.oracleRootDigest]), [[["oracle"], expected], [[], null]]);
  for (const identity of identities) assert.equal(JSON.stringify(identity).includes(oracleRoot), false);
});

test("the read-only resume form works regardless of the grant or the current environment", async () => {
  const repositoryRoot = await createRepository();
  const digestOf = (root) => createHash("sha256").update(root, "utf8").digest("hex");
  const basePaths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };
  const grant = { requestedCapabilities: ["oracle"], oracleRootDigest: digestOf("/fixture/wiki-a") };

  // `resume <thread-id>` starts no turn and no App Server, so there is nothing
  // for a capability boundary to protect. It has to keep working when the
  // caller passes no flag, and when the root has moved since.
  for (const [flag, currentRoot] of [[[], "/fixture/wiki-a"], [["oracle"], "/fixture/wiki-b"], [[], undefined]]) {
    const harness = operationHarness(repositoryRoot, { record: terminalRecord(repositoryRoot, "completed", grant) });
    const output = capture();
    const code = await resumeModule.resumeCommand("thread-1", undefined, output, {
      ...harness.dependencies,
      async resolveRuntimePaths(options) { return options?.capabilities?.includes("oracle") ? { ...basePaths, oracleRoot: currentRoot } : basePaths; },
    }, flag);
    assert.equal(code, 0, `${JSON.stringify(flag)} / ${currentRoot}`);
    assert.equal(output.output().stderr, "");
    assert.equal(harness.order.includes("lock"), false);
  }
});

test("an unusable Oracle root is reported by code, never by path", async () => {
  const repositoryRoot = await createRepository();
  const secret = "/private/wiki-nobody-should-see";
  const paths = await import("../../dist/runtime/paths.js");
  const harness = operationHarness(repositoryRoot);
  // Real errors, because the containment is diagnosticFor taking the code and
  // dropping the message — and these messages carry the path on purpose, so
  // the runtime layer can still say what it means internally.
  const cases = [
    new paths.RuntimePathError("RUNTIME_PATH_INVALID", `Runtime directory does not exist or is unsafe: ${secret}`),
    new paths.RuntimePathError("ORACLE_ROOT_OVERLAPS_STATE", `Oracle and state roots must not overlap: ${secret}`),
    new paths.RuntimePathError("RUNTIME_STATE_UNSAFE", `Runtime state path must not be a symbolic link: ${secret}`),
  ];
  for (const error of cases) {
    assert.equal(error.message.includes(secret), true, "the fixture must actually carry the path");
    const output = capture();
    const code = await runModule.runCommand(repositoryRoot, "prompt", output, { ...harness.dependencies, async resolveRuntimePaths() { throw error; } }, ["oracle"]);
    assert.equal(code, 3);
    assert.equal(output.output().stderr, `Runtime preparation failed: ${error.code}.\n`);
    assert.equal(output.output().stderr.includes(secret), false);
    assert.equal(output.output().stdout.includes(secret), false);
  }
});

test("doctor evaluates the capability the environment offers and survives one it cannot resolve", async () => {
  const inputs = [];
  const doctorRun = async (env, resolveImpl) => {
    inputs.length = 0;
    const output = capture();
    const code = await cliModule.doctorCommand(output, env, { resolveRuntimePaths: resolveImpl, runDoctor: async (input) => { inputs.push(input); return { exitCode: 0, findings: [{ severity: "ready", code: "OPTIONAL_ORACLE", message: "Oracle is enabled for this candidate." }] }; }, realpath: async (value) => value });
    return { code, stdout: output.output().stdout, stderr: output.output().stderr };
  };
  const basePaths = { sourceRoot: "/fixture/source", stateRoot: "/fixture/state", codexHome: "/fixture/state/codex-home", codexBin: "/fixture/bin/codex" };
  const withOracle = { ...basePaths, oracleRoot: "/fixture/wiki" };

  // Set and usable: the capability and its input both reach runDoctor.
  const enabled = await doctorRun({ ANDREW_AGENT_ORACLE_ROOT: "/fixture/wiki" }, async (options) => (options?.capabilities?.includes("oracle") ? withOracle : basePaths));
  assert.equal(enabled.code, 0);
  assert.deepEqual(inputs.map((input) => [input.requestedCapabilities, input.capabilityInputs]), [[["oracle"], { oracle: { llmWikiRoot: "/fixture/wiki" } }]]);

  // Unset: doctor asks for nothing and consults no capability input.
  const absent = await doctorRun({}, async () => basePaths);
  assert.equal(absent.code, 0);
  assert.deepEqual(inputs.map((input) => [input.requestedCapabilities, input.capabilityInputs]), [[[], {}]]);

  // Set but unresolvable: doctor still runs and reports, rather than becoming
  // harder to run than the thing it diagnoses.
  const broken = await doctorRun({ ANDREW_AGENT_ORACLE_ROOT: "/fixture/missing" }, async (options) => {
    if (options?.capabilities?.includes("oracle")) throw new Error("unresolvable");
    return basePaths;
  });
  assert.equal(broken.code, 0);
  assert.deepEqual(inputs.map((input) => [input.requestedCapabilities, input.capabilityInputs]), [[[], {}]]);
  assert.equal(broken.stderr, "");
});

test("renders context usage only when the record carries a measurement", async () => {
  const { runModule } = modules();
  const render = async (tokenUsage) => {
    const output = capture();
    await runModule.renderLocalRecord({ ...terminalRecord("/repo"), tokenUsage }, output.stdout);
    return output.output().stdout;
  };
  assert.match(await render({ totalTokens: 204000, contextWindow: 272000 }), /^Context usage: 204000 of 272000 tokens \(75%\)$/m);
  assert.match(await render({ totalTokens: 1300, contextWindow: null }), /^Context usage: 1300 tokens$/m);
  // A record from a run the App Server never measured, including one written
  // before this field existed, reports no usage line rather than a placeholder.
  assert.doesNotMatch(await render(null), /Context usage/);
});
