import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reducerModule = await import("../../dist/app-server/reducer.js").catch(() => null);

function reducer() {
  assert.notEqual(reducerModule, null, "the built reducer module must be available");
  return reducerModule;
}

async function fixture(name) {
  return (await readFile(`test/fixtures/protocol/${name}`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function stateWith(messages) {
  const api = reducer();
  return messages.reduce(
    (state, message) => api.reduceServerMessage(state, message),
    api.createTurnState("thread-1", "turn-1"),
  );
}

function item(type, id, extra = {}) {
  return { type, id, ...extra };
}

function started(value) {
  return { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, item: value } };
}

function completed(value) {
  return { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 2, item: value } };
}

test("reduces a successful turn to bounded renderer-safe state", async () => {
  const state = stateWith(await fixture("turn-success.jsonl"));
  assert.equal(state.terminalStatus, "completed");
  assert.deepEqual([...state.items.keys()], ["message-1", "command-1", "files-1"]);
  assert.deepEqual(state.observedCommands, [{ command: "git status --short", cwd: "/repo", exitCode: 0 }]);
  assert.equal(state.diff, "diff --git a/a.txt b/a.txt\n+safe");
  assert.deepEqual(state.warnings, ["A bounded warning"]);
  assert.match(JSON.stringify([...state.items.values()]), /Hello/);
  assert.match(JSON.stringify([...state.items.values()]), /neutral command output/);
  assert.match(JSON.stringify([...state.items.values()]), /\[truncated\]/);
  assert.doesNotMatch(JSON.stringify([...state.items.values()]), /unbounded output/);
});

test("keeps interleaved message and plan lifecycles by stable item ID", async () => {
  const state = stateWith(await fixture("interleaved-items.jsonl"));
  assert.deepEqual([...state.items.keys()], ["message-a", "plan-b"]);
  assert.equal(state.items.get("message-a")?.phase, "completed");
  assert.equal(state.items.get("plan-b")?.phase, "completed");
  assert.match(JSON.stringify([...state.items.values()]), /Message A/);
  assert.match(JSON.stringify([...state.items.values()]), /Plan B/);
});

test("rejects invalid event identity and type transitions without mutating state", () => {
  const api = reducer();
  const base = api.createTurnState("thread-1", "turn-1");
  const message = item("agentMessage", "message-1", { text: "", phase: null, memoryCitation: null });
  const active = api.reduceServerMessage(base, started(message));
  for (const malformed of [
    { method: "item/agentMessage/delta", params: { threadId: "thread-2", turnId: "turn-1", itemId: "message-1", delta: "no" } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "missing", delta: "no" } },
    { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "no" } },
  ]) {
    assert.throws(() => api.reduceServerMessage(active, malformed), { code: "INVALID_SERVER_EVENT" });
  }
  assert.deepEqual([...active.items.keys()], ["message-1"]);
});

test("preserves authoritative completion and rejects conflicting terminal data", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  const finished = api.reduceServerMessage(api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), started(message)), completed(message));
  const duplicate = api.reduceServerMessage(finished, completed(message));
  assert.equal(duplicate, finished);
  assert.throws(
    () => api.reduceServerMessage(finished, completed({ ...message, text: "conflict" })),
    { code: "INVALID_SERVER_EVENT" },
  );
  const delayed = api.reduceServerMessage(finished, { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "later" } });
  assert.equal(delayed, finished);
  assert.equal(api.reduceServerMessage(finished, started(message)), finished);
  assert.throws(
    () => api.reduceServerMessage(finished, started(item("plan", "message-1", { text: "wrong type" }))),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("rebuilds terminal inventory, maps failure states, and removes raw reasoning", () => {
  const api = reducer();
  let state = api.createTurnState("thread-1", "turn-1");
  state = api.reduceServerMessage(state, started(item("reasoning", "thought-1", { summary: ["safe"], content: ["raw private reasoning"] })));
  state = api.reduceServerMessage(state, { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "thought-1", delta: "do not expose", summaryIndex: 0 } });
  state = api.reduceServerMessage(state, { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [item("mcpToolCall", "mcp-1", { server: "fixture", tool: "lookup", status: "failed", arguments: { secret: "no" }, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null })], itemsView: "full", status: "failed", error: { message: "failed", codexErrorInfo: null, additionalDetails: null }, startedAt: null, completedAt: null, durationMs: null } } });
  assert.equal(state.terminalStatus, "failed");
  assert.deepEqual([...state.items.keys()], ["mcp-1"]);
  assert.doesNotMatch(JSON.stringify([...state.items.values()]), /raw private reasoning|secret/);
  assert.throws(() => api.reduceServerMessage(state, { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "unknown", error: null, startedAt: null, completedAt: null, durationMs: null } } }), { code: "INVALID_SERVER_EVENT" });
  assert.equal(api.reduceServerMessage(state, { method: "unknown/optional", params: { notice: true } }), state);
  assert.throws(() => api.reduceServerMessage(state, { method: "item/tool/requestUserInput", id: "request-1", params: {} }), { code: "UNKNOWN_SERVER_REQUEST" });
});

