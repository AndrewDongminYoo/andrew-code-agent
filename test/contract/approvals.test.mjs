import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough, Readable, Writable } from "node:stream";
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

function input(line, tty = true) {
  const stream = Readable.from(line === null ? [] : Array.isArray(line) ? line : [line]);
  Object.defineProperty(stream, "isTTY", { value: tty });
  return stream;
}

function output({ tty = true, fail = false } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      if (fail) callback(new Error("write failed"));
      else {
        chunks.push(chunk.toString());
        callback();
      }
    },
  });
  Object.defineProperty(stream, "isTTY", { value: tty });
  return { stream, text: () => chunks.join("") };
}

test("renders bounded command context and maps opaque decisions to exact responses", async () => {
  const [command] = await requests();
  const sink = output();
  const accepted = await approvals().answerApproval(command, input("1\n"), sink.stream, 100);
  assert.deepEqual(accepted.response, { decision: "accept" });
  assert.equal(accepted.acceptedForSession, false);
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

test("renders complete bounded approval context and waits for a newline-delimited selection", async () => {
  const [command, , permission] = await requests();
  command.params.commandActions = [{
    type: "read",
    command: "cat /repo/visible.txt",
    name: "visible.txt",
    path: "/repo/visible.txt",
  }];
  command.params.networkApprovalContext = { host: "example.com", protocol: "https" };
  command.params.reason = "🙂".repeat(800);
  const commandSink = output();
  const commandResult = await approvals().answerApproval(command, input("1x\n"), commandSink.stream, 100);
  assert.deepEqual(commandResult.response, { decision: "decline" });
  assert.match(commandSink.text(), /command action: read .*visible\.txt/);
  assert.match(commandSink.text(), /network: https:\/\/example\.com/);
  assert.match(commandSink.text(), /Accept|Decline|Cancel/);
  assert.ok(Buffer.byteLength(commandSink.text(), "utf8") <= 2048);

  const permissionSink = output();
  await approvals().answerApproval(permission, input("3\n"), permissionSink.stream, 100);
  assert.match(permissionSink.text(), /network: enabled/);
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

test("preserves every available choice after bounding context and validates generated MCP and filesystem nesting", async () => {
  const [command, , permission, mcp] = await requests();
  command.params.command = "command ".repeat(1000);
  command.params.cwd = "/repo/" + "path/".repeat(1000);
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
