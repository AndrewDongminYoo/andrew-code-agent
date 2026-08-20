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
  const stream = Readable.from(line === null ? [] : [line]);
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
