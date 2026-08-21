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

  state = api.reduceServerMessage(state, completed(item("agentMessage", "message-64", { text: "x", phase: null, memoryCitation: null })));
  assert.equal(state.omittedItems, 1, "one omitted item ID must be counted once across lifecycle events");

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

test("tracks valid lifecycle messages for known omitted IDs and rejects unknown or conflicting IDs", () => {
  const api = reducer();
  let state = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 64; index += 1) {
    state = api.reduceServerMessage(state, started(item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })));
  }
  state = api.reduceServerMessage(state, started(item("plan", "omitted-plan", { text: "initial" })));
  const omitted = state;
  state = api.reduceServerMessage(state, { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "omitted-plan", delta: " later" } });
  assert.notEqual(state, omitted);
  assert.equal(state.omittedItemStates.get("omitted-plan")?.value.text, "initial later");
  const updated = state;
  state = api.reduceServerMessage(state, completed(item("plan", "omitted-plan", { text: "initial later" })));
  assert.notEqual(state, updated);
  assert.equal(state.omittedItemStates.get("omitted-plan")?.phase, "completed");
  assert.equal(state.omittedItems, 1);
  assert.throws(
    () => api.reduceServerMessage(state, { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "unknown-plan", delta: "later" } }),
    { code: "INVALID_SERVER_EVENT" },
  );
  assert.throws(
    () => api.reduceServerMessage(state, completed(item("agentMessage", "omitted-plan", { text: "conflict", phase: null, memoryCitation: null }))),
    { code: "INVALID_SERVER_EVENT" },
  );

  const terminalItems = [
    ...Array.from({ length: 64 }, (_, index) => item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })),
    item("plan", "terminal-omitted-plan", { text: "final" }),
  ];
  const terminal = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: terminalItems, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } } });
  assert.equal(api.reduceServerMessage(terminal, { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "terminal-omitted-plan", delta: "late" } }), terminal);
  assert.equal(api.reduceServerMessage(terminal, completed(item("plan", "terminal-omitted-plan", { text: "final" }))), terminal);
  assert.throws(
    () => api.reduceServerMessage(terminal, completed(item("agentMessage", "terminal-omitted-plan", { text: "conflict", phase: null, memoryCitation: null }))),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("makes the first omitted completion authoritative and rejects later same-type conflicts", () => {
  const api = reducer();
  let state = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 64; index += 1) {
    state = api.reduceServerMessage(state, started(item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })));
  }
  state = api.reduceServerMessage(state, started(item("plan", "omitted-plan", { text: "initial", raw: "do not retain" })));
  state = api.reduceServerMessage(state, { method: "item/plan/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "omitted-plan", delta: " later" } });
  state = api.reduceServerMessage(state, completed(item("plan", "omitted-plan", { text: "initial later", raw: "still do not retain" })));

  assert.deepEqual(state.omittedItemStates.get("omitted-plan"), {
    id: "omitted-plan",
    type: "plan",
    phase: "completed",
    value: { text: "initial later" },
  });
  assert.doesNotMatch(JSON.stringify([...state.omittedItemStates]), /do not retain/);
  const duplicate = api.reduceServerMessage(state, completed(item("plan", "omitted-plan", { text: "initial later" })));
  assert.equal(duplicate, state);
  assert.throws(
    () => api.reduceServerMessage(state, completed(item("plan", "omitted-plan", { text: "changed" }))),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("includes bounded omitted projections in duplicate terminal inventory authority", () => {
  const api = reducer();
  const terminalItems = [
    ...Array.from({ length: 64 }, (_, index) => item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })),
    item("plan", "omitted-plan", { text: "final", raw: "do not retain" }),
  ];
  const completedTurn = { id: "turn-1", items: terminalItems, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null };
  const terminal = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } });

  assert.equal(terminal.omittedItemStates.get("omitted-plan")?.phase, "completed");
  assert.doesNotMatch(JSON.stringify([...terminal.omittedItemStates]), /do not retain/);
  assert.equal(api.reduceServerMessage(terminal, { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } }), terminal);
  assert.throws(
    () => api.reduceServerMessage(terminal, { method: "turn/completed", params: { threadId: "thread-1", turn: { ...completedTurn, items: [...terminalItems.slice(0, -1), item("plan", "omitted-plan", { text: "changed" })] } } }),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("rejects hostile direct server-message data without invoking accessors", () => {
  const api = reducer();
  const state = api.createTurnState("thread-1", "turn-1");
  let getterCalls = 0;
  const accessorAt = (target, key) => Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(`${key} getter must not run`);
    },
  });
  const hostileMethod = accessorAt({}, "method");
  const hostileParams = accessorAt({ method: "warning" }, "params");
  const nestedParams = accessorAt({ threadId: "thread-1" }, "turn");
  const hostileNested = { method: "turn/started", params: nestedParams };
  const symbolMessage = { method: "unknown/optional", params: {} };
  symbolMessage[Symbol("hidden")] = true;
  const cyclicMessage = { method: "unknown/optional", params: {} };
  cyclicMessage.params.self = cyclicMessage.params;
  const datedParams = { method: "unknown/optional", params: new Date(0) };
  const deepMessage = { method: "unknown/optional", params: {} };
  let cursor = deepMessage.params;
  for (let index = 0; index < 33; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }

  for (const message of [hostileMethod, hostileParams, hostileNested, symbolMessage, cyclicMessage, datedParams, deepMessage]) {
    assert.throws(() => api.reduceServerMessage(state, message), { code: "INVALID_SERVER_EVENT" });
  }
  assert.equal(getterCalls, 0);
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

