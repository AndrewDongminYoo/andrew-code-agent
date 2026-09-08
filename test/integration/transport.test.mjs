import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const transportModule = await import(
  "../../dist/app-server/transport.js"
).catch(() => null);
const clientModule = await import("../../dist/app-server/client.js").catch(
  () => null,
);
const { REQUIRED_CODEX_VERSION } = await import("../../dist/constants.js");

function requireTransport() {
  assert.notEqual(
    transportModule,
    null,
    "the built app-server transport module must be available",
  );
  return transportModule;
}

function requireClient() {
  assert.notEqual(
    clientModule,
    null,
    "the built app-server client module must be available",
  );
  return clientModule;
}

function syntheticChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    child.signalCode = signal;
    child.stdout.end();
    child.emit("exit", null, signal);
    return true;
  };
  return child;
}

async function withProtocolChild(source, run) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-transport-"));
  const script = join(root, "server.mjs");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await run(child, root);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForChildExit(child, timeoutMs = 1000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("protocol child did not exit after transport failure"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function readPositivePid(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

function completedNotification(aggregatedOutput) {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [
          {
            type: "commandExecution",
            id: "item-1",
            pluginId: null,
            scriptPath: null,
            command: "printf output",
            cwd: "/tmp",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput,
            exitCode: 0,
            durationMs: 1,
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    },
  };
}

test("rejects thread requests before handshake readiness without writing them", async () => {
  await withProtocolChild(`setInterval(() => {}, 1000);`, async (child) => {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      100,
    );
    await assert.rejects(
      transport.request("thread/start", {}),
      errorCode("THREAD_REQUEST_BEFORE_HANDSHAKE"),
    );
    await transport.close();
  });
});

test("fails malformed JSONL terminally, reaps the child, and emits no thread start", async () => {
  const source = `import { appendFile } from "node:fs/promises"; import { createInterface } from "node:readline"; const record = process.argv[2]; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { await appendFile(record, line + "\\n"); process.stdout.write("{bad-json}\\n"); }`;
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-malformed-"));
  const script = join(root, "server.mjs");
  const record = join(root, "record");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, record], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      300,
    );
    await assert.rejects(
      transport.request("initialize", {}),
      errorCode("MALFORMED_PROTOCOL"),
    );
    await assert.rejects(
      transport.request("thread/start", {}),
      errorCode("MALFORMED_PROTOCOL"),
    );
    await transport.close();
    assert.notEqual(child.exitCode ?? child.signalCode, null);
    assert.doesNotMatch(await readFile(record, "utf8"), /thread\/start/);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("delivers a schema-compatible turn/completed notification larger than 64 KiB", async () => {
  const aggregatedOutput = "command-output:" + "x".repeat(70_000);
  const notification = completedNotification(aggregatedOutput);
  const frame = JSON.stringify(notification);
  assert.equal(Buffer.byteLength(frame, "utf8") > 65_536, true);
  await withProtocolChild(
    `process.stdout.write(${JSON.stringify(frame + "\n")}); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      const outcome = await new Promise((resolve) => {
        transport.onNotification((received) =>
          resolve({ notification: received }),
        );
        transport.onFailure((failure) => resolve({ failure }));
      });
      assert.deepEqual(outcome, { notification });
      await transport.close();
    },
  );
});

test("accepts a valid JSONL frame exactly at the 16 MiB wire-byte limit", async () => {
  const maxProtocolLineBytes = 16 * 1024 * 1024;
  const emptyFrame = JSON.stringify(completedNotification(""));
  const aggregatedOutput = "x".repeat(
    maxProtocolLineBytes - Buffer.byteLength(emptyFrame, "utf8"),
  );
  const notification = completedNotification(aggregatedOutput);
  const frame = JSON.stringify(notification);
  assert.equal(Buffer.byteLength(frame, "utf8"), 16 * 1024 * 1024);
  await withProtocolChild(
    `process.stdout.write(${JSON.stringify(frame + "\n")}); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        1000,
      );
      const outcome = await new Promise((resolve) => {
        transport.onNotification((received) =>
          resolve({ notification: received }),
        );
        transport.onFailure((failure) => resolve({ failure }));
      });
      assert.deepEqual(outcome, { notification });
      await transport.close();
    },
  );
});