test("validates active lifecycle messages and freezes a terminal turn", () => {
  const api = reducer();
  const activeTurn = { id: "turn-1", items: [], itemsView: "full", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null };
  let state = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), { method: "turn/started", params: { threadId: "thread-1", turn: activeTurn } });
  state = api.reduceServerMessage(state, started(item("mcpToolCall", "mcp-1", { server: "fixture", tool: "lookup", status: "inProgress", arguments: {}, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null })));
  const progressed = api.reduceServerMessage(state, { method: "item/mcpToolCall/progress", params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "working" } });
  assert.match(JSON.stringify(progressed.items.get("mcp-1")), /MCP progress updated/);
  assert.doesNotMatch(JSON.stringify(progressed.items.get("mcp-1")), /working/);
  const terminal = api.reduceServerMessage(progressed, { method: "turn/completed", params: { threadId: "thread-1", turn: { ...activeTurn, status: "interrupted" } } });
  assert.equal(api.reduceServerMessage(terminal, { method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "late" } }), terminal);
  assert.equal(api.reduceServerMessage(terminal, started(item("plan", "late", { text: "late" }))), terminal);
  assert.equal(api.reduceServerMessage(terminal, { method: "unknown/optional", params: { threadId: "thread-9", turnId: "turn-9", itemId: "late" } }), terminal);
  assert.throws(() => api.reduceServerMessage(terminal, { method: "turn/started", params: { threadId: "thread-1", turn: { ...activeTurn, id: "other" } } }), { code: "INVALID_SERVER_EVENT" });
});

