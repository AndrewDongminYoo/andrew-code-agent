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
