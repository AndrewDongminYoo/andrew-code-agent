import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

const approvalsModule = await import("../../dist/app-server/approvals.js").catch(() => null);

function approvals() {
  assert.notEqual(approvalsModule, null, "the built approvals module must be available");
  return approvalsModule;
}

async function requests() {
  return (await readFile("test/fixtures/protocol/approval-requests.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// Captured from the pinned binary rather than written from the generated
// types, which are known to omit fields the binary sends. See
// docs/notes/2026-09-03-approval-frame-capture.md.
async function observed() {
  return (await readFile("test/fixtures/protocol/approval-requests.observed.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function input(line, tty = true) {
  const stream = Readable.from(line === null ? [] : Array.isArray(line) ? line : [line]);
  Object.defineProperty(stream, "isTTY", { value: tty });
  return stream;
}

function output({ tty = true, fail = false } = {}) {
  const chunks = [];
  let calls = 0;
  const stream = {
    async writePrompt(value, signal) {
      calls += 1;
      if (!tty) throw new Error("output is not a TTY");
      if (fail) throw new Error("write failed");
      if (signal.aborted) throw signal.reason;
      chunks.push(value);
    },
  };
  return { stream, text: () => chunks.join(""), calls: () => calls };
}

test("renders bounded command context and maps opaque decisions to exact responses", async () => {
  const [command] = await requests();
  const sink = output();
  const accepted = await approvals().answerApproval(command, input("1\n"), sink.stream, 100);
  assert.deepEqual(accepted.response, { decision: "accept" });
  assert.equal(accepted.acceptedForSession, false);
  assert.equal(sink.calls(), 1);
  assert.match(sink.text(), /thread-1|turn-1|command-1|curl https:\/\/example.com|\/repo|Needs network/);
  const session = await approvals().answerApproval(command, input("2\n"), output().stream, 100);
  assert.deepEqual(session.response, { decision: "acceptForSession" });
  assert.equal(session.acceptedForSession, true);
  const amendment = await approvals().answerApproval(command, input("4\n"), output().stream, 100);
  assert.deepEqual(amendment.response, { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } } });
  assert.doesNotMatch(JSON.stringify(amendment), /execpolicy/i);
});

test("maps file and permission choices without granting absent permissions", async () => {
  const [, file, permission] = await requests();
  const fileSession = await approvals().answerApproval(file, input("2\n"), output().stream, 100);
  assert.deepEqual(fileSession.response, { decision: "acceptForSession" });
  const fileCancel = await approvals().answerApproval(file, input("4\n"), output().stream, 100);
  assert.deepEqual(fileCancel.response, { decision: "cancel" });
  const turn = await approvals().answerApproval(permission, input("1\n"), output().stream, 100);
  assert.deepEqual(turn.response, { permissions: permission.params.permissions, scope: "turn" });
  const session = await approvals().answerApproval(permission, input("2\n"), output().stream, 100);
  assert.deepEqual(session.response, { permissions: permission.params.permissions, scope: "session" });
  assert.equal(session.acceptedForSession, true);
  const decline = await approvals().answerApproval(permission, input("3\n"), output().stream, 100);
  assert.deepEqual(decline.response, { permissions: {}, scope: "turn" });
});

test("declines and cancels MCP forms without inventing structured content", async () => {
  const [, , , mcp] = await requests();
  const sink = output();
  const decline = await approvals().answerApproval(mcp, input("1\n"), sink.stream, 100);
  assert.deepEqual(decline.response, { action: "decline", content: null, _meta: null });
  assert.match(sink.text(), /fixture-server|form|Choose a setting/);
  const cancel = await approvals().answerApproval(mcp, input("2\n"), output().stream, 100);
  assert.deepEqual(cancel.response, { action: "cancel", content: null, _meta: null });
});

test("fails closed or safely declines for noninteractive and malformed input paths", async () => {
  const [command] = await requests();
  const nonTty = await approvals().answerApproval(command, input("1\n", false), output().stream, 100);
  assert.deepEqual(nonTty.response, { decision: "decline" });
  const eof = await approvals().answerApproval(command, input(null), output().stream, 100);
  assert.deepEqual(eof.response, { decision: "decline" });
  const pending = new PassThrough();
  Object.defineProperty(pending, "isTTY", { value: true });
  const timeout = await approvals().answerApproval(command, pending, output().stream, 5);
  assert.deepEqual(timeout.response, { decision: "decline" });
  pending.destroy();
  const invalid = await approvals().answerApproval(command, input("99\n"), output().stream, 100);
  assert.deepEqual(invalid.response, { decision: "decline" });
  const writeFailure = await approvals().answerApproval(command, input("1\n"), output({ fail: true }).stream, 100);
  assert.deepEqual(writeFailure.response, { decision: "decline" });
  const malformed = await approvals().answerApproval({ method: command.method, id: "x", params: { threadId: "thread-1" } }, input("1\n"), output().stream, 100);
  assert.equal(malformed.kind, "failClosed");
  assert.equal(malformed.code, "MALFORMED_APPROVAL_REQUEST");
  const incomplete = structuredClone(command);
  delete incomplete.params.startedAtMs;
  const incompleteResult = await approvals().answerApproval(incomplete, input("1\n"), output().stream, 100);
  assert.equal(incompleteResult.kind, "failClosed");
  assert.equal(incompleteResult.code, "MALFORMED_APPROVAL_REQUEST");
  const unsupported = await approvals().answerApproval({ method: "item/tool/requestUserInput", id: "x", params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool-1" } }, input("1\n"), output().stream, 100);
  assert.equal(unsupported.kind, "failClosed");
  assert.equal(unsupported.code, "UNKNOWN_SERVER_REQUEST");
});

test("declines when input loses TTY authority after the prompt is written", async () => {
  const [command] = await requests();
  const source = new PassThrough();
  Object.defineProperty(source, "isTTY", { value: true, writable: true });
  const writer = {
    async writePrompt() {
      source.isTTY = false;
      source.write("1\n");
    },
  };

  const result = await approvals().answerApproval(command, source, writer, 100);

  assert.deepEqual(result.response, { decision: "decline" });
  source.destroy();
});

test("aborts a stalled writer and settles when the writer ignores abort", async () => {
  const [command] = await requests();
  let writerSignal = null;
  const writer = {
    writePrompt(_value, signal) {
      writerSignal = signal;
      return new Promise(() => {});
    },
  };

  const result = await Promise.race([
    approvals().answerApproval(command, input("1\n"), writer, 10),
    new Promise((resolve) => setTimeout(() => resolve(null), 250)),
  ]);

  assert.notEqual(result, null, "an abort-ignoring writer must not hold the approval open");
  assert.deepEqual(result.response, { decision: "decline" });
  assert.equal(writerSignal?.aborted, true);
});

test("external cancellation declines and releases an open approval input", async () => {
  const [command] = await requests();
  const source = new PassThrough();
  Object.defineProperty(source, "isTTY", { value: true });
  source.pause();
  const controller = new AbortController();
  const operation = approvals().answerApproval(
    command,
    source,
    {
      async writePrompt() {
        controller.abort();
      },
    },
    10_000,
    controller.signal,
  );
  const marker = Symbol("approval remained open");
  let outcome;
  try {
    outcome = await Promise.race([
      operation,
      new Promise((resolve) => setImmediate(() => resolve(marker))),
    ]);
    assert.notEqual(outcome, marker);
    assert.deepEqual(outcome.response, { decision: "decline" });
    assert.equal(source.listenerCount("data"), 0);
    assert.equal(source.listenerCount("end"), 0);
    assert.equal(source.listenerCount("error"), 0);
    assert.equal(source.isPaused(), true);
  } finally {
    source.end();
    await operation;
  }
});

test("absorbs a writer rejection that arrives after the timeout", async () => {
  const [command] = await requests();
  let unhandled = null;
  let calls = 0;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.once("unhandledRejection", onUnhandled);
  const writer = {
    writePrompt() {
      calls += 1;
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("late writer failure")), 40);
      });
    },
  };

  try {
    const result = await approvals().answerApproval(command, input("1\n"), writer, 5);
    assert.deepEqual(result.response, { decision: "decline" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls, 1);
    assert.equal(unhandled, null);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("fails safely for writer rejection and non-TTY input", async () => {
  const [command] = await requests();
  let calls = 0;
  const writer = {
    async writePrompt() {
      calls += 1;
      throw new Error("output is not a TTY");
    },
  };

  const rejected = await approvals().answerApproval(command, input("1\n"), writer, 100);
  const nonTty = await approvals().answerApproval(command, input("1\n", false), writer, 100);

  assert.deepEqual(rejected.response, { decision: "decline" });
  assert.deepEqual(nonTty.response, { decision: "decline" });
  assert.equal(calls, 1);
});

test("uses only the writer capability and never stream lifecycle methods", async () => {
  const [command] = await requests();
  let forbiddenAccesses = 0;
  const writer = {
    async writePrompt() {},
  };
  for (const key of ["write", "once", "removeListener", "destroy", "isTTY"]) {
    Object.defineProperty(writer, key, {
      get() {
        forbiddenAccesses += 1;
        throw new Error(`answerApproval accessed ${key}`);
      },
    });
  }

  const result = await approvals().answerApproval(command, input("1\n"), writer, 100);

  assert.deepEqual(result.response, { decision: "accept" });
  assert.equal(forbiddenAccesses, 0);
});

test("rejects extra generated-request keys and grants a fresh non-null permission subset", async () => {
  const [, file, permission, mcp] = await requests();
  const command = (await requests())[0];
  for (const request of [command, file, permission, mcp]) {
    const malformed = structuredClone(request);
    malformed.params.unexpected = true;
    const result = await approvals().answerApproval(malformed, input("1\n"), output().stream, 100);
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
  }
  const malformedExecpolicy = structuredClone(command);
  malformedExecpolicy.params.proposedExecpolicyAmendment = { command: "unsafe" };
  const malformedExecpolicyResult = await approvals().answerApproval(
    malformedExecpolicy,
    input("1\n"),
    output().stream,
    100,
  );
  assert.equal(malformedExecpolicyResult.kind, "failClosed");

  const granted = await approvals().answerApproval(permission, input("1\n"), output().stream, 100);
  assert.deepEqual(granted.response, {
    permissions: {
      network: { enabled: true },
      fileSystem: { read: ["/repo"], write: ["/repo"], entries: [] },
    },
    scope: "turn",
  });
  assert.notStrictEqual(granted.response.permissions, permission.params.permissions);
  assert.equal("network" in granted.response.permissions, true);
  assert.equal("fileSystem" in granted.response.permissions, true);

  const noPermissions = structuredClone(permission);
  noPermissions.params.permissions = { network: null, fileSystem: null };
  const normalized = await approvals().answerApproval(noPermissions, input("1\n"), output().stream, 100);
  assert.deepEqual(normalized.response, { permissions: {}, scope: "turn" });

  const injected = structuredClone(permission);
  injected.params.permissions.shell = { enabled: true };
  const injectedResult = await approvals().answerApproval(injected, input("1\n"), output().stream, 100);
  assert.equal(injectedResult.kind, "failClosed");
});

// codex-cli 0.148.0 sends availableDecisions on a command approval request and
// the generated params type does not declare it, measured 2026-08-26 against a
// real run. The server accepted a decision that field did not advertise, so the
// key is allowed and the decision vocabulary is unchanged.
test("accepts the command approval field the pinned binary sends beyond its generated type", async () => {
  const [command] = await requests();
  const advertised = structuredClone(command);
  advertised.params.availableDecisions = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["flutter", "test"] } }, "cancel"];

  const prompted = await approvals().answerApproval(advertised, input("1\n"), output().stream, 100);
  assert.equal(prompted.kind, "response");
  assert.deepEqual(prompted.response, { decision: "accept" });

  const noninteractive = await approvals().answerApproval(advertised, input("1\n", false), output().stream, 100);
  assert.equal(noninteractive.kind, "response");
  assert.deepEqual(noninteractive.response, { decision: "decline" }, "the safest answer stays decline against an advertised set that omits it");
});

test("renders complete bounded approval context and waits for a newline-delimited selection", async () => {
  const [command, , permission] = await requests();
  command.params.commandActions = [{
    type: "read",
    command: "cat /repo/visible.txt",
    name: "visible.txt",
    path: "/repo/visible.txt",
  }];
  command.params.networkApprovalContext = { host: "example.com", protocol: "https" };
  command.params.reason = "Needs a visible file and network access";
  const commandSink = output();
  const commandResult = await approvals().answerApproval(command, input("1x\n"), commandSink.stream, 100);
  assert.deepEqual(commandResult.response, { decision: "decline" });
  assert.match(commandSink.text(), /command action: read .*visible\.txt/);
  assert.match(commandSink.text(), /network: https:\/\/example\.com/);
  assert.match(commandSink.text(), /Accept|Decline|Cancel/);
  assert.ok(Buffer.byteLength(commandSink.text(), "utf8") <= 2048);

  const permissionSink = output();
  await approvals().answerApproval(permission, input("3\n"), permissionSink.stream, 100);
  assert.match(permissionSink.text(), /network: enabled true/);
  assert.match(permissionSink.text(), /fileSystem: read \/repo; write \/repo/);
  assert.match(permissionSink.text(), /scope: turn|scope: session/);

  const splitInvalid = await approvals().answerApproval((await requests())[0], input(["1", "x\n"]), output().stream, 100);
  assert.deepEqual(splitInvalid.response, { decision: "decline" });
  const unterminated = await approvals().answerApproval((await requests())[0], input("1"), output().stream, 100);
  assert.deepEqual(unterminated.response, { decision: "decline" });

  const [, , , mcp] = await requests();
  const invalidMode = structuredClone(mcp);
  invalidMode.params.mode = "unknown";
  const invalidModeResult = await approvals().answerApproval(invalidMode, input("1\n"), output().stream, 100);
  assert.equal(invalidModeResult.kind, "failClosed");
  const incompleteMcp = structuredClone(mcp);
  delete incompleteMcp.params.requestedSchema;
  const incompleteMcpResult = await approvals().answerApproval(incompleteMcp, input("1\n"), output().stream, 100);
  assert.equal(incompleteMcpResult.kind, "failClosed");
});

test("shows every generated command, network amendment, and filesystem entry decision field", async () => {
  const [command, , permission] = await requests();
  command.params.commandActions = [
    { type: "read", command: "cat /repo/read.txt", name: "read.txt", path: "/repo/read.txt" },
    { type: "listFiles", command: "find /repo", path: "/repo" },
    { type: "search", command: "rg needle /repo", query: "needle", path: "/repo" },
    { type: "unknown", command: "custom --effect" },
  ];
  command.params.proposedNetworkPolicyAmendments = [
    { host: "allow.example.com", action: "allow" },
    { host: "deny.example.com", action: "deny" },
  ];
  const commandSink = output();
  await approvals().answerApproval(command, input("1\n"), commandSink.stream, 100);
  for (const effect of ["read", "cat /repo/read.txt", "read.txt", "/repo/read.txt", "listFiles", "find /repo", "search", "rg needle /repo", "needle", "unknown", "custom --effect", "allow.example.com", "allow", "deny.example.com", "deny"]) {
    assert.ok(commandSink.text().includes(effect), effect);
  }

  permission.params.permissions.fileSystem.entries = [
    { path: { type: "path", path: "/repo/allowed" }, access: "read" },
    { path: { type: "glob_pattern", pattern: "/repo/blocked/**" }, access: "deny" },
  ];
  const permissionSink = output();
  await approvals().answerApproval(permission, input("3\n"), permissionSink.stream, 100);
  assert.match(permissionSink.text(), /fileSystem entry: read .*\/repo\/allowed/);
  assert.match(permissionSink.text(), /fileSystem entry: deny .*\/repo\/blocked\/\*\*/);
});

test("visibly escapes terminal controls before approval prompt bounds", async () => {
  const [, , fixturePermission] = await requests();
  const permission = structuredClone(fixturePermission);
  permission.params.permissions.fileSystem.read = [
    "/\u001b]0;owned\u0007safe",
  ];
  permission.params.permissions.fileSystem.write = [
    "/repo\n3. Grant all\r",
  ];
  permission.params.permissions.fileSystem.entries = [
    {
      path: { type: "path", path: "/repo/\u202etxt.exe" },
      access: "read",
    },
  ];
  const sink = output();

  const accepted = await approvals().answerApproval(
    permission,
    input("1\n"),
    sink.stream,
    100,
  );

  assert.deepEqual(accepted.response, {
    permissions: permission.params.permissions,
    scope: "turn",
  });
  assert.match(sink.text(), /\\x1B\]0;owned\\x07safe/);
  assert.match(sink.text(), /\/repo\\x0A3\. Grant all\\x0D/);
  assert.match(sink.text(), /\/repo\/\\u\{202E\}txt\.exe/);
  assert.doesNotMatch(sink.text(), /[\u0007\u000d\u001b\u202e]/u);

  const expanded = structuredClone(fixturePermission);
  expanded.params.permissions.fileSystem.read = ["\u0007".repeat(70)];
  const expandedSink = output();
  const declined = await approvals().answerApproval(
    expanded,
    input("1\n"),
    expandedSink.stream,
    100,
  );
  assert.deepEqual(declined.response, { permissions: {}, scope: "turn" });
  assert.equal(expandedSink.calls(), 0);
});

test("preserves every available choice after bounding context and validates generated MCP and filesystem nesting", async () => {
  const [command, , permission, mcp] = await requests();
  command.params.command = "command --safe";
  command.params.cwd = "/repo";
  command.params.proposedNetworkPolicyAmendments = Array.from(
    { length: 8 },
    (_, index) => ({ host: `host-${index}.example.com`, action: "allow" }),
  );
  const commandSink = output();
  const cancelled = await approvals().answerApproval(
    command,
    input("12\n"),
    commandSink.stream,
    100,
  );
  assert.deepEqual(cancelled.response, { decision: "cancel" });
  assert.match(commandSink.text(), /1\. Accept/);
  assert.match(commandSink.text(), /12\. Cancel/);
  assert.ok(Buffer.byteLength(commandSink.text(), "utf8") <= 2048);

  const missingMeta = structuredClone(mcp);
  delete missingMeta.params._meta;
  const missingMetaResult = await approvals().answerApproval(
    missingMeta,
    input("1\n"),
    output().stream,
    100,
  );
  assert.equal(missingMetaResult.kind, "failClosed");

  const entryPermission = structuredClone(permission);
  entryPermission.params.permissions.fileSystem.entries = [{
    path: { type: "path", path: "/repo/entry" },
    access: "read",
  }];
  entryPermission.params.permissions.fileSystem.globScanMaxDepth = 1;
  const entrySink = output();
  await approvals().answerApproval(entryPermission, input("3\n"), entrySink.stream, 100);
  assert.match(entrySink.text(), /\/repo\/entry/);
  const malformedEntry = structuredClone(entryPermission);
  malformedEntry.params.permissions.fileSystem.entries[0].path.extra = true;
  const malformedEntryResult = await approvals().answerApproval(malformedEntry, input("1\n"), output().stream, 100);
  assert.equal(malformedEntryResult.kind, "failClosed");
  const invalidDepth = structuredClone(entryPermission);
  invalidDepth.params.permissions.fileSystem.globScanMaxDepth = 0;
  const invalidDepthResult = await approvals().answerApproval(invalidDepth, input("1\n"), output().stream, 100);
  assert.equal(invalidDepthResult.kind, "failClosed");
});

test("declines before prompting when any displayed approval context or policy choice would be truncated", async () => {
  const [fixtureCommand, fixtureFile, fixturePermission, fixtureMcp] =
    await requests();
  const cases = [];
  const parsedCommand = JSON.parse(JSON.stringify(fixtureCommand));
  parsedCommand.params.command = "x".repeat(5000);
  cases.push(parsedCommand);
  const longRequestId = structuredClone(fixtureCommand);
  longRequestId.id = "request-".repeat(100);
  cases.push(longRequestId);
  for (const [fixture, key] of [
    [fixtureCommand, "threadId"],
    [fixtureCommand, "turnId"],
    [fixtureCommand, "itemId"],
    [fixtureCommand, "cwd"],
    [fixtureCommand, "reason"],
    [fixtureFile, "grantRoot"],
    [fixtureMcp, "message"],
    [fixtureMcp, "serverName"],
  ]) {
    const request = structuredClone(fixture);
    request.params[key] = "🙂".repeat(100);
    cases.push(request);
  }
  const permission = structuredClone(fixturePermission);
  permission.params.permissions.fileSystem.read = ["🙂".repeat(100)];
  cases.push(permission);
  const entryPermission = structuredClone(fixturePermission);
  entryPermission.params.permissions.fileSystem.entries = [
    {
      path: { type: "path", path: "🙂".repeat(100) },
      access: "read",
    },
  ];
  cases.push(entryPermission);
  const action = structuredClone(fixtureCommand);
  action.params.commandActions = [
    {
      type: "read",
      command: "cat file",
      name: "file",
      path: "🙂".repeat(100),
    },
  ];
  cases.push(action);
  for (const [type, key] of [
    ["read", "command"],
    ["read", "name"],
    ["search", "query"],
    ["search", "command"],
  ]) {
    const generatedAction = structuredClone(fixtureCommand);
    generatedAction.params.commandActions = [{ type, command: "safe", name: "safe", path: "/repo", query: "safe" }];
    if (type === "search") delete generatedAction.params.commandActions[0].name;
    else delete generatedAction.params.commandActions[0].query;
    generatedAction.params.commandActions[0][key] = "🙂".repeat(100);
    cases.push(generatedAction);
  }
  const network = structuredClone(fixtureCommand);
  network.params.networkApprovalContext = {
    host: "🙂".repeat(100),
    protocol: "https",
  };
  cases.push(network);
  const policy = structuredClone(fixtureCommand);
  policy.params.proposedNetworkPolicyAmendments = [
    { host: "🙂".repeat(100), action: "allow" },
  ];
  cases.push(policy);
  const entryAccess = structuredClone(fixturePermission);
  entryAccess.params.permissions.fileSystem.entries = [{ path: { type: "path", path: "/repo" }, access: "x".repeat(300) }];
  cases.push(entryAccess);

  for (const request of cases) {
    const sink = output();
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      sink.stream,
      100,
    );
    assert.equal(result.decision, "decline");
    assert.equal(sink.text(), "");
  }
});
test("validates the generated regular MCP form schema and rejects legacy openai form without prompting", async () => {
  const [, , , fixtureMcp] = await requests();
  const validSchemas = [
    {
      type: "object",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: true },
      },
      required: ["enabled"],
    },
    {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 3, default: 2 },
      },
    },
    {
      type: "object",
      properties: {
        email: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          format: "email",
          default: "a@example.com",
        },
      },
    },
    {
      type: "object",
      properties: {
        choice: { type: "string", oneOf: [{ const: "a", title: "A" }] },
      },
    },
    {
      type: "object",
      properties: {
        choices: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "string", enum: ["a", "b"] },
          default: ["a"],
        },
      },
    },
    {
      type: "object",
      properties: {
        choices: {
          type: "array",
          items: { anyOf: [{ const: "a", title: "A" }] },
        },
      },
    },
  ];
  for (const requestedSchema of validSchemas) {
    const request = structuredClone(fixtureMcp);
    request.params.requestedSchema = requestedSchema;
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      output().stream,
      100,
    );
    assert.equal(result.kind, "response");
  }

  const malformedSchemas = [
    null,
    {},
    { type: "array", properties: {} },
    { type: "object" },
    {
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
    },
    {
      type: "object",
      properties: { text: { type: "string", format: "password" } },
    },
    {
      type: "object",
      properties: { count: { type: "integer", minimum: "1" } },
    },
    {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: Array.from({ length: 9 }, (_, index) => String(index)),
        },
      },
    },
    {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `p${index}`,
          { type: "boolean" },
        ]),
      ),
    },
  ];
  for (const requestedSchema of malformedSchemas) {
    const request = structuredClone(fixtureMcp);
    request.params.requestedSchema = requestedSchema;
    const sink = output();
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      sink.stream,
      100,
    );
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
    assert.equal(sink.text(), "");
  }

  const legacy = structuredClone(fixtureMcp);
  legacy.params.mode = "openai/form";
  const legacySink = output();
  const legacyResult = await approvals().answerApproval(
    legacy,
    input("1\n"),
    legacySink.stream,
    100,
  );
  assert.equal(legacyResult.kind, "failClosed");
  assert.equal(legacyResult.code, "MALFORMED_APPROVAL_REQUEST");
  assert.equal(legacySink.text(), "");
});

