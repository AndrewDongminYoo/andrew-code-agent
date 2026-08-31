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
      ["agent-1", { id: "agent-1", type: "subAgentActivity", phase: "completed", value: { label: "Subagent: helper", activityKind: "started" } }],
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

test("renders subagent activity kind separately from the item phase", () => {
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  };
  const render = (id, activityKind) =>
    renderer().renderTurnState({
      ...base,
      items: new Map([[id, { id, type: "subAgentActivity", phase: "completed", value: { label: "Subagent: helper", activityKind } }]]),
    }).join("\n");

  assert.match(render("interacted", "interacted"), /interacted subAgentActivity completed: Subagent: helper \(activity: interacted\)/);
  assert.match(render("interrupted", "interrupted"), /interrupted subAgentActivity completed: Subagent: helper \(activity: interrupted\)/);
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
      ["subagent", { id: "subagent", type: "subAgentActivity", phase: "completed", value: { label: "helper\u202e", activityKind: "interrupted\u001b" } }],
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
    "interrupted\\x1B",
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

test("hashes a hostile item ID without allocating one full encoded copy", () => {
  const script = `
    import { renderTurnState } from ${JSON.stringify(new URL("../../dist/app-server/renderer.js", import.meta.url).href)};
    const originalFrom = Buffer.from;
    Buffer.from = function(value, ...rest) {
      if (typeof value === "string" && value.length > 4_096) throw new Error("unbounded string copy");
      return Reflect.apply(originalFrom, this, [value, ...rest]);
    };
    const hugeId = "x".repeat(1_000_000);
    const lines = renderTurnState({
      threadId: "thread-1",
      turnId: "turn-1",
      items: new Map([[hugeId, { id: hugeId, type: "agentMessage", phase: "completed", value: { text: "answer" } }]]),
      observedCommands: [],
      diff: null,
      warnings: [],
      terminalStatus: "completed",
    });
    if (!lines.some((line) => line.includes("agentMessage completed") && line.endsWith(": answer"))) process.exit(2);
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

test("renders message newlines as ordinal line boundaries", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text: "first\nsecond\n" } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const messageLines = lines.filter((line) => line.includes("agentMessage completed"));

  assert.deepEqual(messageLines, [
    "msg-1 agentMessage completed [1/3]: first",
    "msg-1 agentMessage completed [2/3]: second",
    "msg-1 agentMessage completed [3/3]: ",
  ]);
  assert.ok(!messageLines.some((line) => line.includes("\\x0A")));
  for (const [index, line] of messageLines.entries())
    for (const later of messageLines.slice(index + 1))
      assert.ok(!later.startsWith(line), `${JSON.stringify(line)} prefixes ${JSON.stringify(later)}`);
});

test("bounds newline-split messages and keeps other controls visible", () => {
  const text = `head\n${"x".repeat(600)}\r\x1b[31m\x1b]8;;https://example.com\x07label\x1b]8;;\x07\u202e`;
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const messageLines = lines.filter((line) => line.includes("agentMessage completed"));
  const rendered = messageLines.join("|");

  assert.ok(messageLines.length >= 3, `expected structural and bounded lines, got ${messageLines.length}`);
  assert.doesNotMatch(rendered, /\\x0A/);
  for (const expected of [
    "\\x0D",
    "\\x1B[31m",
    "\\x1B]8;;https://example.com\\x07label\\x1B]8;;\\x07",
    "\\u{202E}",
  ])
    assert.ok(rendered.includes(expected), expected);
  for (const line of messageLines)
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
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

// Command output is terminal output and is multi-line by nature. Rendering it
// as one escaped line is what made a real run unreadable, so a completed
// command splits it the way a completed message does. The split waits for
// completion because a chunk's ordinal names the total, and a total that grows
// per delta would change every earlier line and defeat the write-once skip.
test("a completed command renders its output across structural lines", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["cmd-1", { id: "cmd-1", type: "commandExecution", phase: "completed", value: { command: "npm test", cwd: "/repo", exitCode: 0, output: "first line\nsecond line\nthird line" } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const outputLines = lines.filter((line) => line.startsWith("Command output"));
  assert.ok(outputLines.length >= 3, `expected one line per structural line, got ${outputLines.length}`);
  assert.doesNotMatch(outputLines.join("|"), /\\x0A/, "a real newline must not reach the terminal as its escape");
  for (const part of ["first line", "second line", "third line"])
    assert.ok(outputLines.some((line) => line.includes(part)), part);
  for (const line of outputLines)
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

// The reducer appends the marker when it drops the tail. Chunking must carry it
// through, or the operator reads a short output as a complete one.
test("a completed command keeps the truncation marker the reducer appended", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["cmd-1", { id: "cmd-1", type: "commandExecution", phase: "completed", value: { command: "npm test", cwd: "/repo", exitCode: 0, output: `${"z".repeat(4000)} [truncated]` } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const outputLines = lines.filter((line) => line.startsWith("Command output"));
  assert.ok(outputLines.some((line) => line.includes("[truncated]")), "the marker must survive chunking");
  for (const line of outputLines)
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

// Splitting on newlines must not let any other control through: the escaping
// exists to stop a command's output from painting lines that look like ours.
test("a completed command keeps every other control visible and escaped", () => {
  const output = `head\n${"x".repeat(600)}\r\x1b[31m\x1b]8;;https://example.com\x07label\x1b]8;;\x07\u202e`;
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["cmd-1", { id: "cmd-1", type: "commandExecution", phase: "completed", value: { command: "npm test", cwd: "/repo", exitCode: 0, output } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const rendered = lines.filter((line) => line.startsWith("Command output")).join("|");
  assert.doesNotMatch(rendered, /\\x0A/);
  for (const expected of [
    "\\x0D",
    "\\x1B[31m",
    "\\x1B]8;;https://example.com\\x07label\\x1B]8;;\\x07",
    "\\u{202E}",
  ])
    assert.ok(rendered.includes(expected), expected);
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

test("chunked messages stay distinct when their displayed protocol IDs collide", () => {
  const sharedPrefix = "x".repeat(180);
  const text = "same answer ".repeat(100);
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([
      [
        `${sharedPrefix}a`,
        {
          id: `${sharedPrefix}a`,
          type: "agentMessage",
          phase: "completed",
          value: { text },
        },
      ],
      [
        `${sharedPrefix}b`,
        {
          id: `${sharedPrefix}b`,
          type: "agentMessage",
          phase: "completed",
          value: { text },
        },
      ],
    ]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const messageLines = lines.filter((line) =>
    line.includes("agentMessage completed"),
  );
  assert.ok(messageLines.length >= 4, `expected chunked messages, got ${messageLines.length}`);
  assert.equal(
    new Set(messageLines).size,
    messageLines.length,
    "different raw item IDs must never converge on the same delivery lines",
  );
});

test("reuses the completed message render while item identity is unchanged", () => {
  let textReads = 0;
  const value = {};
  Object.defineProperty(value, "text", {
    enumerable: true,
    get() {
      textReads += 1;
      return "cached answer ".repeat(100);
    },
  });
  const itemState = {
    id: "msg-1",
    type: "agentMessage",
    phase: "completed",
    value,
  };
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", itemState]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  };

  const first = renderer().renderTurnState(state);
  const second = renderer().renderTurnState(state);

  assert.deepEqual(second, first);
  assert.equal(textReads, 1);
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

test("renders every retained newline boundary without truncation", () => {
  const lines = renderer().renderTurnState({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "completed", value: { text: "\n".repeat(4096) } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus: "completed",
  });
  const messageLines = lines.filter((line) => line.includes("agentMessage completed"));

  assert.equal(messageLines.length, 4097);
  assert.ok(!messageLines.some((line) => line.endsWith(" [truncated]")));
  for (const line of messageLines)
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, line);
});

// A turn can end while a message is still `started` — an interrupt, or a
// failure after deltas. Holding the text back until completion would throw
// away everything the turn generated.
test("a terminal turn shows the text of a message that never completed", () => {
  const partial = "생성 중이던 답변입니다. ".repeat(6);
  const stateFor = (terminalStatus) => ({
    threadId: "thread-1",
    turnId: "turn-1",
    items: new Map([["msg-1", { id: "msg-1", type: "agentMessage", phase: "started", value: { text: partial } }]]),
    observedCommands: [],
    diff: null,
    warnings: [],
    terminalStatus,
  });
  for (const terminalStatus of ["interrupted", "failed", "completed"]) {
    const rendered = renderer().renderTurnState(stateFor(terminalStatus)).join("\n");
    assert.match(rendered, /생성 중이던 답변입니다/, terminalStatus);
  }
  // While the turn is still running the constant stands, or the reprinting
  // this PR removed comes straight back.
  const running = renderer().renderTurnState(stateFor("running")).join("\n");
  assert.doesNotMatch(running, /생성 중이던 답변입니다/);
  assert.match(running, /Message updated/);
});
