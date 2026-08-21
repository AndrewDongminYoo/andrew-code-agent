import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const transportModule = await import(
  "../../dist/app-server/transport.js"
).catch(() => null);
const clientModule = await import("../../dist/app-server/client.js").catch(
  () => null,
);

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

function errorCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
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

test("rejects an oversized newline-free protocol line and reaps the child", async () => {
  await withProtocolChild(
    `process.stdout.write("x".repeat(65537)); setInterval(() => {}, 1000);`,
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
      assert.doesNotMatch(String(failure), /xxx/u);
      assert.notEqual(child.exitCode ?? child.signalCode, null);
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
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.148.0'; else exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'; fi\n`,
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
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli 0.148.0'; else exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}; fi\n`,
    { mode: 0o700 },
  );
  await writeFile(
    server,
    `import { spawn } from "node:child_process"; import { writeFile } from "node:fs/promises"; const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); await writeFile(${JSON.stringify(descendantPid)}, String(descendant.pid)); setInterval(() => {}, 1000);`,
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
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        pid = Number(await readFile(descendantPid, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(Number.isSafeInteger(pid), true);
    const outcome = await Promise.race([
      observed,
      new Promise((resolve) =>
        setTimeout(() => resolve({ value: "bounded-timeout" }), 1200),
      ),
    ]);
    assert.equal(outcome.error?.code, "APP_SERVER_HANDSHAKE_TIMEOUT");
  } finally {
    if (Number.isSafeInteger(pid)) {
      try {
        process.kill(pid, "SIGKILL");
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
    `#!/bin/sh\nif [ "$1" = "--version" ]; then rm "$0"; echo 'codex-cli 0.148.0'; fi\n`,
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