test("fails cyclic and deeply nested direct JSON values safely", async () => {
  const [, , , fixtureMcp] = await requests();
  const cyclic = structuredClone(fixtureMcp);
  cyclic.params._meta = {};
  cyclic.params._meta.self = cyclic.params._meta;
  const deep = structuredClone(fixtureMcp);
  deep.params._meta = {};
  let cursor = deep.params._meta;
  for (let index = 0; index < 1000; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  for (const request of [cyclic, deep]) {
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      output().stream,
      100,
    );
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
  }
});

test("requires safe integer timestamps and direct JSON without holes or non-plain objects", async () => {
  const [command, file, permission, fixtureMcp] = await requests();
  for (const fixture of [command, file, permission]) {
    const request = structuredClone(fixture);
    request.params.startedAtMs = 1.5;
    const result = await approvals().answerApproval(request, input("1\n"), output().stream, 100);
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
  }
  const sparse = structuredClone(fixtureMcp);
  sparse.params._meta = new Array(1);
  const disguisedSparse = structuredClone(fixtureMcp);
  disguisedSparse.params._meta = new Array(1);
  disguisedSparse.params._meta.extra = true;
  const dated = structuredClone(fixtureMcp);
  dated.params._meta = new Date(0);
  for (const request of [sparse, disguisedSparse, dated]) {
    const result = await approvals().answerApproval(request, input("1\n"), output().stream, 100);
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
  }
});