test("rejects a newline-free protocol line over 16 MiB without disclosing it and reaps the child", async () => {
  await withProtocolChild(
    `process.stdout.write("private-payload:" + "x".repeat(16 * 1024 * 1024)); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      let failure;
      await transport.request("initialize", {}).catch((error) => {
        failure = error;
      });
      assert.equal(failure.code, "APP_SERVER_PROTOCOL_LIMIT");
      assert.doesNotMatch(String(failure), /private-payload/u);
      await waitForChildExit(child);
      assert.notEqual(child.exitCode ?? child.signalCode, null);
      await transport.close();
    },
  );
});

test("measures the 16 MiB protocol line limit in UTF-8 wire bytes", async () => {
  await withProtocolChild(
    `process.stdout.write("é".repeat(8 * 1024 * 1024 + 1)); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      await assert.rejects(
        transport.request("initialize", {}),
        errorCode("APP_SERVER_PROTOCOL_LIMIT"),
      );
      await waitForChildExit(child);
      assert.notEqual(child.exitCode ?? child.signalCode, null);
      await transport.close();
    },
  );
});

for (const [name, frame, code] of [
  [
    "malformed response envelope",
    `{ "id": 1, "result": {}, "error": { "code": -1, "message": "bad" } }`,
    "MALFORMED_PROTOCOL",
  ],
  ["orphan response ID", `{ "id": 99, "result": {} }`, "ORPHAN_RESPONSE_ID"],
]) {
  test(`fails terminally on ${name}`, async () => {
    await withProtocolChild(
      `import { createInterface } from "node:readline"; const lines = createInterface({ input: process.stdin }); for await (const _ of lines) { process.stdout.write(${JSON.stringify(frame + "\n")}); }`,
      async (child) => {
        const transport = new (requireTransport().StdioJsonRpcTransport)(
          child,
          300,
        );
        await assert.rejects(
          transport.request("initialize", {}),
          errorCode(code),
        );
        await transport.close();
      },
    );
  });
}

test("fails terminally on a duplicate completed response ID", async () => {
  await withProtocolChild(
    `import { createInterface } from "node:readline"; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); }`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      await transport.request("initialize", {});
      await assert.rejects(
        new Promise((_, reject) =>
          setTimeout(
            () => transport.request("initialize", {}).catch(reject),
            20,
          ),
        ),
        errorCode("DUPLICATE_RESPONSE_ID"),
      );
      await transport.close();
    },
  );
});

test("yields after a response before delivering an ordered following burst", async () => {
  const notifications = Array.from({ length: 300 }, (_, sequence) => ({
    method: "test/notification",
    params: { sequence },
  }));
  await withProtocolChild(
    `import { createInterface } from "node:readline"; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); const frames = [{ id: message.id, result: {} }, ...${JSON.stringify(notifications)}]; process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\\n") + "\\n"); }`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      const order = [];
      let resolveDelivered;
      const delivered = new Promise((resolve) => {
        resolveDelivered = resolve;
      });
      transport.onNotification((message) => {
        order.push(`notification:${message.params.sequence}`);
        if (message.params.sequence === notifications.length - 1)
          resolveDelivered();
      });

      await transport.request("initialize", {}).then(() => {
        order.push("response");
      });
      await delivered;

      assert.deepEqual(order, [
        "response",
        ...notifications.map(
          ({ params }) => `notification:${params.sequence}`,
        ),
      ]);
      await transport.close();
    },
  );
});

