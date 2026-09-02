#!/usr/bin/env node
// Deterministic stand-in for the `codex` binary in acceptance tests.
//
// `--version` answers the pinned product version so the Doctor version gate
// and the client handshake accept it. `app-server` replays a scripted
// newline-delimited JSON conversation from ANDREW_AGENT_FAKE_SCRIPT, so the
// compiled CLI can be exercised end to end without a real Codex install.
//
// Script lines carrying an `id` are server-to-client requests: replay pauses
// until the client answers that id. Lines without one are notifications and
// are written immediately.

import { appendFileSync } from "node:fs";
import { appendFile, cp, readFile } from "node:fs/promises";

const { REQUIRED_CODEX_VERSION } = await import(
  new URL("../../dist/constants.js", import.meta.url).href
);

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

const args = process.argv.slice(2);
const [command] = args;

if (command === "--version") {
  process.stdout.write(`codex-cli ${REQUIRED_CODEX_VERSION}\n`);
  process.exit(0);
}

// Doctor regenerates the app-server contract and compares its digest against
// REQUIRED_CODEX_CONTRACT_DIGEST, and the compiled CLI offers no way to inject
// a different expectation. A stand-in for the pinned binary therefore has to
// emit the pinned contract, which is exactly the committed trees.
const generatorSources = {
  "generate-ts": "../../src/generated/codex-app-server/",
  "generate-json-schema": "../../schemas/codex-app-server/",
};
if (
  command === "app-server" &&
  args.length === 4 &&
  args[2] === "--out" &&
  Object.hasOwn(generatorSources, args[1])
) {
  await cp(new URL(generatorSources[args[1]], import.meta.url), args[3], {
    recursive: true,
  });
  process.exit(0);
}

const isStrictProbe =
  args.length === 4 &&
  args[1] === "--strict-config" &&
  args[2] === "--listen" &&
  args[3] === "stdio://";
const isSession =
  args.length === 3 && args[1] === "--strict-config" && args[2] === "--stdio";

if (command !== "app-server" || (!isStrictProbe && !isSession)) {
  process.stderr.write(`unsupported fixture invocation: ${args.join(" ")}\n`);
  process.exit(64);
}

// Doctor's strict-config probe validates the managed home and exits without
// opening a session; leaving a child alive here fails its residual check.
if (isStrictProbe) process.exit(0);

const scriptPath = process.env.ANDREW_AGENT_FAKE_SCRIPT;
if (scriptPath === undefined) {
  process.stderr.write("ANDREW_AGENT_FAKE_SCRIPT is required\n");
  process.exit(64);
}
const script = (await readFile(scriptPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const editPath = process.env.ANDREW_AGENT_FAKE_EDIT_PATH;
const editText = process.env.ANDREW_AGENT_FAKE_EDIT_TEXT ?? "fixture edit\n";
const exitAfterTurn = process.env.ANDREW_AGENT_FAKE_EXIT_AFTER_TURN === "1";
// Records what the client actually answered, so a scenario can observe the
// decision instead of inferring it from the turn's outcome.
const decisionLog = process.env.ANDREW_AGENT_FAKE_DECISION_LOG;
// Records this session's pid so a scenario can assert on exactly the children
// its own run spawned rather than on whatever pgrep happens to match.
const pidLog = process.env.ANDREW_AGENT_FAKE_PID_LOG;
if (pidLog !== undefined) appendFileSync(pidLog, `${process.pid}\n`);

const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

// The client answers a scripted request with its own {id, result} frame.
function awaitClientResponse(id) {
  return new Promise((resolve) => pending.set(id, resolve));
}

async function replay() {
  for (const line of script) {
    if (line.id !== undefined) {
      const answered = awaitClientResponse(line.id);
      send(line);
      await answered;
      continue;
    }
    send(line);
  }
  if (exitAfterTurn) process.exit(0);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      userAgent: "fake-app-server",
      codexHome: process.env.CODEX_HOME ?? "",
      platformFamily: "unix",
      platformOs: "macos",
    });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    respond(id, { thread: { id: THREAD_ID } });
    return;
  }
  if (method === "thread/read") {
    respond(id, { thread: { id: THREAD_ID, status: { type: "idle" } } });
    return;
  }
  if (method === "turn/start") {
    respond(id, { turn: { id: TURN_ID } });
    if (editPath !== undefined) await appendFile(editPath, editText);
    void replay();
    return;
  }
  if (method === "turn/interrupt") {
    respond(id, {});
    return;
  }
  respond(id, {});
  void params;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // A frame with an id and no method is the client answering a request.
    if (message.method === undefined && message.id !== undefined) {
      const resolve = pending.get(message.id);
      if (resolve !== undefined) {
        pending.delete(message.id);
        if (decisionLog !== undefined)
          void appendFile(decisionLog, `${JSON.stringify(message)}\n`);
        resolve(message);
      }
      continue;
    }
    if (message.id !== undefined) void handleRequest(message);
  }
});
process.stdin.on("end", () => process.exit(0));