test("restores an initially paused input across sequential approvals without leaking listeners", async () => {
  const [command] = await requests();
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: true });
  stream.pause();
  stream.write("1\n2\n");
  const first = await approvals().answerApproval(command, stream, output().stream, 100);
  assert.deepEqual(first.response, { decision: "accept" });
  assert.equal(stream.isPaused(), true);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  const second = await approvals().answerApproval(command, stream, output().stream, 100);
  assert.deepEqual(second.response, { decision: "acceptForSession" });
  assert.equal(stream.isPaused(), true);
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("error"), 0);
  stream.destroy();
});

test("rejects an oversized interactive chunk before concatenating it", async () => {
  const [command] = await requests();
  const oversizedInput = input(new Uint8Array(65));
  const sink = output().stream;
  const originalFrom = Buffer.from;
  const originalConcat = Buffer.concat;
  let fromCalls = 0;
  let concatCalls = 0;
  Buffer.from = function (...args) {
    fromCalls += 1;
    return originalFrom.apply(this, args);
  };
  Buffer.concat = function (...args) {
    concatCalls += 1;
    return originalConcat.apply(this, args);
  };
  try {
    const result = await approvals().answerApproval(
      command,
      oversizedInput,
      sink,
      100,
    );
    assert.equal(result.decision, "decline");
    assert.equal(fromCalls, 0);
    assert.equal(concatCalls, 0);
  } finally {
    Buffer.from = originalFrom;
    Buffer.concat = originalConcat;
  }
});

