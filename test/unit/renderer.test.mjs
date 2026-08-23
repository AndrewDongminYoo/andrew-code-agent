import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const rendererModule = await import("../../dist/app-server/renderer.js").catch(() => null);

function renderer() {
  assert.notEqual(rendererModule, null, "the built renderer module must be available");
  return rendererModule;
}

test("renders deterministic bounded turn output without raw reasoning", () => {
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([
      ["agent-1", { id: "agent-1", type: "subAgentActivity", phase: "completed", value: { label: "Subagent started: helper" } }],
      ["command-1", { id: "command-1", type: "commandExecution", phase: "completed", value: { command: "git status", cwd: "/repo", exitCode: 7, output: "[truncated]" } }],
      ["reasoning-1", { id: "reasoning-1", type: "reasoning", phase: "completed", value: { label: "Reasoning updated", raw: "private reasoning must never render" } }],
      ["unknown-1", { id: "unknown-1", type: "futureType", phase: "started", value: { credential: "do-not-dump" } }],
    ]),
    observedCommands: [{ command: "git status", cwd: "/repo", exitCode: 7 }],
    diff: "diff --git a/a b/a\n+line",
    warnings: ["A bounded warning"],
    terminalStatus: "interrupted",
  };
  const lines = renderer().renderTurnState(state);
  assert.deepEqual(lines, renderer().renderTurnState(state));
  assert.match(lines.join("\n"), /thread-1|turn-1|Subagent|git status|exit 7|\[truncated\]|diff --git|A bounded warning|interrupted/);
  assert.doesNotMatch(lines.join("\n"), /private reasoning|credential|do-not-dump/);
  assert.ok(lines.findIndex((line) => line.includes("agent-1")) < lines.findIndex((line) => line.includes("command-1")));
});