test("serializes reentrant stdout behind an older same-chunk remainder", async () => {
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  const order = [];
  let notifications = 0;
  let resolveDelivered;
  const delivered = new Promise((resolve) => {
    resolveDelivered = resolve;
  });
  transport.onNotification((message) => {
    order.push(message.params.label);
    notifications += 1;
    if (notifications === 2) resolveDelivered();
  });
  let inject = true;
  child.stdout.on("data", () => {
    if (!inject) return;
    inject = false;
    child.stdout.emit(
      "data",
      `${JSON.stringify({ method: "test/notification", params: { label: "new-chunk" } })}\n`,
    );
  });

  const response = transport.request("initialize", {}).then(() => {
    order.push("response");
  });
  child.stdout.write(
    `${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ method: "test/notification", params: { label: "same-chunk-remainder" } })}\n`,
  );
  await Promise.all([response, delivered]);

  assert.deepEqual(order, [
    "response",
    "same-chunk-remainder",
    "new-chunk",
  ]);
  await transport.close();
});

test("keeps a response remainder ahead of stdout emitted by a preceding notification", async () => {
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  const order = [];
  let notifications = 0;
  let resolveDelivered;
  const delivered = new Promise((resolve) => {
    resolveDelivered = resolve;
  });
  transport.onNotification((message) => {
    order.push(message.params.label);
    notifications += 1;
    if (message.params.label === "before-notification") {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ method: "test/notification", params: { label: "reentrant-new-chunk" } })}\n`,
      );
    }
    if (notifications === 3) resolveDelivered();
  });

  const response = transport.request("initialize", {}).then(() => {
    order.push("response");
  });
  child.stdout.write(
    [
      { method: "test/notification", params: { label: "before-notification" } },
      { id: 1, result: {} },
      { method: "test/notification", params: { label: "same-write-remainder" } },
    ]
      .map((frame) => JSON.stringify(frame))
      .join("\n") + "\n",
  );
  await Promise.all([response, delivered]);

  assert.deepEqual(order, [
    "before-notification",
    "response",
    "same-write-remainder",
    "reentrant-new-chunk",
  ]);
  await transport.close();
});

test("fails closed when reentrant stdout exceeds the bounded pending-input count", async () => {
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  let inject = true;
  child.stdout.on("data", () => {
    if (!inject) return;
    inject = false;
    for (let count = 0; count < 256; count += 1)
      child.stdout.emit("data", " ");
  });
  const failure = new Promise((resolve) => transport.onFailure(resolve));
  const response = transport.request("initialize", {});
  child.stdout.write(
    `${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ method: "test/notification", params: {} })}\n`,
  );
  await response;

  const outcome = await Promise.race([
    failure,
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: "TEST_TIMEOUT" }), 50),
    ),
  ]);
  assert.equal(outcome.code, "APP_SERVER_PROTOCOL_LIMIT");
  await transport.close();
});

test("accepts an exact 16 MiB response-following line through the barrier", async () => {
  const maxProtocolLineBytes = 16 * 1024 * 1024;
  const emptyFrame = JSON.stringify(completedNotification(""));
  const aggregatedOutput = "x".repeat(
    maxProtocolLineBytes - Buffer.byteLength(emptyFrame, "utf8"),
  );
  const notification = completedNotification(aggregatedOutput);
  const frame = JSON.stringify(notification);
  assert.equal(Buffer.byteLength(frame, "utf8"), maxProtocolLineBytes);
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  const order = [];
  let resolveOutcome;
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve;
  });
  transport.onNotification((message) => {
    order.push("notification");
    resolveOutcome({ kind: "notification", message });
  });
  transport.onFailure((error) => {
    order.push("failure");
    resolveOutcome({ kind: "failure", error });
  });
  const response = transport.request("initialize", {}).then(() => {
    order.push("response");
  });

  child.stdout.write(
    `${JSON.stringify({ id: 1, result: {} })}\n${frame}\n`,
  );
  const received = await outcome;
  await response;

  assert.deepEqual(received, { kind: "notification", message: notification });
  assert.deepEqual(order, ["response", "notification"]);
  await transport.close();
});

test("bounds aggregate pending delimiter bytes before draining them", async () => {
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  let inject = true;
  child.stdout.on("data", () => {
    if (!inject) return;
    inject = false;
    child.stdout.emit("data", "\n".repeat(16 * 1024 * 1024 + 257));
  });
  const failure = new Promise((resolve) => transport.onFailure(resolve));
  const response = transport.request("initialize", {});
  child.stdout.write(
    `${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ method: "test/notification", params: {} })}\n`,
  );
  await response;

  const error = await failure;
  assert.equal(error.code, "APP_SERVER_PROTOCOL_LIMIT");
  await transport.close();
});

test("drains response-following frames before reporting an unexpected exit", async () => {
  const child = syntheticChild();
  const transport = new (requireTransport().StdioJsonRpcTransport)(child, 300);
  const order = [];
  const response = transport.request("initialize", {}).then(() => {
    order.push("response");
  });
  transport.onNotification(() => order.push("notification"));
  const failure = new Promise((resolve) =>
    transport.onFailure((error) => {
      order.push("failure");
      resolve(error);
    }),
  );

  child.stdout.write(
    `${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ method: "test/notification", params: {} })}\n`,
  );
  child.stdout.emit("end");
  child.exitCode = 17;
  child.emit("exit", 17, null);

  const error = await failure;
  await response;
  assert.equal(error.code, "APP_SERVER_UNEXPECTED_EXIT");
  assert.equal(error.exitCode, 17);
  assert.deepEqual(order, ["response", "notification", "failure"]);
  await transport.close();
});

test("bounds and redacts stderr accounting from protocol failures", async () => {
  await withProtocolChild(
    `await new Promise((resolve) => process.stderr.write("secret-stderr:" + "x".repeat(70000), resolve)); process.stdout.write("{bad-json}\\n"); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      let failure;
      await transport.request("initialize", {}).catch((error) => {
        failure = error;
      });
      await transport.close();
      assert.equal(failure.code, "MALFORMED_PROTOCOL");
      assert.equal(failure.stderrRetainedBytes, 65536);
      assert.equal(failure.stderrTruncated, true);
      assert.doesNotMatch(String(failure), /secret-stderr/);
    },
  );
});