test("fails closed when active omitted-item authority exceeds its deterministic bound", () => {
  const api = reducer();
  let state = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 128; index += 1) {
    state = api.reduceServerMessage(state, started(item("agentMessage", `message-${index}`, { text: "message", phase: null, memoryCitation: null })));
  }
  assert.equal(state.items.size, 64);
  assert.equal(state.omittedItemStates.size, 64);
  assert.throws(
    () => api.reduceServerMessage(state, started(item("agentMessage", "message-overflow", { text: "message", phase: null, memoryCitation: null }))),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("fails closed when terminal omitted-item authority exceeds its deterministic bound", () => {
  const api = reducer();
  const items = Array.from({ length: 129 }, (_, index) => item("agentMessage", `message-${index}`, { text: "message", phase: null, memoryCitation: null }));
  assert.throws(
    () => api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", items, itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null },
      },
    }),
    { code: "INVALID_SERVER_EVENT" },
  );
});

test("rejects inherited root and nested accessors without invoking them", () => {
  const api = reducer();
  const state = api.createTurnState("thread-1", "turn-1");
  let getterCalls = 0;
  const installGetter = (key) => Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error(`inherited ${key} getter invoked`);
    },
  });

  try {
    installGetter("method");
    assert.throws(() => api.reduceServerMessage(state, {}), { code: "INVALID_SERVER_EVENT" });
    delete Object.prototype.method;
    installGetter("turn");
    assert.throws(
      () => api.reduceServerMessage(state, { method: "turn/started", params: { threadId: "thread-1" } }),
      { code: "INVALID_SERVER_EVENT" },
    );
  } finally {
    delete Object.prototype.method;
    delete Object.prototype.turn;
  }
  assert.equal(getterCalls, 0);
});

test("compares active duplicate completions without invoking inherited toJSON", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  let state = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), completed(message));
  let toJsonCalls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      toJsonCalls += 1;
      throw new Error("inherited toJSON must not run");
    },
  });

  try {
    assert.equal(api.reduceServerMessage(state, completed(message)), state);
    assert.throws(
      () => api.reduceServerMessage(state, completed(item("agentMessage", "message-1", { text: "changed", phase: null, memoryCitation: null }))),
      { code: "INVALID_SERVER_EVENT" },
    );
  } finally {
    delete Object.prototype.toJSON;
  }
  assert.equal(toJsonCalls, 0);
});

test("compares terminal duplicate and conflicting inventories without invoking inherited toJSON", () => {
  const api = reducer();
  const completedTurn = {
    id: "turn-1",
    items: [item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null })],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const state = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: completedTurn },
  });
  let toJsonCalls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      toJsonCalls += 1;
      throw new Error("inherited toJSON must not run");
    },
  });

  try {
    assert.equal(
      api.reduceServerMessage(state, { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } }),
      state,
    );
    assert.throws(
      () => api.reduceServerMessage(state, {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { ...completedTurn, items: [item("agentMessage", "message-1", { text: "changed", phase: null, memoryCitation: null })] },
        },
      }),
      { code: "INVALID_SERVER_EVENT" },
    );
  } finally {
    delete Object.prototype.toJSON;
  }
  assert.equal(toJsonCalls, 0);
});

test("rejects prototype property names as terminal statuses", () => {
  const api = reducer();
  for (const statusName of ["toString", "constructor", "__proto__"]) {
    assert.throws(
      () => api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], itemsView: "full", status: statusName, error: null, startedAt: null, completedAt: null, durationMs: null },
        },
      }),
      { code: "INVALID_SERVER_EVENT" },
    );
  }
});