test("declines object-mode input chunks without coercing them", async () => {
  const [command] = await requests();
  let converted = false;
  const stream = Readable.from([
    {
      toString() {
        converted = true;
        return "1\n";
      },
    },
  ]);
  Object.defineProperty(stream, "isTTY", { value: true });
  const result = await approvals().answerApproval(command, stream, output().stream, 100);
  assert.deepEqual(result.response, { decision: "decline" });
  assert.equal(converted, false);
});

test("declines without prompting when a complete approval context exceeds its list caps", async () => {
  const [command, , permission] = await requests();
  command.params.proposedNetworkPolicyAmendments = Array.from(
    { length: 9 },
    (_, index) => ({ host: `host-${index}.example.com`, action: "allow" }),
  );
  const commandSink = output();
  const commandResult = await approvals().answerApproval(
    command,
    input("1\n"),
    commandSink.stream,
    100,
  );
  assert.deepEqual(commandResult.response, { decision: "decline" });
  assert.equal(commandSink.text(), "");

  for (const permissions of [
    {
      network: null,
      fileSystem: {
        read: Array.from({ length: 9 }, (_, index) => `/repo/read-${index}`),
        write: [],
        entries: [],
      },
    },
    {
      network: null,
      fileSystem: {
        read: [],
        write: [],
        entries: Array.from({ length: 9 }, (_, index) => ({
          path: { type: "path", path: `/repo/entry-${index}` },
          access: "read",
        })),
      },
    },
  ]) {
    const request = structuredClone(permission);
    request.params.permissions = permissions;
    const sink = output();
    const result = await approvals().answerApproval(request, input("1\n"), sink.stream, 100);
    assert.deepEqual(result.response, { permissions: {}, scope: "turn" });
    assert.equal(sink.text(), "");
  }
});