test("makes handshake timeout terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-handshake-"));
  const binary = join(root, "codex");
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.152.1'; else exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'; fi\n`,
    { mode: 0o700 },
  );
  try {
    await assert.rejects(
      requireClient().startAppServer({
        codexBinary: binary,
        codexHome: join(root, "home"),
        productVersion: "0.1.0",
        handshakeTimeoutMs: 30,
        requestTimeoutMs: 300,
      }),
      errorCode("APP_SERVER_HANDSHAKE_TIMEOUT"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("makes request timeout terminal after readiness", async () => {
  const source = `import { createInterface } from "node:readline"; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "test", codexHome: "/tmp/home", platformFamily: "unix", platformOs: "macos" } }) + "\\n"); }`;
  await withProtocolChild(source, async (child) => {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      300,
    );
    await transport.request("initialize", {});
    transport.markReady();
    await assert.rejects(
      transport.requestWithTimeout(
        "thread/start",
        {},
        30,
        "APP_SERVER_REQUEST_TIMEOUT",
      ),
      errorCode("APP_SERVER_REQUEST_TIMEOUT"),
    );
    await transport.close();
  });
});

test("reports unexpected exit with safe diagnostics", async () => {
  await withProtocolChild(
    `process.stderr.write("do-not-leak"); process.exit(17);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      await assert.rejects(transport.request("initialize", {}), (error) => {
        assert.equal(error.code, "APP_SERVER_UNEXPECTED_EXIT");
        assert.equal(error.exitCode, 17);
        assert.equal(error.stderrRetainedBytes, 11);
        assert.equal(error.stderrTruncated, false);
        assert.doesNotMatch(String(error), /do-not-leak/);
        return true;
      });
      await transport.close();
    },
  );
});