function trackedProxy(target, counter, throwing) {
  return new Proxy(target, {
    getPrototypeOf(value) {
      counter.calls += 1;
      if (throwing) throw new Error("proxy getPrototypeOf trap invoked");
      return Reflect.getPrototypeOf(value);
    },
    ownKeys(value) {
      counter.calls += 1;
      if (throwing) throw new Error("proxy ownKeys trap invoked");
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(value, key) {
      counter.calls += 1;
      if (throwing)
        throw new Error("proxy getOwnPropertyDescriptor trap invoked");
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
}

function withProxiedFileValue(state, nested, throwing, counter) {
  const stored = state.items.get("files-1");
  const value = nested
    ? {
        ...stored.value,
        files: [
          trackedProxy(stored.value.files[0], counter, throwing),
        ],
      }
    : trackedProxy(stored.value, counter, throwing);
  return {
    ...state,
    items: new Map([["files-1", { ...stored, value }]]),
  };
}

test("rejects top-level and nested proxies in active duplicate item values without invoking traps", () => {
  const api = reducer();
  const completedFile = item("fileChange", "files-1", {
    changes: [{ path: "file.txt", kind: "update" }],
    status: "completed",
  });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    completed(completedFile),
  );

  for (const { nested, throwing } of [
    { nested: false, throwing: false },
    { nested: true, throwing: true },
  ]) {
    const counter = { calls: 0 };
    const state = withProxiedFileValue(base, nested, throwing, counter);
    let failure = null;

    try {
      api.reduceServerMessage(state, completed(completedFile));
    } catch (error) {
      failure = error;
    }

    assert.equal(counter.calls, 0);
    assert.equal(failure?.code, "INVALID_SERVER_EVENT");
  }
});

test("rejects top-level and nested proxies in terminal duplicate item values without invoking traps", () => {
  const api = reducer();
  const completedFile = item("fileChange", "files-1", {
    changes: [{ path: "file.txt", kind: "update" }],
    status: "completed",
  });
  const completedTurn = {
    id: "turn-1",
    items: [completedFile],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } },
  );

  for (const { nested, throwing } of [
    { nested: false, throwing: true },
    { nested: true, throwing: false },
  ]) {
    const counter = { calls: 0 };
    const state = withProxiedFileValue(base, nested, throwing, counter);
    let failure = null;

    try {
      api.reduceServerMessage(state, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: completedTurn },
      });
    } catch (error) {
      failure = error;
    }

    assert.equal(counter.calls, 0);
    assert.equal(failure?.code, "INVALID_SERVER_EVENT");
  }
});

function storedItemProxy(target, kind, counter) {
  if (kind === "revoked") {
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    return revocable.proxy;
  }
  return new Proxy(target, {
    get(value, key, receiver) {
      counter.calls += 1;
      if (kind === "throwing") throw new Error("stored item get trap invoked");
      return Reflect.get(value, key, receiver);
    },
    ownKeys(value) {
      counter.calls += 1;
      if (kind === "throwing")
        throw new Error("stored item ownKeys trap invoked");
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(value, key) {
      counter.calls += 1;
      if (kind === "throwing")
        throw new Error("stored item descriptor trap invoked");
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
}

function withStoredItem(state, itemId, stored) {
  return { ...state, items: new Map([[itemId, stored]]) };
}

function assertStoredItemRejected(target, invoke) {
  for (const kind of ["nonthrowing", "throwing", "revoked"]) {
    const counter = { calls: 0 };
    let failure = null;
    try {
      invoke(storedItemProxy(target, kind, counter));
    } catch (error) {
      failure = error;
    }
    assert.equal(counter.calls, 0, kind);
    assert.equal(failure?.name, "ReducerError", kind);
    assert.equal(failure?.code, "INVALID_SERVER_EVENT", kind);
  }
}

test("rejects proxied stored ItemState on active duplicate completion without invoking traps", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    completed(message),
  );
  const stored = base.items.get("message-1");

  assertStoredItemRejected(stored, (proxied) =>
    api.reduceServerMessage(
      withStoredItem(base, "message-1", proxied),
      completed(message),
    ));
});

test("rejects proxied stored ItemState on terminal duplicate completion without invoking traps", () => {
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
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    { method: "turn/completed", params: { threadId: "thread-1", turn: completedTurn } },
  );
  const stored = base.items.get("message-1");

  assertStoredItemRejected(stored, (proxied) =>
    api.reduceServerMessage(withStoredItem(base, "message-1", proxied), {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: completedTurn },
    }));
});