test("renders every granted permission effect, including nullable network and special path components", async () => {
  const [, , fixturePermission] = await requests();
  const complete = structuredClone(fixturePermission);
  complete.params.permissions = {
    network: { enabled: false },
    fileSystem: {
      read: ["/repo/read"],
      write: ["/repo/write"],
      globScanMaxDepth: 3,
      entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "read" },
        { path: { type: "special", value: { kind: "minimal" } }, access: "write" },
        { path: { type: "special", value: { kind: "project_roots", subpath: "/project" } }, access: "deny" },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "read" },
        { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        { path: { type: "special", value: { kind: "unknown", path: "/unknown", subpath: "/nested" } }, access: "deny" },
      ],
    },
  };
  const completeSink = output();
  const completeResult = await approvals().answerApproval(complete, input("1\n"), completeSink.stream, 100);
  assert.deepEqual(completeResult.response, {
    permissions: complete.params.permissions,
    scope: "turn",
  });
  for (const effect of [
    "network: enabled false",
    "read /repo/read",
    "write /repo/write",
    "globScanMaxDepth: 3",
    "access=read; type=special; kind=root",
    "access=write; type=special; kind=minimal",
    "access=deny; type=special; kind=project_roots; subpath=/project",
    "access=read; type=special; kind=tmpdir",
    "access=write; type=special; kind=slash_tmp",
    "access=deny; type=special; kind=unknown; path=/unknown; subpath=/nested",
  ]) assert.ok(completeSink.text().includes(effect), effect);

  const nullable = structuredClone(fixturePermission);
  nullable.params.permissions = {
    network: { enabled: null },
    fileSystem: {
      read: null,
      write: null,
      entries: [
        { path: { type: "special", value: { kind: "project_roots", subpath: null } }, access: "read" },
        { path: { type: "special", value: { kind: "unknown", path: "/unknown-null", subpath: null } }, access: "write" },
      ],
    },
  };
  const nullableSink = output();
  const nullableResult = await approvals().answerApproval(nullable, input("1\n"), nullableSink.stream, 100);
  assert.deepEqual(nullableResult.response, {
    permissions: nullable.params.permissions,
    scope: "turn",
  });
  for (const effect of [
    "network: enabled null",
    "read null",
    "write null",
    "access=read; type=special; kind=project_roots; subpath=null",
    "access=write; type=special; kind=unknown; path=/unknown-null; subpath=null",
  ]) assert.ok(nullableSink.text().includes(effect), effect);

  for (const entry of [
    { path: { type: "special", value: { kind: "project_roots", subpath: "🙂".repeat(100) } }, access: "read" },
    { path: { type: "special", value: { kind: "unknown", path: "🙂".repeat(100), subpath: null } }, access: "read" },
    { path: { type: "special", value: { kind: "unknown", path: "/safe", subpath: "🙂".repeat(100) } }, access: "read" },
  ]) {
    const oversized = structuredClone(fixturePermission);
    oversized.params.permissions.fileSystem.entries = [entry];
    const sink = output();
    const result = await approvals().answerApproval(oversized, input("1\n"), sink.stream, 100);
    assert.equal(result.decision, "decline");
    assert.equal(sink.text(), "");
  }
});