test("reports one unexpected failure only after drained notifications", async () => {
  const notification = JSON.stringify({ method: "turn/completed", params: { authoritative: true } });
  await withProtocolChild(
    `import { createInterface } from "node:readline"; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n" + ${JSON.stringify(notification + "\n")}, () => process.exit(19)); }`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      const order = [];
      let failureCalls = 0;
      transport.onNotification(() => order.push("notification"));
      transport.onFailure(() => {
        failureCalls += 1;
        order.push("throwing-listener");
        throw new Error("listener failure");
      });
      transport.onFailure(() => Promise.reject(new Error("async listener failure")));
      const failure = new Promise((resolve) =>
        transport.onFailure((error) => {
          failureCalls += 1;
          order.push("failure");
          resolve(error);
        }),
      );
      await transport.request("initialize", {});
      const error = await failure;
      assert.equal(error.code, "APP_SERVER_UNEXPECTED_EXIT");
      assert.deepEqual(order, ["notification", "throwing-listener", "failure"]);
      assert.equal(failureCalls, 2);
      await transport.close();
      assert.equal(failureCalls, 2);
    },
  );
});

test("intentional close never reports an unexpected failure", async () => {
  await withProtocolChild(`setInterval(() => {}, 1000);`, async (child) => {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      300,
    );
    let failureCalls = 0;
    transport.onFailure(() => {
      failureCalls += 1;
    });
    await transport.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failureCalls, 0);
  });
});

test("close is idempotent and rejects pending and new work as closed", async () => {
  await withProtocolChild(`setInterval(() => {}, 1000);`, async (child) => {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      1000,
    );
    const pending = transport.request("initialize", {});
    const pendingRejected = assert.rejects(
      pending,
      errorCode("APP_SERVER_CLOSED"),
    );
    await Promise.all([transport.close(), transport.close()]);
    await pendingRejected;
    await assert.rejects(
      transport.request("initialize", {}),
      errorCode("APP_SERVER_CLOSED"),
    );
  });
});