test("rejects proxied stored ItemState on item started without invoking traps", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    completed(message),
  );
  const stored = base.items.get("message-1");

  assertStoredItemRejected(stored, (proxied) =>
    api.reduceServerMessage(
      withStoredItem(base, "message-1", proxied),
      started(message),
    ));
});

test("rejects accessor-backed stored ItemState fields without invoking accessors", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "final", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    completed(message),
  );
  const stored = { ...base.items.get("message-1") };
  let accessorCalls = 0;
  Object.defineProperty(stored, "phase", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error("stored ItemState phase accessor invoked");
    },
  });
  let failure = null;

  try {
    api.reduceServerMessage(
      withStoredItem(base, "message-1", stored),
      completed(message),
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(accessorCalls, 0);
  assert.equal(failure?.name, "ReducerError");
  assert.equal(failure?.code, "INVALID_SERVER_EVENT");
});

test("rejects proxied and accessor-backed stored ItemState values on delta without invoking hooks", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "initial", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    started(message),
  );
  const stored = base.items.get("message-1");
  const delta = {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: " later" },
  };

  assertStoredItemRejected(stored.value, (proxiedValue) =>
    api.reduceServerMessage(
      withStoredItem(base, "message-1", { ...stored, value: proxiedValue }),
      delta,
    ));

  let accessorCalls = 0;
  const accessorValue = {};
  Object.defineProperty(accessorValue, "text", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error("stored ItemState value accessor invoked");
    },
  });
  let failure = null;
  try {
    api.reduceServerMessage(
      withStoredItem(base, "message-1", { ...stored, value: accessorValue }),
      delta,
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(accessorCalls, 0);
  assert.equal(failure?.name, "ReducerError");
  assert.equal(failure?.code, "INVALID_SERVER_EVENT");
});

function assertExtraStoredItemAccessorRejected(stored, invoke) {
  for (const key of ["unexpected", Symbol("unexpected")]) {
    let accessorCalls = 0;
    const accessorBacked = { ...stored };
    Object.defineProperty(accessorBacked, key, {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("extra stored ItemState accessor invoked");
      },
    });
    let failure = null;
    try {
      invoke(accessorBacked);
    } catch (error) {
      failure = error;
    }
    assert.equal(accessorCalls, 0, typeof key);
    assert.equal(failure?.name, "ReducerError", typeof key);
    assert.equal(failure?.code, "INVALID_SERVER_EVENT", typeof key);
  }
}

test("rejects active stored ItemState extra own accessors before delta update", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "initial", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    started(message),
  );
  const stored = base.items.get("message-1");
  const delta = {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: " later" },
  };

  assertExtraStoredItemAccessorRejected(stored, (accessorBacked) =>
    api.reduceServerMessage(
      withStoredItem(base, "message-1", accessorBacked),
      delta,
    ));
});

test("rejects omitted stored ItemState extra own accessors before delta update", () => {
  const api = reducer();
  let base = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 64; index += 1) {
    base = api.reduceServerMessage(
      base,
      started(item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })),
    );
  }
  const omittedMessage = item("plan", "omitted-plan", { text: "initial" });
  base = api.reduceServerMessage(base, started(omittedMessage));
  const stored = base.omittedItemStates.get("omitted-plan");
  const delta = {
    method: "item/plan/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "omitted-plan", delta: " later" },
  };

  assertExtraStoredItemAccessorRejected(stored, (accessorBacked) => {
    const omittedItemStates = new Map(base.omittedItemStates);
    omittedItemStates.set("omitted-plan", accessorBacked);
    return api.reduceServerMessage({ ...base, omittedItemStates }, delta);
  });
});

function assertNonEnumerableStoredItemRejected(stored, invoke) {
  const nonEnumerable = { ...stored };
  Object.defineProperty(nonEnumerable, "phase", {
    value: stored.phase,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  assert.throws(
    () => invoke(nonEnumerable),
    (error) => error?.name === "ReducerError" && error?.code === "INVALID_SERVER_EVENT",
  );
}

test("rejects active stored ItemState with a non-enumerable required field", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "initial", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    started(message),
  );
  const stored = base.items.get("message-1");
  const delta = {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: " later" },
  };

  assertNonEnumerableStoredItemRejected(stored, (nonEnumerable) =>
    api.reduceServerMessage(withStoredItem(base, "message-1", nonEnumerable), delta));
});