test("keeps active identifiers exact while bounding only presentation fields", () => {
  const api = reducer();
  assert.throws(
    () => api.createTurnState("t".repeat(600), "turn-1"),
    { code: "INVALID_SERVER_EVENT" },
  );
  assert.throws(
    () => api.createTurnState("thread-1", "u".repeat(600)),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("rejects terminal conflicts, safely projects patch updates, and discards raw known reasoning and MCP progress", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  const completedTurn = {
    id: "turn-1",
    items: [message],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const terminal = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: completedTurn },
  });
  assert.equal(api.reduceServerMessage(terminal, { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } }), terminal);
  assert.throws(
    () => api.reduceServerMessage(terminal, { method: "turn/completed", params: { threadId: "thread-1", turn: { ...completedTurn, items: [item("agentMessage", "message-1", { text: "changed", phase: null, memoryCitation: null })] } } }),
    { code: "INVALID_SERVER_EVENT" },
  );
  assert.throws(
    () => api.reduceServerMessage(terminal, completed(item("agentMessage", "message-1", { text: "changed", phase: null, memoryCitation: null }))),
    { code: "INVALID_SERVER_EVENT" },
  );

  let state = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), started(item("fileChange", "files-1", { changes: [{ path: "before.txt", kind: "update" }], status: "inProgress" })));
  state = api.reduceServerMessage(state, { method: "item/fileChange/patchUpdated", params: { threadId: "thread-1", turnId: "turn-1", itemId: "files-1", changes: [{ path: "after.txt", kind: "add", diff: "raw patch" }] } });
  assert.match(JSON.stringify(state.items.get("files-1")), /after\.txt/);
  assert.doesNotMatch(JSON.stringify(state.items.get("files-1")), /raw patch/);

  state = api.reduceServerMessage(state, started(item("reasoning", "reasoning-1", { summary: [], content: ["raw reasoning"] })));
  state = api.reduceServerMessage(state, { method: "item/reasoning/summaryPartAdded", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", summaryIndex: 0 } });
  assert.throws(
    () => api.reduceServerMessage(state, { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", summaryIndex: "bad", delta: "raw" } }),
    { code: "INVALID_SERVER_EVENT" },
  );
  state = api.reduceServerMessage(state, { method: "item/reasoning/textDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", contentIndex: 0, delta: "raw reasoning delta" } });
  assert.doesNotMatch(JSON.stringify(state.items.get("reasoning-1")), /raw reasoning/);
  assert.throws(
    () => api.reduceServerMessage(state, { method: "item/reasoning/textDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "missing", contentIndex: 0, delta: "raw" } }),
    { code: "INVALID_SERVER_EVENT" },
  );

  state = api.reduceServerMessage(state, started(item("mcpToolCall", "mcp-1", { server: "fixture", tool: "lookup", status: "inProgress", arguments: {}, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null })));
  state = api.reduceServerMessage(state, { method: "item/mcpToolCall/progress", params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "raw mcp progress" } });
  assert.doesNotMatch(JSON.stringify(state.items.get("mcp-1")), /raw mcp progress/);
});

test("marks capped inventories and warnings with visible omission metadata", () => {
  const api = reducer();
  let state = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 65; index += 1) {
    state = api.reduceServerMessage(state, started(item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })));
  }
  for (let index = 0; index < 17; index += 1) {
    state = api.reduceServerMessage(state, { method: "warning", params: { threadId: "thread-1", message: `warning-${index}` } });
  }
  assert.equal(state.omittedItems, 1);
  assert.equal(state.omittedWarnings, 1);

  const fileState = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), completed(item("fileChange", "files-1", {
    changes: Array.from({ length: 65 }, (_, index) => ({ path: `file-${index}`, kind: "update" })),
    status: "completed",
  })));
  assert.equal(fileState.items.get("files-1")?.value.omittedFiles, 1);

  const commands = Array.from({ length: 33 }, (_, index) => item("commandExecution", `command-${index}`, {
    command: `command-${index}`,
    cwd: "/repo",
    exitCode: 0,
    aggregatedOutput: null,
  }));
  const terminal = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", items: commands, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } },
  });
  assert.equal(terminal.omittedCommands, 1);

  let warnings = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 17; index += 1) {
    warnings = api.reduceServerMessage(warnings, { method: "error", params: { threadId: "thread-1", turnId: "turn-1" } });
  }
  assert.equal(warnings.omittedWarnings, 1);
});

test("uses UTF-8 byte bounds for protocol IDs", () => {
  const api = reducer();
  assert.throws(
    () => api.createTurnState("🙂".repeat(100), "turn-1"),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("requires a full terminal inventory and summarizes commands beyond the item projection cap", () => {
  const api = reducer();
  const turn = {
    id: "turn-1",
    items: [],
    itemsView: "summary",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  assert.throws(
    () => api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), { method: "turn/completed", params: { threadId: "thread-1", turn } }),
    { code: "INVALID_SERVER_EVENT" },
  );
  const items = [
    ...Array.from({ length: 64 }, (_, index) => item("agentMessage", `message-${index}`, { text: "message", phase: null, memoryCitation: null })),
    ...Array.from({ length: 33 }, (_, index) => item("commandExecution", `command-${index}`, { command: `command-${index}`, cwd: "/repo", exitCode: 0, aggregatedOutput: null })),
  ];
  const terminal = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), { method: "turn/completed", params: { threadId: "thread-1", turn: { ...turn, items, itemsView: "full" } } });
  assert.equal(terminal.omittedItems, 33);
  assert.equal(terminal.observedCommands.length, 32);
  assert.equal(terminal.omittedCommands, 1);
});