test("preserves and renders explicit null filesystem entries and glob depth while leaving omitted fields omitted", async () => {
  const [, , fixturePermission] = await requests();
  const nullable = structuredClone(fixturePermission);
  nullable.params.permissions.fileSystem.entries = null;
  nullable.params.permissions.fileSystem.globScanMaxDepth = null;
  const nullableSink = output();
  const nullableResult = await approvals().answerApproval(
    nullable,
    input("1\n"),
    nullableSink.stream,
    100,
  );
  assert.deepEqual(nullableResult.response, {
    permissions: nullable.params.permissions,
    scope: "turn",
  });
  assert.match(nullableSink.text(), /entries null/);
  assert.match(nullableSink.text(), /globScanMaxDepth null/);

  const omitted = structuredClone(fixturePermission);
  delete omitted.params.permissions.fileSystem.entries;
  delete omitted.params.permissions.fileSystem.globScanMaxDepth;
  const omittedSink = output();
  const omittedResult = await approvals().answerApproval(
    omitted,
    input("1\n"),
    omittedSink.stream,
    100,
  );
  assert.equal("entries" in omittedResult.response.permissions.fileSystem, false);
  assert.equal("globScanMaxDepth" in omittedResult.response.permissions.fileSystem, false);
  assert.doesNotMatch(omittedSink.text(), /entries null|globScanMaxDepth null/);
});