test("rejects omitted stored ItemState with a non-enumerable required field", () => {
  const api = reducer();
  let base = api.createTurnState("thread-1", "turn-1");
  for (let index = 0; index < 64; index += 1) {
    base = api.reduceServerMessage(
      base,
      started(item("agentMessage", `message-${index}`, { text: "x", phase: null, memoryCitation: null })),
    );
  }
  base = api.reduceServerMessage(base, started(item("plan", "omitted-plan", { text: "initial" })));
  const stored = base.omittedItemStates.get("omitted-plan");
  const delta = {
    method: "item/plan/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "omitted-plan", delta: " later" },
  };

  assertNonEnumerableStoredItemRejected(stored, (nonEnumerable) => {
    const omittedItemStates = new Map(base.omittedItemStates);
    omittedItemStates.set("omitted-plan", nonEnumerable);
    return api.reduceServerMessage({ ...base, omittedItemStates }, delta);
  });
});

function corruptedStoredItem(stored, kind) {
  if (kind === "item symbol") {
    const corrupted = { ...stored };
    corrupted[Symbol("unexpected")] = true;
    return corrupted;
  }
  if (kind === "non-enumerable phase") {
    const corrupted = { ...stored };
    Object.defineProperty(corrupted, "phase", {
      value: stored.phase,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return corrupted;
  }
  const value = { ...stored.value };
  value[Symbol("unexpected")] = true;
  return { ...stored, value };
}

function assertTerminalStoredCorruptionRejected(api, state, completedTurn, location) {
  const itemId = location === "visible" ? "message-0" : "message-64";
  const stored = location === "visible"
    ? state.items.get(itemId)
    : state.omittedItemStates.get(itemId);
  const kinds = ["item symbol", "non-enumerable phase", "nested value symbol"];
  const results = [];
  for (const kind of kinds) {
    const corrupted = corruptedStoredItem(stored, kind);
    const candidate = location === "visible"
      ? { ...state, items: new Map(state.items).set(itemId, corrupted) }
      : {
          ...state,
          omittedItemStates: new Map(state.omittedItemStates).set(itemId, corrupted),
        };
    let failure = null;
    try {
      api.reduceServerMessage(candidate, {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: completedTurn },
      });
    } catch (error) {
      failure = error;
    }
    results.push({ kind, name: failure?.name, code: failure?.code });
  }
  assert.deepEqual(
    results,
    kinds.map((kind) => ({ kind, name: "ReducerError", code: "INVALID_SERVER_EVENT" })),
    location,
  );
}

function terminalStateWithOmittedItem(api) {
  const items = Array.from({ length: 65 }, (_, index) =>
    item("agentMessage", `message-${index}`, {
      text: `message ${index}`,
      phase: null,
      memoryCitation: null,
    }));
  const completedTurn = {
    id: "turn-1",
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  const state = api.reduceServerMessage(api.createTurnState("thread-1", "turn-1"), {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: completedTurn },
  });
  return { state, completedTurn };
}

test("terminal duplicate rejects visible stored ItemState corruption", () => {
  const api = reducer();
  const { state, completedTurn } = terminalStateWithOmittedItem(api);
  assertTerminalStoredCorruptionRejected(api, state, completedTurn, "visible");
});

test("terminal duplicate rejects omitted stored ItemState corruption", () => {
  const api = reducer();
  const { state, completedTurn } = terminalStateWithOmittedItem(api);
  assertTerminalStoredCorruptionRejected(api, state, completedTurn, "omitted");
});

test("active agentMessage delta rejects a stored value inherited text getter without invoking it", () => {
  const api = reducer();
  const message = item("agentMessage", "message-1", { text: "initial", phase: null, memoryCitation: null });
  const base = api.reduceServerMessage(
    api.createTurnState("thread-1", "turn-1"),
    started(message),
  );
  const stored = base.items.get("message-1");
  const hostile = withStoredItem(base, "message-1", { ...stored, value: {} });
  const delta = {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: " later" },
  };
  let getterCalls = 0;
  let failure = null;
  Object.defineProperty(Object.prototype, "text", {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error("inherited text getter invoked");
    },
  });

  try {
    api.reduceServerMessage(hostile, delta);
  } catch (error) {
    failure = error;
  } finally {
    delete Object.prototype.text;
  }

  assert.equal(getterCalls, 0);
  assert.equal(failure?.name, "ReducerError");
  assert.equal(failure?.code, "INVALID_SERVER_EVENT");
});