test("respond writes an issued server response once and rejects unissued or duplicate IDs without writing", async () => {
  const source = `import { appendFile } from "node:fs/promises"; import { createInterface } from "node:readline"; const record = process.argv[2]; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); await appendFile(record, line + "\\n"); if (message.method === "initialize") { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ method: "item/tool/requestUserInput", id: "server-1", params: {} }) + "\\n"), 10); } else { process.stdout.write(JSON.stringify({ method: "response/observed", params: {} }) + "\\n"); } }`;
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-respond-"));
  const script = join(root, "server.mjs");
  const record = join(root, "record.jsonl");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, record], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      300,
    );
    assert.equal(typeof transport.respond, "function");
    const inbound = new Promise((resolve) => transport.onRequest(resolve));
    await transport.request("initialize", {});
    transport.markReady();
    await assert.rejects(
      transport.respond("never-issued", {}),
      errorCode("ORPHAN_RESPONSE_ID"),
    );
    assert.equal((await inbound).id, "server-1");
    const responseObserved = new Promise((resolve) =>
      transport.onNotification(resolve),
    );
    await transport.respond("server-1", { decision: "decline" });
    await responseObserved;
    await assert.rejects(
      transport.respond("server-1", {}),
      errorCode("DUPLICATE_RESPONSE_ID"),
    );
    await transport.close();
    const messages = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(messages, [
      { method: "initialize", id: 1, params: {} },
      { id: "server-1", result: { decision: "decline" } },
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid response results preserve the issued server request ID for one later valid response", async () => {
  const source = `import { appendFile } from "node:fs/promises"; import { createInterface } from "node:readline"; const record = process.argv[2]; const lines = createInterface({ input: process.stdin }); for await (const line of lines) { const message = JSON.parse(line); await appendFile(record, line + "\\n"); if (message.method === "initialize") { process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ method: "item/tool/requestUserInput", id: "server-1", params: {} }) + "\\n"), 10); } else { process.stdout.write(JSON.stringify({ method: "response/observed", params: message }) + "\\n"); } }`;
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-invalid-result-"));
  const script = join(root, "server.mjs");
  const record = join(root, "record.jsonl");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script, record], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const transport = new (requireTransport().StdioJsonRpcTransport)(
      child,
      300,
    );
    const inbound = new Promise((resolve) => transport.onRequest(resolve));
    await transport.request("initialize", {});
    transport.markReady();
    assert.equal((await inbound).id, "server-1");

    await assert.rejects(
      transport.respond("server-1", undefined),
      errorCode("MALFORMED_PROTOCOL"),
    );
    let toJsonCalls = 0;
    await assert.rejects(
      transport.respond("server-1", {
        toJSON() {
          toJsonCalls += 1;
          return undefined;
        },
      }),
      errorCode("MALFORMED_PROTOCOL"),
    );
    assert.equal(toJsonCalls, 1);
    assert.deepEqual(
      (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse),
      [{ method: "initialize", id: 1, params: {} }],
    );

    const responseObserved = new Promise((resolve) =>
      transport.onNotification(resolve),
    );
    await transport.respond("server-1", { decision: "decline" });
    assert.deepEqual(await responseObserved, {
      method: "response/observed",
      params: { id: "server-1", result: { decision: "decline" } },
    });
    await transport.close();
    assert.deepEqual(
      (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse),
      [
        { method: "initialize", id: 1, params: {} },
        { id: "server-1", result: { decision: "decline" } },
      ],
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects handshake timeout before descendant-held stdio closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-descendant-"));
  const binary = join(root, "codex");
  const server = join(root, "server.mjs");
  const descendantPid = join(root, "descendant.pid");
  await writeFile(descendantPid, "");
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.152.1'; else exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}; fi\n`,
    { mode: 0o700 },
  );
  await writeFile(
    server,
    `import { spawn } from "node:child_process"; import { writeFile } from "node:fs/promises"; const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); await new Promise((resolve) => setTimeout(resolve, 100)); await writeFile(${JSON.stringify(descendantPid)}, String(descendant.pid)); setInterval(() => {}, 1000);`,
  );
  const startup = requireClient().startAppServer({
    codexBinary: binary,
    codexHome: join(root, "home"),
    productVersion: "0.1.0",
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 300,
  });
  const observed = startup.then(
    () => ({ value: "resolved" }),
    (error) => ({ error }),
  );
  let pid;
  try {
    pid = await readPositivePid(descendantPid);
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
    const outcome = await Promise.race([
      observed,
      new Promise((resolve) =>
        setTimeout(() => resolve({ value: "bounded-timeout" }), 1200),
      ),
    ]);
    assert.equal(outcome.error?.code, "APP_SERVER_HANDSHAKE_TIMEOUT");
  } finally {
    const cleanupPid =
      Number.isSafeInteger(pid) && pid > 0
        ? pid
        : await readPositivePid(descendantPid);
    if (cleanupPid !== undefined) {
      try {
        process.kill(cleanupPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await observed;
    await rm(root, { recursive: true, force: true });
  }
});

test("handles an app-server spawn error without hanging", async () => {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-spawn-error-"));
  const binary = join(root, "codex");
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then rm "$0"; echo 'codex-cli 0.152.1'; fi\n`,
    { mode: 0o700 },
  );
  try {
    const startup = requireClient().startAppServer({
      codexBinary: binary,
      codexHome: join(root, "home"),
      productVersion: "0.1.0",
      handshakeTimeoutMs: 300,
      requestTimeoutMs: 300,
    });
    await assert.rejects(
      Promise.race([
        startup,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("spawn error did not settle")),
            500,
          ),
        ),
      ]),
      errorCode("APP_SERVER_START_FAILED"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turns notify write failure into the stable first terminal error", async () => {
  await withProtocolChild(
    `import { closeSync } from "node:fs"; closeSync(0); setTimeout(() => process.stdout.write(JSON.stringify({ method: "ready" }) + "\\n"), 20); setInterval(() => {}, 1000);`,
    async (child) => {
      const transport = new (requireTransport().StdioJsonRpcTransport)(
        child,
        300,
      );
      await new Promise((resolve) => transport.onNotification(resolve));
      transport.markReady();
      let firstFailure;
      await assert.rejects(transport.notify("test/notify", {}), (error) => {
        firstFailure = error;
        assert.equal(error.code, "APP_SERVER_START_FAILED");
        return true;
      });
      await assert.rejects(transport.notify("test/again", {}), (error) => {
        assert.strictEqual(error, firstFailure);
        return true;
      });
      await transport.close();
    },
  );
});

for (const [kind, frame] of [
  ["notification", { method: "test/notification", params: {} }],
  [
    "request",
    { method: "item/tool/requestUserInput", id: "server-1", params: {} },
  ],
]) {
  test(`makes rejected async ${kind} listeners terminal without an unhandled rejection`, async () => {
    await withProtocolChild(
      `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(frame) + "\n")}), 20); setInterval(() => {}, 1000);`,
      async (child) => {
        const transport = new (requireTransport().StdioJsonRpcTransport)(
          child,
          100,
        );
        transport.markReady();
        let resolveInvoked;
        const invoked = new Promise((resolve) => {
          resolveInvoked = resolve;
        });
        let rejectListener;
        let listenerResult;
        if (kind === "notification") {
          let pendingError;
          listenerResult = {
            then(_resolve, reject) {
              rejectListener = reject;
              if (pendingError) reject(pendingError);
            },
          };
          rejectListener = (error) => {
            pendingError = error;
          };
        } else {
          listenerResult = new Promise((_, reject) => {
            rejectListener = reject;
          });
          listenerResult.catch(() => {});
        }
        const listen = () => {
          resolveInvoked();
          return listenerResult;
        };
        if (kind === "notification") transport.onNotification(listen);
        else transport.onRequest(listen);
        await invoked;
        rejectListener(new Error("listener failed"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await assert.rejects(
          transport.request("thread/start", {}),
          errorCode("MALFORMED_PROTOCOL"),
        );
        await transport.close();
      },
    );
  });
}

test("the App Server child receives exactly the variables its capability set earns", async () => {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-child-env-"));
  const codexBin = join(root, "codex");
  const dump = join(root, "child-env.json");
  // Answers the version probe, then records its whole environment and exits.
  // The handshake therefore fails, which is fine: the spawn has already
  // happened and the file is what this test reads.
  await writeFile(codexBin, `#!${process.execPath}
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { process.stdout.write("codex-cli " + ${JSON.stringify(REQUIRED_CODEX_VERSION)} + "\\n"); process.exit(0); }
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));
process.exit(9);
`, { mode: 0o700 });
  const base = { codexBinary: codexBin, codexHome: join(root, "codex-home"), productVersion: "0.1.0", handshakeTimeoutMs: 2_000, requestTimeoutMs: 2_000 };
  // macOS adds this to every child regardless of the env passed to spawn, so
  // it is platform noise rather than something the product supplies. Every
  // other key in the child has to be one this code put there.
  const platformInjected = new Set(["__CF_USER_TEXT_ENCODING"]);
  const childEnv = async (input) => {
    await rm(dump, { force: true });
    await assert.rejects(requireClient().startAppServer(input));
    const env = JSON.parse(await readFile(dump, "utf8"));
    return { env, supplied: Object.keys(env).filter((key) => !platformInjected.has(key)).sort() };
  };
  try {
    const disabled = await childEnv(base);
    assert.deepEqual(disabled.supplied, ["CODEX_HOME", "PATH"]);
    assert.equal(disabled.env.CODEX_HOME, base.codexHome);
    assert.equal(Object.hasOwn(disabled.env, "LLM_WIKI_ROOT"), false);

    const enabled = await childEnv({ ...base, llmWikiRoot: "/fixture/wiki" });
    assert.deepEqual(enabled.supplied, ["CODEX_HOME", "LLM_WIKI_ROOT", "PATH"]);
    assert.equal(enabled.env.LLM_WIKI_ROOT, "/fixture/wiki");

    // The environment is constructed, never inherited: a variable set on this
    // process must not appear in the child even when the capability is on.
    process.env.ANDREW_AGENT_CHILD_ENV_CANARY = "leaked";
    try {
      const canaried = await childEnv({ ...base, llmWikiRoot: "/fixture/wiki" });
      assert.equal(Object.hasOwn(canaried.env, "ANDREW_AGENT_CHILD_ENV_CANARY"), false);
    } finally {
      delete process.env.ANDREW_AGENT_CHILD_ENV_CANARY;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