test("accepts every nullable regular MCP form schema field declared by the runtime schema", async () => {
  const [, , , fixtureMcp] = await requests();
  const request = structuredClone(fixtureMcp);
  request.params.requestedSchema = {
    $schema: null,
    type: "object",
    properties: {
      enabled: { type: "boolean", title: null, description: null, default: null },
      count: {
        type: "number",
        title: null,
        description: null,
        minimum: null,
        maximum: null,
        default: null,
      },
      text: {
        type: "string",
        title: null,
        description: null,
        minLength: null,
        maxLength: null,
        format: null,
        default: null,
      },
      legacyChoice: {
        type: "string",
        title: null,
        description: null,
        enum: ["a"],
        enumNames: null,
        default: null,
      },
      titledChoice: {
        type: "string",
        title: null,
        description: null,
        oneOf: [{ const: "a", title: "A" }],
        default: null,
      },
      choices: {
        type: "array",
        title: null,
        description: null,
        minItems: null,
        maxItems: null,
        items: { type: "string", enum: ["a"] },
        default: null,
      },
      titledChoices: {
        type: "array",
        title: null,
        description: null,
        minItems: null,
        maxItems: null,
        items: { anyOf: [{ const: "a", title: "A" }] },
        default: null,
      },
    },
    required: null,
  };
  const result = await approvals().answerApproval(
    request,
    input("1\n"),
    output().stream,
    100,
  );
  assert.equal(result.kind, "response");
});

test("fails closed without invoking getters on the approval envelope or direct params", async () => {
  const [fixtureCommand] = await requests();
  const getterCalls = { method: 0, id: 0, params: 0, threadId: 0 };
  const hostileRequests = ["method", "id", "params"].map((key) => {
    const request = structuredClone(fixtureCommand);
    Object.defineProperty(request, key, {
      enumerable: true,
      get() {
        getterCalls[key] += 1;
        throw new Error(`${key} getter must not run`);
      },
    });
    return request;
  });
  const hostileParams = structuredClone(fixtureCommand);
  Object.defineProperty(hostileParams.params, "threadId", {
    enumerable: true,
    get() {
      getterCalls.threadId += 1;
      throw new Error("threadId getter must not run");
    },
  });
  hostileRequests.push(hostileParams);

  for (const request of hostileRequests) {
    const sink = output();
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      sink.stream,
      100,
    );
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
    assert.deepEqual(result.audit, {
      requestId: "<invalid>",
      threadId: null,
      turnId: null,
      itemId: null,
      method: "<invalid>",
      decision: "decline",
    });
    assert.equal(sink.text(), "");
  }
  assert.deepEqual(getterCalls, { method: 0, id: 0, params: 0, threadId: 0 });
});

test("returns immutable exact correlation from the post-validation request", async () => {
  const [fixtureCommand] = await requests();
  const longThreadId = `thread-${"t".repeat(300)}`;
  const longTurnId = `turn-${"u".repeat(300)}`;
  const request = structuredClone(fixtureCommand);
  request.params.threadId = longThreadId;
  request.params.turnId = longTurnId;

  const result = await approvals().answerApproval(
    request,
    input("1\n"),
    output().stream,
    100,
  );

  assert.equal(result.kind, "response");
  assert.deepEqual(result.correlation, {
    method: "item/commandExecution/requestApproval",
    threadId: longThreadId,
    turnId: longTurnId,
  });
  assert.equal(Object.isFrozen(result.correlation), true);
  assert.ok(Buffer.byteLength(result.audit.threadId, "utf8") <= 256);
  assert.ok(Buffer.byteLength(result.audit.turnId, "utf8") <= 256);
  assert.notEqual(result.audit.threadId, longThreadId);
  assert.notEqual(result.audit.turnId, longTurnId);
  request.params.threadId = "changed-after-validation";
  request.params.turnId = "changed-after-validation";
  assert.equal(result.correlation.threadId, longThreadId);
  assert.equal(result.correlation.turnId, longTurnId);
});

