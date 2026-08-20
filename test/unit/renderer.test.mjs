import assert from "node:assert/strict";
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