test("bounds externally supplied IDs and types and renders projection omission metadata", () => {
  const state = {
    threadId: "thread".repeat(200),
    turnId: "turn".repeat(200),
    items: new Map([["item".repeat(200), { id: "item".repeat(200), type: "future".repeat(200), phase: "started", value: { credential: "hidden" } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    omittedItems: 1,
    omittedCommands: 1,
    omittedWarnings: 1,
    terminalStatus: "completed",
  };
  const lines = renderer().renderTurnState(state);
  assert.match(lines.join("\n"), /\[truncated\]/);
  assert.match(lines.join("\n"), /1 item\(s\) omitted|1 command\(s\) omitted|1 warning\(s\) omitted/);
  assert.doesNotMatch(lines.join("\n"), /credential|hidden/);
});

test("distinguishes active omission lower bounds from exact terminal counts", () => {
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map(),
    observedCommands: [],
    diff: null,
    warnings: [],
    omittedItems: 64,
    omittedCommands: 0,
    omittedWarnings: 0,
  };

  const activeLines = renderer().renderTurnState({ ...base, omittedItemsComplete: false, terminalStatus: "running" });
  const terminalLines = renderer().renderTurnState({ ...base, omittedItemsComplete: true, terminalStatus: "completed" });

  assert.ok(activeLines.includes("At least 64 item(s) omitted"));
  assert.ok(terminalLines.includes("64 item(s) omitted"));
  assert.ok(!terminalLines.includes("At least 64 item(s) omitted"));
});

test("uses UTF-8 bounds externally and renders neutral MCP lifecycle details", () => {
  const state = {
    threadId: "🙂".repeat(200),
    turnId: "turn-1",
    items: new Map([["mcp-1", { id: "mcp-1", type: "mcpToolCall", phase: "started", value: { server: "fixture", tool: "lookup", status: "external status secret", progress: "external progress secret", raw: "secret" } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    omittedItems: 0,
    omittedCommands: 0,
    omittedWarnings: 0,
    terminalStatus: "running",
  };
  const lines = renderer().renderTurnState(state);
  assert.ok(lines.every((line) => Buffer.byteLength(line, "utf8") <= 512));
  assert.match(lines.join("\n"), /MCP status updated/);
  assert.doesNotMatch(lines.join("\n"), /external status secret|external progress secret|secret/);
});

test("bounds every composed external line by UTF-8 bytes", () => {
  const huge = "🙂".repeat(600);
  const state = {
    threadId: huge,
    turnId: huge,
    items: new Map([
      ["agent", { id: huge, type: "agentMessage", phase: "completed", value: { text: huge } }],
      ["command", { id: huge, type: "commandExecution", phase: "completed", value: { command: huge, cwd: huge, exitCode: 1, output: huge } }],
      ["files", { id: huge, type: "fileChange", phase: "completed", value: { files: [{ path: huge }, { path: huge }], omittedFiles: 1 } }],
      ["mcp", { id: huge, type: "mcpToolCall", phase: "completed", value: { server: huge, tool: huge, status: huge, progress: huge } }],
      ["subagent", { id: huge, type: "subAgentActivity", phase: "completed", value: { label: huge } }],
      ["future", { id: huge, type: huge, phase: "completed", value: { label: huge } }],
    ]),
    observedCommands: [{ command: huge, cwd: huge, exitCode: 1 }],
    diff: huge,
    warnings: [huge],
    omittedItems: 1,
    omittedCommands: 1,
    omittedWarnings: 1,
    terminalStatus: "completed",
  };
  const lines = renderer().renderTurnState(state);
  assert.ok(lines.length >= 15);
  for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

test("keeps command output visible when command context is long and bounds terminal status", () => {
  const huge = "🙂".repeat(600);
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["command", { id: "command-1", type: "commandExecution", phase: "completed", value: { command: huge, cwd: huge, exitCode: 0, output: "real output marker" } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    omittedItems: 0,
    omittedCommands: 0,
    omittedWarnings: 0,
    terminalStatus: huge,
  };
  const lines = renderer().renderTurnState(state);
  assert.ok(lines.some((line) => line === "Command output: real output marker"));
  assert.ok(lines.some((line) => line.startsWith("Terminal status: ") && line.endsWith(" [truncated]")));
  for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

test("visibly escapes terminal controls across every externally supplied rendered field before bounding lines", () => {
  const hugeOutput = `output\u001b]0;owned\u0007safe\u001b]2;again\u0007${"\u2028".repeat(600)}`;
  const state = {
    threadId: "thread\u0000\u001b",
    turnId: "turn\u000d\u202e",
    items: new Map([
      ["agent", { id: "agent\u000a\u2028", type: "agentMessage", phase: "completed", value: { text: "text\u007f\u2029" } }],
      ["command", { id: "command", type: "commandExecution", phase: "completed", value: { command: "printf\u009b\u001b", cwd: "/repo\u0007\u202e", exitCode: 0, output: hugeOutput } }],
      ["files", { id: "files", type: "fileChange", phase: "completed", value: { files: [{ path: "/repo/file\u000a\u2028" }] } }],
      ["mcp", { id: "mcp", type: "mcpToolCall", phase: "completed", value: { server: "server\u000d\u2029", tool: "tool\u0000\u001b" } }],
      ["subagent", { id: "subagent", type: "subAgentActivity", phase: "completed", value: { label: "helper\u202e" } }],
      ["future", { id: "item\u001b", type: "future\u2029", phase: "started", value: { label: "label\u2028" } }],
    ]),
    observedCommands: [{ command: "observed\u009b\u2029", cwd: "/observed\u007f\u001b", exitCode: 1 }],
    diff: "diff\u202e",
    warnings: ["warning\u0007\u2028"],
    terminalStatus: "completed",
  };

  const lines = renderer().renderTurnState(state);
  const rendered = lines.join("|");

  for (const line of lines)
    assert.doesNotMatch(line, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  for (const expected of [
    "thread\\x00\\x1B",
    "turn\\x0D\\u{202E}",
    "agent\\x0A\\u{2028}",
    "text\\x7F\\u{2029}",
    "printf\\x9B\\x1B",
    "/repo\\x07\\u{202E}",
    "output\\x1B]0;owned\\x07safe\\x1B]2;again\\x07\\u{2028}",
    "/repo/file\\x0A\\u{2028}",
    "server\\x0D\\u{2029}",
    "tool\\x00\\x1B",
    "helper\\u{202E}",
    "item\\x1B",
    "future\\u{2029}",
    "label\\u{2028}",
    "observed\\x9B\\u{2029}",
    "/observed\\x7F\\x1B",
    "diff\\u{202E}",
    "warning\\x07\\u{2028}",
  ]) assert.ok(rendered.includes(expected), expected);
  for (const line of lines)
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

test("bounds control-heavy renderer input without allocating a full escaped copy", () => {
  const script = `
    import { renderTurnState } from ${JSON.stringify(new URL("../../dist/app-server/renderer.js", import.meta.url).href)};
    const huge = "\\u2028".repeat(4_000_000);
    const lines = renderTurnState({
      threadId: "thread-1",
      turnId: "turn-1",
      items: new Map([["agent", { id: "agent", type: "agentMessage", phase: "completed", value: { text: huge } }]]),
      observedCommands: [],
      diff: null,
      warnings: [],
      terminalStatus: "completed",
    });
    if (!lines.some((line) => line.includes("\\\\u{2028}") && line.endsWith(" [truncated]"))) process.exit(2);
    if (!lines.every((line) => Buffer.byteLength(line, "utf8") <= 512)) process.exit(3);
  `;
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=32", "--input-type=module", "--eval", script],
    { encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 1024 * 1024, timeout: 10_000 },
  );

  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

// A streaming message rendered its whole accumulated prefix on every delta, so
// a fifteen-second turn produced 142 near-identical lines. `reasoning` already
// renders a constant while it runs; text items now do the same.
test("a message in flight renders a constant, and its text only when complete", () => {
  const base = { threadId: "thread-1", turnId: "turn-1", items: new Map(), observedCommands: [], diff: null, warnings: [], terminalStatus: "running" };
  const streaming = (text) => renderer().renderTurnState({
    ...base,
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "started", value: { text } }]]),
  }).join("\n");
  assert.equal(streaming("The ans"), streaming("The answer is fo"));
  assert.doesNotMatch(streaming("The answer is forty two"), /forty two/);

  const done = renderer().renderTurnState({
    ...base,
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text: "The answer is forty two" } }]]),
  }).join("\n");
  assert.match(done, /The answer is forty two/);
});

// The same cap that bounded the reprints also truncated the answer where it was
// printed, mid-sentence, in the one place the operator reads it.
test("a completed message longer than the old cap renders without truncation", () => {
  const text = "요약: ".concat("변경 사항을 확인했습니다. ".repeat(40));
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  }).join("\n");
  assert.doesNotMatch(lines, /\[truncated\]/);
});

// Command output still streams, so its line must stay small: the raised bound
// is for the message that renders once, not for a value reprinted per delta.
test("streaming command output stays bounded well below the message bound", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["cmd-1", { id: "cmd-1", type: "commandExecution", phase: "started", value: { command: "npm test", cwd: "/repo", exitCode: null, output: "x".repeat(4096) } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "running",
  });
  const output = lines.find((line) => line.startsWith("Command output:"));
  assert.notEqual(output, undefined);
  assert.ok(Buffer.byteLength(output, "utf8") <= 600, `command output line was ${Buffer.byteLength(output, "utf8")} bytes`);
});

// reportTurnState skips a line it has already written, keyed on the whole
// string, so two chunks of one message that happen to be identical would be
// silently dropped and the answer corrupted.
test("every line of a chunked message is distinguishable from the others", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text: "x".repeat(3000) } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const messageLines = lines.filter((line) => line.includes("x".repeat(20)));
  assert.ok(messageLines.length >= 3, `expected several chunks, got ${messageLines.length}`);
  assert.equal(new Set(messageLines).size, messageLines.length, "chunks must not collide");
});

// The reducer retains 4096 UTF-16 code units, so anything it accepts must be
// renderable: a line cap smaller than that budget throws away a message the
// product deliberately kept.
test("a message at the reducer's retained size renders without truncation", () => {
  for (const [name, text] of [
    ["hangul", "가".repeat(4096)],
    ["separators", "\u2028".repeat(4096)],
  ]) {
    const lines = renderer().renderTurnState({
      threadId: "thread-1",
      turnId: "turn-1",
      items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text } }]]),
      observedCommands: [],
      diff: null,
      warnings: [],
      terminalStatus: "completed",
    });
    assert.ok(!lines.some((line) => line.endsWith(" [truncated]")), `${name} was truncated`);
    for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
  }
});