test("fails closed for every nested Proxy without invoking its traps", async () => {
  const [, , , fixtureMcp] = await requests();
  let trapCalls = 0;
  const handler = {
    getPrototypeOf() {
      trapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      trapCalls += 1;
      return [];
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      return undefined;
    },
  };
  const liveProxy = new Proxy({}, handler);
  const revocable = Proxy.revocable({}, handler);
  revocable.revoke();

  for (const nestedProxy of [liveProxy, revocable.proxy]) {
    const request = structuredClone(fixtureMcp);
    request.params._meta = { nestedProxy };
    const sink = output();
    const result = await approvals().answerApproval(
      request,
      input("1\n"),
      sink.stream,
      100,
    );

    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
    assert.equal(sink.text(), "");
  }
  assert.equal(trapCalls, 0);
});

test("fails closed without evaluating hostile direct JSON properties", async () => {
  const [, , , fixtureMcp] = await requests();
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "trap", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
  });
  class JsonArray extends Array {}
  const arraySubclass = new JsonArray("safe");
  const arrayWithExtra = ["safe"];
  Object.defineProperty(arrayWithExtra, "hidden", { value: "no", enumerable: false });
  const arrayWithEnumerableExtra = ["safe"];
  arrayWithEnumerableExtra.extra = "no";
  const setterOnly = {};
  Object.defineProperty(setterOnly, "trap", {
    enumerable: true,
    set() {
      getterCalls += 1;
    },
  });
  const symbolKey = { safe: true };
  symbolKey[Symbol("hidden")] = "no";
  const cyclic = {};
  cyclic.self = cyclic;
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 33; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  for (const meta of [
    accessor,
    arraySubclass,
    arrayWithExtra,
    arrayWithEnumerableExtra,
    symbolKey,
    setterOnly,
    new Array(1),
    new Date(0),
    cyclic,
    deep,
  ]) {
    const request = structuredClone(fixtureMcp);
    request.params._meta = meta;
    const sink = output();
    const result = await approvals().answerApproval(request, input("1\n"), sink.stream, 100);
    assert.equal(result.kind, "failClosed");
    assert.equal(result.code, "MALFORMED_APPROVAL_REQUEST");
    assert.equal(sink.text(), "");
  }
  assert.equal(getterCalls, 0);

  const nullPrototype = Object.create(null);
  nullPrototype.safe = true;
  const accepted = structuredClone(fixtureMcp);
  accepted.params._meta = nullPrototype;
  const acceptedResult = await approvals().answerApproval(
    accepted,
    input("1\n"),
    output().stream,
    100,
  );
  assert.equal(acceptedResult.kind, "response");
});

// codex-cli 0.152.1 adds a required `kind` to the command approval params,
// distinguishing a command from input written to an already-running terminal.
// The validator's key allowlist did not carry it, so every command approval
// the newly pinned server sends would have been classified malformed and
// auto-declined — the fail-closed path, reached on well-formed traffic.
test("accepts the approval kind the newly pinned binary sends, and names it in the prompt", async () => {
  const [command] = await requests();

  for (const kind of ["command", "writeStdin"]) {
    const request = structuredClone(command);
    request.params.kind = kind;
    const out = output();
    const result = await approvals().answerApproval(request, input("1\n"), out.stream, 100);
    assert.equal(result.kind, "response", kind);
    assert.deepEqual(result.response, { decision: "accept" }, kind);
    // The human gate is the safety mechanism, so it has to say which of the
    // two the operator is approving.
    assert.match(out.text(), new RegExp(`kind: ${kind}`), kind);
  }

  // An unrecognised kind is a shape this build does not understand, and the
  // posture for that is refusal rather than a guess.
  const unknown = structuredClone(command);
  unknown.params.kind = "somethingElse";
  assert.equal((await approvals().answerApproval(unknown, input("1\n"), output().stream, 100)).kind, "failClosed");

  // Absent stays valid: the field's own documentation says older servers
  // default it to `command`, and the allowlist is a subset check.
  const absent = structuredClone(command);
  delete absent.params.kind;
  assert.equal((await approvals().answerApproval(absent, input("1\n"), output().stream, 100)).kind, "response");
});

// The hand-written frames were written at 0.148.0 and never refreshed when the
// pin moved, which is why the deterministic layer saw nothing when 0.152.1
// began sending `kind`. This case answers a frame the pinned binary actually
// sent; docs/notes/2026-09-03-approval-frame-capture.md records the capture.
test("answers a command approval captured from the pinned binary", async () => {
  const [command] = await observed();
  const sink = output();
  const accepted = await approvals().answerApproval(command, input("1\n"), sink.stream, 100);
  assert.deepEqual(accepted.response, { decision: "accept" });
  // Three things only the observed frame carries: the request kind, a numeric
  // request id, and a reason in the operator's language, which must survive
  // escaping and per-code-point byte accounting without being mangled.
  assert.match(sink.text(), /^kind: command$/m);
  assert.match(sink.text(), /^Request: 0$/m);
  assert.match(sink.text(), /샌드박스에서 example\.com DNS/);
  // The server proposed an execpolicy amendment and advertised
  // acceptWithExecpolicyAmendment in availableDecisions; `choices()` builds
  // extra options only from proposedNetworkPolicyAmendments, which this frame
  // does not carry, so the operator is offered neither. Pinning the exact four
  // keeps that visible and fixes the numbering any decision assertion needs.
  // Anchored on `Selection: ` so a fifth option cannot be appended past the
  // match: without that tail the regex is a prefix and pins nothing.
  assert.match(
    sink.text(),
    /1\. Accept\n2\. Accept for session\n3\. Decline\n4\. Cancel\nSelection: $/,
  );
});
