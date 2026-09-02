import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

const coordinatorModule = await import(
  "../../dist/app-server/coordinator.js"
).catch(() => null);
const transportModule = await import(
  "../../dist/app-server/transport.js"
).catch(() => null);

function coordinator() {
  assert.notEqual(
    coordinatorModule,
    null,
    "the built app-server coordinator module must be available",
  );
  return coordinatorModule;
}

function transport() {
  assert.notEqual(
    transportModule,
    null,
    "the built app-server transport module must be available",
  );
  return transportModule;
}

function transportBackedClient(onMessage) {
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
  const rpc = new (transport().StdioJsonRpcTransport)(child, 300);
  rpc.markReady();
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    input += chunk;
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      onMessage(JSON.parse(line), child.stdout);
    }
  });
  return {
    threadStart: (params) => rpc.request("thread/start", params),
    threadResume: (params) => rpc.request("thread/resume", params),
    threadRead: (params) => rpc.request("thread/read", params),
    turnStart: (params) => rpc.request("turn/start", params),
    turnInterrupt: (params) => rpc.request("turn/interrupt", params),
    respond: (id, result) => rpc.respond(id, result),
    onNotification: (listener) => rpc.onNotification(listener),
    onRequest: (listener) => rpc.onRequest(listener),
    onFailure: (listener) => rpc.onFailure(listener),
    close: () => rpc.close(),
  };
}

function terminalNotification(threadId, turnId, status = "completed") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, itemsView: "full", items: [], status },
    },
  };
}

function mcpElicitationRequest(id, threadId, turnId) {
  return {
    method: "mcpServer/elicitation/request",
    id,
    params: {
      threadId,
      turnId,
      serverName: "fixture-server",
      mode: "url",
      _meta: null,
      message: "Open the fixture URL?",
      url: "https://example.invalid/fixture",
      elicitationId: "elicitation-1",
    },
  };
}

class FakeClient {
  calls = [];
  notifications = new Set();
  requests = new Set();
  failures = new Set();
  closed = 0;
  threadId = "thread-1";
  turnId = "turn-1";
  threadStatus = { type: "idle" };
  onTurnStart = null;
  onTurnInterrupt = null;

  async threadStart(params) {
    this.calls.push(["threadStart", params]);
    return { thread: { id: this.threadId } };
  }

  async threadResume(params) {
    this.calls.push(["threadResume", params]);
    return { thread: { id: this.threadId } };
  }

  async threadRead(params) {
    this.calls.push(["threadRead", params]);
    return { thread: { id: this.threadId, status: this.threadStatus } };
  }

  async turnStart(params) {
    this.calls.push(["turnStart", params]);
    await this.onTurnStart?.(this);
    return { turn: { id: this.turnId } };
  }

  async turnInterrupt(params) {
    this.calls.push(["turnInterrupt", params]);
    await this.onTurnInterrupt?.(this);
    return {};
  }

  async respond(id, result) {
    this.calls.push(["respond", id, result]);
  }

  onNotification(listener) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(listener) {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }

  onFailure(listener) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  emitNotification(message) {
    for (const listener of this.notifications) listener(message);
  }

  emitRequest(message) {
    for (const listener of this.requests) listener(message);
  }

  emitFailure(error) {
    for (const listener of this.failures) listener(error);
  }

  async close() {
    this.closed += 1;
    await this.onClose?.();
  }
}

function ttyInput(value = "1\n") {
  const input = Readable.from([value]);
  Object.defineProperty(input, "isTTY", { value: true });
  return input;
}

function existingRecord(overrides = {}) {
  return {
    threadId: "thread-1",
    repositoryRoot: "/repo",
    startingHead: "head-old",
    terminalHead: "head-old",
    bundleDigest: "bundle-old",
    productVersion: "0.0.9",
    codexVersion: "0.147.0",
    turnId: "turn-old",
    terminalStatus: "completed",
    finalGitStatus: "",
    ...overrides,
  };
}

function harness(overrides = {}) {
  const client = overrides.client ?? new FakeClient();
  const order = [];
  const writes = [];
  const states = [];
  let stored = overrides.record ?? existingRecord();
  let interruptListener = null;
  const snapshots = overrides.snapshots ?? [
    {
      repositoryRoot: "/repo",
      head: "head-new",
      porcelainV2: "",
      clean: true,
    },
    {
      repositoryRoot: "/repo",
      head: "head-final",
      porcelainV2: "? changed.txt\n",
      clean: false,
    },
  ];
  let snapshotIndex = 0;
  const dependencies = {
    client,
    stateRoot: "/state",
    git: {
      async resolveRepositoryRoot(value) {
        order.push(`resolve:${value}`);
        await overrides.onResolve?.(value);
        return overrides.resolvedRepository ?? "/repo";
      },
      async readGitSnapshot(value) {
        order.push(`snapshot:${value}`);
        const valueAtIndex = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return valueAtIndex;
      },
      assertCleanGitSnapshot(snapshot) {
        order.push("clean");
        if (!snapshot.clean) {
          const error = new Error("dirty");
          error.code = "GIT_WORKTREE_DIRTY";
          throw error;
        }
        return snapshot;
      },
    },
    threadStore: {
      async readThreadRecord(stateRoot, threadId) {
        assert.equal(stateRoot, "/state");
        order.push(`read:${threadId}`);
        if (overrides.readError) throw overrides.readError;
        return structuredClone(stored);
      },
      async writeThreadRecord(stateRoot, record) {
        assert.equal(stateRoot, "/state");
        order.push(`write:${record.terminalStatus}`);
        if (overrides.writeError) throw overrides.writeError;
        stored = structuredClone(record);
        writes.push(structuredClone(record));
      },
    },
    releaseIdentity: {
      bundleDigest: "bundle-new",
      productVersion: "0.1.0",
      codexVersion: "0.148.0",
    },
    approvalInput: overrides.approvalInput ?? ttyInput(),
    approvalWriter: overrides.approvalWriter ?? { async writePrompt() {} },
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? 50,
    subscribeInterrupt(listener) {
      interruptListener = listener;
      order.push("subscribeInterrupt");
      return () => {
        interruptListener = null;
        order.push("unsubscribeInterrupt");
      };
    },
    interruptGraceMs: overrides.interruptGraceMs ?? 30,
    async reportThreadId(threadId) {
      order.push(`report:${threadId}`);
      if (overrides.reportError) throw overrides.reportError;
      for (let count = 0; count < (overrides.interruptsOnReport ?? 0); count += 1)
        interruptListener?.();
    },
    async reportTurnState(state) {
      states.push(state);
      order.push(`state:${state.terminalStatus}`);
      if (overrides.reportStateError) throw overrides.reportStateError;
    },
  };
  return {
    client,
    dependencies,
    order,
    writes,
    states,
    interrupt() {
      assert.notEqual(interruptListener, null);
      interruptListener();
    },
    stored: () => stored,
  };
}

test("starts only after durable identity reporting and persists authoritative terminal Git state", async () => {
  const fixture = harness({ record: null });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification(
      terminalNotification(client.threadId, client.turnId, "completed"),
    );
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/input", prompt: "ship it", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.deepEqual(
    fixture.order.slice(0, 7),
    [
      "subscribeInterrupt",
      "resolve:/input",
      "snapshot:/repo",
      "clean",
      "write:not-started",
      "report:thread-1",
      "write:running",
    ],
  );
  assert.deepEqual(fixture.client.calls.slice(0, 2), [
    [
      "threadStart",
      {
        cwd: "/repo",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    ],
    [
      "turnStart",
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "ship it", text_elements: [] }],
        cwd: "/repo",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ],
  ]);
  assert.equal(fixture.writes[0].terminalStatus, "not-started");
  assert.equal(fixture.writes[0].turnId, null);
  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.terminalHead, "head-final");
  assert.equal(result.finalGitStatus, "? changed.txt\n");
  assert.equal(fixture.states.at(-1).terminalStatus, "completed");
  assert.equal(fixture.client.closed, 1);
  assert.equal(fixture.client.notifications.size, 0);
  assert.equal(fixture.client.requests.size, 0);
});

test("does not start a turn when durable identity write or reporting fails", async () => {
  for (const failure of ["write", "report"]) {
    const error = Object.assign(new Error(failure), { code: "THREAD_STORE_UNSAFE" });
    const fixture = harness({
      record: null,
      ...(failure === "write" ? { writeError: error } : { reportError: error }),
    });
    await assert.rejects(
      coordinator().startNewThread(
        { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
        fixture.dependencies,
      ),
      { code: "THREAD_STORE_UNSAFE" },
    );
    assert.equal(
      fixture.client.calls.some(([method]) => method === "turnStart"),
      false,
    );
    assert.equal(fixture.client.closed, 1);
  }
});

test("resumes exact metadata on a new clean HEAD and leaves promptless metadata untouched", async () => {
  const prompted = harness();
  prompted.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification(client.threadId, client.turnId));
  };
  const result = await coordinator().resumeThread(
    "thread-1",
    "continue",
    prompted.dependencies,
  );
  assert.deepEqual(prompted.client.calls.slice(0, 2), [
    [
      "threadResume",
      {
        threadId: "thread-1",
        cwd: "/repo",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    ],
    [
      "turnStart",
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue", text_elements: [] }],
        cwd: "/repo",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    ],
  ]);
  assert.equal(result.startingHead, "head-new");
  assert.equal(result.bundleDigest, "bundle-new");
  assert.equal(result.productVersion, "0.1.0");
  assert.equal(result.codexVersion, "0.148.0");

  const promptless = harness();
  const original = promptless.stored();
  const unchanged = await coordinator().resumeThread(
    "thread-1",
    undefined,
    promptless.dependencies,
  );
  assert.deepEqual(unchanged, original);
  assert.deepEqual(promptless.client.calls, [
    [
      "threadResume",
      {
        threadId: "thread-1",
        cwd: "/repo",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    ],
  ]);
  assert.equal(promptless.writes.length, 0);
  assert.equal(promptless.client.closed, 1);
});

test("finalizes forced pre-response resume interruption but preserves ordinary resume RPC failure", async () => {
  const forced = harness();
  forced.client.threadResume = async function (params) {
    this.calls.push(["threadResume", params]);
    queueMicrotask(() => {
      forced.interrupt();
      forced.interrupt();
    });
    return await new Promise((_, reject) => {
      this.rejectPendingResume = reject;
    });
  };
  forced.client.onClose = async () => {
    forced.client.rejectPendingResume?.(
      Object.assign(new Error("closed"), { code: "APP_SERVER_CLOSED" }),
    );
  };
  const result = await coordinator().resumeThread(
    "thread-1",
    "continue",
    forced.dependencies,
  );
  assert.equal(result.turnId, null);
  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(result.startingHead, "head-new");
  assert.equal(result.bundleDigest, "bundle-new");
  assert.equal(result.productVersion, "0.1.0");
  assert.equal(result.codexVersion, "0.148.0");
  assert.equal(result.terminalHead, "head-final");
  assert.equal(result.finalGitStatus, "? changed.txt\n");
  assert.equal(forced.client.closed, 1);
  assert.equal(
    forced.client.calls.some(([method]) => method === "turnStart"),
    false,
  );
  assert.deepEqual(
    forced.writes.map((record) => record.terminalStatus),
    ["interrupted"],
  );

  const ordinary = harness();
  const original = ordinary.stored();
  ordinary.client.threadResume = async function (params) {
    this.calls.push(["threadResume", params]);
    throw Object.assign(new Error("rpc"), { code: "APP_SERVER_REMOTE_ERROR" });
  };
  await assert.rejects(
    coordinator().resumeThread("thread-1", "continue", ordinary.dependencies),
    { code: "APP_SERVER_REMOTE_ERROR" },
  );
  assert.deepEqual(ordinary.stored(), original);
  assert.equal(ordinary.writes.length, 0);
  assert.equal(ordinary.client.closed, 1);
});

test("returns validated live status snapshots without mutating the local record", async () => {
  for (const [status, expected] of [
    [{ type: "idle" }, { type: "idle" }],
    [{ type: "notLoaded" }, { type: "notLoaded" }],
    [{ type: "systemError" }, { type: "systemError" }],
    [
      { type: "active", activeFlags: ["waitingOnApproval"] },
      { type: "active" },
    ],
  ]) {
    const fixture = harness();
    fixture.client.threadStatus = status;
    const original = fixture.stored();
    const result = await coordinator().readLiveStatus(
      "thread-1",
      fixture.dependencies,
    );
    assert.deepEqual(result, { record: original, liveStatus: expected });
    assert.notStrictEqual(result.record, original);
    assert.notStrictEqual(result.liveStatus, status);
    assert.deepEqual(fixture.client.calls, [
      ["threadRead", { threadId: "thread-1", includeTurns: false }],
    ]);
    assert.equal(fixture.writes.length, 0);
    assert.equal(
      fixture.order.some((entry) => entry.startsWith("snapshot:")),
      false,
    );
    assert.deepEqual(fixture.stored(), original);
    assert.equal(fixture.client.closed, 1);
  }
});

test("rejects malformed, hostile, inherited, and identity-mismatched live status", async () => {
  let activeFlagGetterCalls = 0;
  const cases = [
    { name: "unknown", status: { type: "unknown" } },
    { name: "missing active flags", status: { type: "active" } },
    {
      name: "accessor",
      status: Object.defineProperty({}, "type", { get: () => "idle" }),
    },
    {
      name: "inherited",
      status: Object.create({ type: "idle" }),
    },
    {
      name: "proxy",
      status: new Proxy({ type: "idle" }, {}),
    },
    {
      name: "active flags accessor",
      status: {
        type: "active",
        activeFlags: Object.defineProperty([], "0", {
          enumerable: true,
          get() {
            activeFlagGetterCalls += 1;
            return "waitingOnApproval";
          },
        }),
      },
    },
  ];
  for (const fixtureCase of cases) {
    const fixture = harness();
    fixture.client.threadStatus = fixtureCase.status;
    const original = fixture.stored();
    await assert.rejects(
      coordinator().readLiveStatus("thread-1", fixture.dependencies),
      { code: "MALFORMED_APP_SERVER_RESPONSE" },
      fixtureCase.name,
    );
    assert.deepEqual(fixture.stored(), original, fixtureCase.name);
    assert.equal(fixture.writes.length, 0, fixtureCase.name);
  }
  assert.equal(activeFlagGetterCalls, 0);

  const mismatch = harness();
  mismatch.client.threadId = "other-thread";
  await assert.rejects(
    coordinator().readLiveStatus("thread-1", mismatch.dependencies),
    { code: "APP_SERVER_IDENTITY_MISMATCH" },
  );
});

test("rejects hostile response and thread containers without invoking traps or getters", async () => {
  let trapCalls = 0;
  let getterCalls = 0;
  const proxyHandler = {
    get(_target, property) {
      if (property === "then") return undefined;
      trapCalls += 1;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      return undefined;
    },
    getPrototypeOf() {
      trapCalls += 1;
      return Object.prototype;
    },
  };
  const liveResponseProxy = new Proxy({}, proxyHandler);
  const liveThreadProxy = new Proxy({}, proxyHandler);
  const { proxy: revokedResponseProxy, revoke: revokeResponse } =
    Proxy.revocable({}, proxyHandler);
  const { proxy: revokedThreadProxy, revoke: revokeThread } = Proxy.revocable(
    {},
    proxyHandler,
  );
  revokeResponse();
  revokeThread();
  const validThread = { id: "thread-1", status: { type: "idle" } };
  const cases = [
    {
      name: "response custom prototype",
      response: Object.assign(Object.create({ inherited: true }), {
        thread: validThread,
      }),
    },
    {
      name: "response inherited thread",
      response: Object.create({ thread: validThread }),
    },
    {
      name: "response accessor",
      response: Object.defineProperty({}, "thread", {
        get() {
          getterCalls += 1;
          return validThread;
        },
      }),
    },
    { name: "response live proxy", response: liveResponseProxy },
    { name: "response revoked proxy", response: revokedResponseProxy },
    {
      name: "thread custom prototype",
      response: {
        thread: Object.assign(Object.create({ inherited: true }), validThread),
      },
    },
    {
      name: "thread inherited state",
      response: { thread: Object.create(validThread) },
    },
    {
      name: "thread accessor",
      response: {
        thread: Object.defineProperties(
          {},
          {
            id: { enumerable: true, value: "thread-1" },
            status: {
              get() {
                getterCalls += 1;
                return { type: "idle" };
              },
            },
          },
        ),
      },
    },
    { name: "thread live proxy", response: { thread: liveThreadProxy } },
    { name: "thread revoked proxy", response: { thread: revokedThreadProxy } },
  ];

  for (const fixtureCase of cases) {
    const fixture = harness();
    fixture.client.threadRead = async function (params) {
      this.calls.push(["threadRead", params]);
      return fixtureCase.response;
    };
    await assert.rejects(
      coordinator().readLiveStatus("thread-1", fixture.dependencies),
      { code: "MALFORMED_APP_SERVER_RESPONSE" },
      fixtureCase.name,
    );
  }
  assert.equal(trapCalls, 0);
  assert.equal(getterCalls, 0);
});

test("rejects hostile response operations before then traps can forge authority", async () => {
  let thenTrapCalls = 0;
  let errorTrapCalls = 0;
  const hostile = harness();
  hostile.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            thenTrapCalls += 1;
            throw Object.assign(new Error("hostile assimilation"), {
              code: "APP_SERVER_REMOTE_ERROR",
            });
          }
          return undefined;
        },
      },
    );
  };

  await assert.rejects(
    coordinator().readLiveStatus("thread-1", hostile.dependencies),
    (error) => {
      assert.equal(error.name, "CoordinatorError");
      assert.equal(error.code, "MALFORMED_APP_SERVER_RESPONSE");
      assert.equal(error.message, "MALFORMED_APP_SERVER_RESPONSE");
      return true;
    },
  );
  assert.equal(thenTrapCalls, 0);

  const proxiedFailure = harness();
  const hostileError = new Proxy(
    Object.assign(new Error("hostile error"), {
      code: "APP_SERVER_REMOTE_ERROR",
    }),
    {
      getPrototypeOf() {
        errorTrapCalls += 1;
        throw new Error("error prototype trap");
      },
    },
  );
  proxiedFailure.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") throw hostileError;
          return undefined;
        },
      },
    );
  };
  await assert.rejects(
    coordinator().readLiveStatus("thread-1", proxiedFailure.dependencies),
    { code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
  assert.equal(errorTrapCalls, 0);
});

test("rejects a Proxy threadRead operation before assimilating a typed trap failure", async () => {
  let thenTrapCalls = 0;
  const fixture = harness();
  fixture.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            thenTrapCalls += 1;
            throw new (transport().AppServerError)("APP_SERVER_REMOTE_ERROR");
          }
          return undefined;
        },
      },
    );
  };

  await assert.rejects(
    coordinator().readLiveStatus("thread-1", fixture.dependencies),
    { code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
  assert.equal(thenTrapCalls, 0);
});

test("rejects a plain thenable before it can throw a typed failure", async () => {
  let thenCalls = 0;
  const fixture = harness();
  fixture.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return {
      then() {
        thenCalls += 1;
        throw new (transport().AppServerError)("APP_SERVER_REMOTE_ERROR");
      },
    };
  };

  const outcome = await coordinator()
    .readLiveStatus("thread-1", fixture.dependencies)
    .then(
      () => ({ code: "TEST_RESOLVED" }),
      (error) => error,
    );
  assert.deepEqual(
    { thenCalls, code: outcome.code },
    { thenCalls: 0, code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
});

test("rejects an accessor-backed thenable response without invoking its getter", async () => {
  let getterCalls = 0;
  const fixture = harness();
  fixture.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return Object.defineProperty(
      { thread: { id: "thread-1", status: { type: "idle" } } },
      "then",
      {
        get() {
          getterCalls += 1;
          return undefined;
        },
      },
    );
  };

  const outcome = await coordinator()
    .readLiveStatus("thread-1", fixture.dependencies)
    .then(
      () => ({ code: "TEST_RESOLVED" }),
      (error) => error,
    );
  assert.deepEqual(
    { getterCalls, code: outcome.code },
    { getterCalls: 0, code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
});

test("rejects a Promise subclass without invoking its own then getter", async () => {
  let getterCalls = 0;
  class HostilePromise extends Promise {}
  const operation = new HostilePromise((resolve) =>
    resolve({ thread: { id: "thread-1", status: { type: "idle" } } }),
  );
  Object.defineProperty(operation, "then", {
    get() {
      getterCalls += 1;
      throw new (transport().AppServerError)("APP_SERVER_REMOTE_ERROR");
    },
  });
  const fixture = harness();
  fixture.client.threadRead = function (params) {
    this.calls.push(["threadRead", params]);
    return operation;
  };

  const outcome = await coordinator()
    .readLiveStatus("thread-1", fixture.dependencies)
    .then(
      () => ({ code: "TEST_RESOLVED" }),
      (error) => error,
    );
  assert.deepEqual(
    { getterCalls, code: outcome.code },
    { getterCalls: 0, code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
});

test("preserves an actual runtime AppServerError by identity", async () => {
  const typed = harness();
  const remoteError = new (transport().AppServerError)(
    "APP_SERVER_REMOTE_ERROR",
  );
  typed.client.threadRead = async function (params) {
    this.calls.push(["threadRead", params]);
    throw remoteError;
  };
  await assert.rejects(
    coordinator().readLiveStatus("thread-1", typed.dependencies),
    (error) => error === remoteError,
  );
});

test("real transport defers a response-following burst until coordinator turn state exists", async () => {
  const warnings = Array.from({ length: 300 }, (_, sequence) => ({
    method: "warning",
    params: { threadId: "thread-1", message: `warning-${sequence}` },
  }));
  const client = transportBackedClient((message, stdout) => {
    if (message.method === "thread/start") {
      queueMicrotask(() =>
        stdout.write(
          `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-1" } } })}\n`,
        ),
      );
      return;
    }
    if (message.method === "turn/start") {
      const frames = [
        { id: message.id, result: { turn: { id: "turn-1" } } },
        ...warnings,
        terminalNotification("thread-1", "turn-1"),
      ];
      queueMicrotask(() =>
        stdout.write(
          `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
        ),
      );
      return;
    }
    if (message.method === "turn/interrupt")
      queueMicrotask(() =>
        stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`),
      );
  });
  const fixture = harness({ record: null, client, interruptGraceMs: 5 });

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "completed");
  assert.deepEqual(
    fixture.states.at(-1).warnings,
    warnings.slice(0, 16).map(({ params }) => params.message),
  );
  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started", "running", "completed"],
  );
});

test("accepts a schema-valid response-following burst but caps genuine pre-response events", async () => {
  const responseFollowing = harness({ record: null });
  responseFollowing.client.onTurnStart = async (client) => {
    setImmediate(() => {
      for (let sequence = 0; sequence < 300; sequence += 1) {
        client.emitNotification({
          method: "warning",
          params: { threadId: "thread-1", message: `warning-${sequence}` },
        });
      }
      client.emitNotification(terminalNotification("thread-1", "turn-1"));
    });
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    responseFollowing.dependencies,
  );
  assert.equal(result.terminalStatus, "completed");
  assert.deepEqual(
    responseFollowing.writes.map((record) => record.terminalStatus),
    ["not-started", "running", "completed"],
  );

  const preResponse = harness({ record: null, interruptGraceMs: 5 });
  preResponse.client.onTurnStart = async (client) => {
    for (let sequence = 0; sequence < 257; sequence += 1) {
      client.emitNotification({
        method: "warning",
        params: { threadId: "thread-1", message: `warning-${sequence}` },
      });
    }
  };
  const capped = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    preResponse.dependencies,
  );
  assert.equal(capped.terminalStatus, "failed");
  assert.deepEqual(
    preResponse.writes.map((record) => record.terminalStatus),
    ["not-started", "running", "failed"],
  );
});

test("fails before server mutation for digest mismatch, dirty state, or replaced repository", async () => {
  const digest = harness({ record: null });
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "wrong" },
      digest.dependencies,
    ),
    { code: "BUNDLE_DIGEST_MISMATCH" },
  );
  assert.equal(digest.client.calls.length, 0);

  const dirty = harness({
    record: null,
    snapshots: [
      { repositoryRoot: "/repo", head: "h", porcelainV2: "? x", clean: false },
    ],
  });
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      dirty.dependencies,
    ),
    { code: "GIT_WORKTREE_DIRTY" },
  );
  assert.equal(dirty.client.calls.length, 0);

  const replaced = harness({ resolvedRepository: "/replacement" });
  await assert.rejects(
    coordinator().resumeThread("thread-1", "x", replaced.dependencies),
    { code: "THREAD_REPOSITORY_MISMATCH" },
  );
  assert.equal(replaced.client.calls.length, 0);
});

test("rejects preflight snapshots from a different canonical repository", async () => {
  const start = harness({
    record: null,
    resolvedRepository: "/canonical-a",
    snapshots: [
      {
        repositoryRoot: "/canonical-b",
        head: "head-new",
        porcelainV2: "",
        clean: true,
      },
    ],
  });
  start.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification("thread-1", "turn-1"));
  };
  await assert.rejects(
    coordinator().startNewThread(
      {
        repositoryRoot: "/input",
        prompt: "x",
        bundleDigest: "bundle-new",
      },
      start.dependencies,
    ),
    { code: "THREAD_REPOSITORY_MISMATCH" },
  );
  assert.equal(start.client.calls.length, 0);
  assert.equal(start.writes.length, 0);

  const resume = harness({
    record: existingRecord({ repositoryRoot: "/canonical-a" }),
    resolvedRepository: "/canonical-a",
    snapshots: [
      {
        repositoryRoot: "/canonical-b",
        head: "head-new",
        porcelainV2: "",
        clean: true,
      },
    ],
  });
  resume.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification("thread-1", "turn-1"));
  };
  await assert.rejects(
    coordinator().resumeThread("thread-1", "continue", resume.dependencies),
    { code: "THREAD_REPOSITORY_MISMATCH" },
  );
  assert.equal(resume.client.calls.length, 0);
  assert.equal(resume.writes.length, 0);
});

test("rejects a terminal snapshot from a replaced repository without terminal persistence", async () => {
  const fixture = harness({
    record: null,
    snapshots: [
      {
        repositoryRoot: "/repo",
        head: "head-new",
        porcelainV2: "",
        clean: true,
      },
      {
        repositoryRoot: "/replacement",
        head: "replacement-head",
        porcelainV2: "",
        clean: true,
      },
    ],
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification("thread-1", "turn-1"));
  };

  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    ),
    { code: "THREAD_REPOSITORY_MISMATCH" },
  );
  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started", "running"],
  );
  assert.equal(fixture.client.closed, 1);
});

test("snapshots mutable run request fields before the first await", async (t) => {
  for (const field of ["prompt", "bundleDigest", "repositoryRoot"]) {
    await t.test(field, async () => {
      const request = {
        repositoryRoot: "/input-original",
        prompt: "prompt-original",
        bundleDigest: "bundle-new",
      };
      const mutated = {
        prompt: "prompt-mutated",
        bundleDigest: "bundle-mutated",
        repositoryRoot: "/input-mutated",
      };
      const fixture = harness({
        record: null,
        async onResolve() {
          await Promise.resolve();
          request[field] = mutated[field];
        },
      });
      fixture.client.onTurnStart = async (client) => {
        client.emitNotification(terminalNotification("thread-1", "turn-1"));
      };

      const result = await coordinator().startNewThread(
        request,
        fixture.dependencies,
      );

      assert.equal(result.bundleDigest, "bundle-new");
      assert.equal(fixture.order.includes("resolve:/input-original"), true);
      assert.deepEqual(
        fixture.client.calls.find(([method]) => method === "turnStart")[1]
          .input,
        [
          {
            type: "text",
            text: "prompt-original",
            text_elements: [],
          },
        ],
      );
    });
  }
});

test("answers approvals once and fail-closes unsupported requests without inventing a response", async () => {
  const accepted = harness({ record: null });
  accepted.client.onTurnStart = async (client) => {
    client.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: "request-command",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    });
    setTimeout(
      () => client.emitNotification(terminalNotification("thread-1", "turn-1")),
      10,
    );
  };
  await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    accepted.dependencies,
  );
  assert.deepEqual(
    accepted.client.calls.filter(([method]) => method === "respond"),
    [["respond", "request-command", { decision: "accept" }]],
  );

  const failed = harness({ record: null });
  failed.client.onTurnStart = async (client) => {
    client.emitRequest({ method: "unknown/request", id: "bad", params: {} });
  };
  failed.client.onTurnInterrupt = async (client) => {
    queueMicrotask(() =>
      client.emitNotification(
        terminalNotification("thread-1", "turn-1", "completed"),
      ),
    );
  };
  const failedResult = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    failed.dependencies,
  );
  assert.equal(failedResult.terminalStatus, "failed");
  assert.equal(
    failed.client.calls.some(([method]) => method === "respond"),
    false,
  );
  assert.equal(
    failed.client.calls.filter(([method]) => method === "turnInterrupt").length,
    1,
  );
});

test("allows null-turn MCP elicitation only for the active thread", async (t) => {
  await t.test("declines a null-turn elicitation and preserves the later terminal result", async () => {
    const fixture = harness({ record: null });
    fixture.client.onTurnStart = async (client) => {
      client.emitRequest(
        mcpElicitationRequest("request-null-turn", "thread-1", null),
      );
      setTimeout(
        () =>
          client.emitNotification(
            terminalNotification("thread-1", "turn-1", "completed"),
          ),
        10,
      );
    };

    const result = await coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    );

    assert.equal(result.terminalStatus, "completed");
    assert.deepEqual(
      fixture.client.calls.filter(([method]) => method === "respond"),
      [
        [
          "respond",
          "request-null-turn",
          { action: "decline", content: null, _meta: null },
        ],
      ],
    );
    assert.equal(
      fixture.client.calls.some(([method]) => method === "turnInterrupt"),
      false,
    );
  });

  for (const [name, threadId, turnId] of [
    ["mismatched thread", "other-thread", null],
    ["mismatched non-null turn", "thread-1", "other-turn"],
  ]) {
    await t.test(name, async () => {
      const fixture = harness({ record: null, interruptGraceMs: 5 });
      fixture.client.onTurnStart = async (client) => {
        client.emitRequest(
          mcpElicitationRequest(`request-${name}`, threadId, turnId),
        );
        setTimeout(
          () =>
            client.emitNotification(
              terminalNotification("thread-1", "turn-1", "completed"),
            ),
          20,
        );
      };

      const result = await coordinator().startNewThread(
        { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
        fixture.dependencies,
      );

      assert.equal(result.terminalStatus, "failed");
      assert.equal(
        fixture.client.calls.some(([method]) => method === "respond"),
        false,
      );
      assert.equal(
        fixture.client.calls.filter(([method]) => method === "turnInterrupt")
          .length,
        1,
      );
    });
  }
});

test("fails closed when a long MCP thread ID collides with its bounded audit value", async () => {
  const auditPrefix = "t".repeat(244);
  const activeThreadId = `${auditPrefix} [truncated]`;
  const distinctLongThreadId = `${auditPrefix}-different-thread`;
  const fixture = harness({ record: null, interruptGraceMs: 5 });
  fixture.client.threadId = activeThreadId;
  fixture.client.onTurnStart = async (client) => {
    client.emitRequest(
      mcpElicitationRequest(
        "request-colliding-thread",
        distinctLongThreadId,
        null,
      ),
    );
    setTimeout(
      () =>
        client.emitNotification(
          terminalNotification(activeThreadId, "turn-1", "completed"),
        ),
      20,
    );
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "failed");
  assert.equal(
    fixture.client.calls.some(([method]) => method === "respond"),
    false,
  );
  assert.equal(
    fixture.client.calls.filter(([method]) => method === "turnInterrupt")
      .length,
    1,
  );
});

test("fails closed when a long MCP turn ID collides with its bounded audit value", async () => {
  const auditPrefix = "u".repeat(244);
  const activeTurnId = `${auditPrefix} [truncated]`;
  const distinctLongTurnId = `${auditPrefix}-different-turn`;
  const fixture = harness({ record: null, interruptGraceMs: 5 });
  fixture.client.turnId = activeTurnId;
  fixture.client.onTurnStart = async (client) => {
    client.emitRequest(
      mcpElicitationRequest(
        "request-colliding-turn",
        "thread-1",
        distinctLongTurnId,
      ),
    );
    setTimeout(
      () =>
        client.emitNotification(
          terminalNotification("thread-1", activeTurnId, "completed"),
        ),
      20,
    );
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "failed");
  assert.equal(
    fixture.client.calls.some(([method]) => method === "respond"),
    false,
  );
  assert.equal(
    fixture.client.calls.filter(([method]) => method === "turnInterrupt")
      .length,
    1,
  );
});

test("fails closed when a later nested Proxy hook mutates MCP correlation to the active turn", async () => {
  const fixture = harness({ record: null, interruptGraceMs: 5 });
  fixture.client.onTurnStart = async (client) => {
    const request = mcpElicitationRequest(
      "request-mutated-correlation",
      "other-thread",
      "other-turn",
    );
    let validationPasses = 0;
    request.params._meta = new Proxy(
      {},
      {
        getPrototypeOf() {
          validationPasses += 1;
          if (validationPasses === 2) {
            request.params.threadId = "thread-1";
            request.params.turnId = "turn-1";
          }
          return Object.prototype;
        },
      },
    );
    client.emitRequest(request);
    setTimeout(
      () =>
        client.emitNotification(
          terminalNotification("thread-1", "turn-1", "completed"),
        ),
      20,
    );
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "failed");
  assert.equal(
    fixture.client.calls.some(([method]) => method === "respond"),
    false,
  );
  assert.equal(
    fixture.client.calls.filter(([method]) => method === "turnInterrupt")
      .length,
    1,
  );
});

test("fails closed for wrong approval identity and malformed turn response", async () => {
  const wrongIdentity = harness({ record: null, interruptGraceMs: 5 });
  wrongIdentity.client.onTurnStart = async (client) => {
    client.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: "wrong-thread-request",
      params: {
        threadId: "other-thread",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    });
    setTimeout(
      () => client.emitNotification(terminalNotification("thread-1", "turn-1")),
      20,
    );
  };
  const wrongResult = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    wrongIdentity.dependencies,
  );
  assert.equal(wrongResult.terminalStatus, "failed");
  assert.equal(
    wrongIdentity.client.calls.some(([method]) => method === "respond"),
    false,
  );

  const malformed = harness({ record: null });
  malformed.client.turnStart = async function (params) {
    this.calls.push(["turnStart", params]);
    return {};
  };
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      malformed.dependencies,
    ),
    { code: "MALFORMED_APP_SERVER_RESPONSE" },
  );
  assert.equal(malformed.client.closed, 1);
});

test("snapshots the original request ID before awaiting approval", async () => {
  let request;
  const fixture = harness({
    record: null,
    approvalWriter: {
      async writePrompt() {
        request.id = "redirected-request";
      },
    },
  });
  fixture.client.onTurnStart = async (client) => {
    request = {
      method: "item/commandExecution/requestApproval",
      id: "original-request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    };
    client.emitRequest(request);
    setTimeout(
      () => client.emitNotification(terminalNotification("thread-1", "turn-1")),
      10,
    );
  };

  await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.deepEqual(
    fixture.client.calls.filter(([method]) => method === "respond"),
    [["respond", "original-request", { decision: "accept" }]],
  );
});

test("does not answer an approval after force interruption settles", async () => {
  const fixture = harness({
    record: null,
    approvalWriter: {
      async writePrompt() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    },
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: "pending-request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    });
    setTimeout(() => {
      fixture.interrupt();
      fixture.interrupt();
    }, 1);
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(
    fixture.client.calls.some(([method]) => method === "respond"),
    false,
  );
});

test("App Server failure cancels an open approval and preserves the failure", async () => {
  const approvalInput = new PassThrough();
  Object.defineProperty(approvalInput, "isTTY", { value: true });
  approvalInput.pause();
  const failure = Object.assign(new Error("infrastructure"), {
    code: "APP_SERVER_UNEXPECTED_EXIT",
  });
  let fixture;
  fixture = harness({
    record: null,
    approvalInput,
    approvalTimeoutMs: 10_000,
    approvalWriter: {
      async writePrompt() {
        setImmediate(() => fixture.client.emitFailure(failure));
      },
    },
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: "pending-request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    });
  };
  const operation = coordinator()
    .startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const marker = Symbol("coordinator remained open");
  let outcome;
  try {
    outcome = await Promise.race([
      operation,
      new Promise((resolve) =>
        setImmediate(() => setImmediate(() => resolve(marker))),
      ),
    ]);
    assert.notEqual(outcome, marker);
    assert.strictEqual(outcome.error, failure);
    assert.equal(approvalInput.listenerCount("data"), 0);
    assert.equal(approvalInput.listenerCount("end"), 0);
    assert.equal(approvalInput.listenerCount("error"), 0);
    assert.equal(approvalInput.isPaused(), true);
    assert.equal(fixture.client.closed, 1);
  } finally {
    approvalInput.end();
    await operation;
  }
});

test("lets a terminal notification beat grace while approval interaction is pending", async () => {
  let fixture;
  fixture = harness({
    record: null,
    interruptGraceMs: 10,
    approvalWriter: {
      async writePrompt() {
        fixture.interrupt();
        fixture.client.emitNotification(
          terminalNotification("thread-1", "turn-1", "completed"),
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    },
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitRequest({
      method: "item/commandExecution/requestApproval",
      id: "pending-request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        startedAtMs: 1,
        environmentId: null,
        reason: "Needed",
        command: "pwd",
        cwd: "/repo",
        commandActions: [],
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: [],
      },
    });
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "completed");
  assert.equal(
    fixture.client.calls.some(([method]) => method === "respond"),
    false,
  );
  assert.equal(fixture.client.closed, 1);
  assert.equal(fixture.stored().terminalStatus, "completed");
});

test("persists an observed terminal notification before surfacing reporting failure", async () => {
  const reportError = Object.assign(new Error("renderer unavailable"), {
    code: "COMMAND_OUTPUT_FAILED",
  });
  const fixture = harness({
    record: null,
    reportStateError: reportError,
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification("thread-1", "turn-1"));
  };
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    ),
    (error) => error === reportError,
  );
  assert.equal(fixture.stored().terminalStatus, "completed");
});

test("persists one failed active turn before close and rethrows infrastructure failure", async () => {
  const fixture = harness({ record: null });
  const failure = Object.assign(new Error("infrastructure"), {
    code: "APP_SERVER_UNEXPECTED_EXIT",
  });
  fixture.client.onClose = async () => {
    fixture.order.push("client-close");
  };
  fixture.client.onTurnStart = async (client) => {
    assert.equal(client.failures.size, 1);
    setImmediate(() => client.emitFailure(failure));
    setTimeout(
      () => client.emitNotification(terminalNotification("thread-1", "turn-1")),
      50,
    );
  };
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    ),
    (error) => error === failure,
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started", "running", "failed"],
  );
  assert.equal(fixture.stored().terminalStatus, "failed");
  assert.equal(fixture.client.closed, 1);
  assert.equal(fixture.client.failures.size, 0);
  assert.ok(
    fixture.order.indexOf("write:failed") < fixture.order.indexOf("client-close"),
  );
});

test("persists a failed no-turn record when failure precedes a synchronous turn-start rejection", async () => {
  const fixture = harness({ record: null });
  const failure = Object.assign(new Error("infrastructure"), {
    code: "APP_SERVER_UNEXPECTED_EXIT",
  });
  fixture.client.onClose = async () => {
    fixture.order.push("client-close");
  };
  fixture.client.turnStart = function (params) {
    this.calls.push(["turnStart", params]);
    assert.equal(this.failures.size, 1);
    this.emitFailure(failure);
    return Promise.reject(failure);
  };

  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    ),
    (error) => error === failure,
  );

  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started", "failed"],
  );
  assert.equal(fixture.stored().terminalStatus, "failed");
  assert.equal(fixture.stored().turnId, null);
  assert.equal(fixture.stored().terminalHead, "head-final");
  assert.equal(fixture.client.closed, 1);
  assert.equal(fixture.client.failures.size, 0);
  assert.ok(
    fixture.order.indexOf("snapshot:/repo") <
      fixture.order.indexOf("write:failed"),
  );
  assert.ok(
    fixture.order.indexOf("write:failed") < fixture.order.indexOf("client-close"),
  );
  fixture.client.emitNotification(
    terminalNotification("thread-1", "turn-1", "completed"),
  );
  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started", "failed"],
  );
});

test("queued terminal state and handled interrupt remain authoritative over failure", async () => {
  const failure = Object.assign(new Error("infrastructure"), {
    code: "APP_SERVER_UNEXPECTED_EXIT",
  });
  const terminal = harness({ record: null });
  terminal.client.onTurnStart = async (client) => {
    setImmediate(() => {
      client.emitNotification(terminalNotification("thread-1", "turn-1"));
      client.emitFailure(failure);
    });
  };
  const terminalResult = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    terminal.dependencies,
  );
  assert.equal(terminalResult.terminalStatus, "completed");
  assert.deepEqual(
    terminal.writes.map((record) => record.terminalStatus),
    ["not-started", "running", "completed"],
  );

  const interrupted = harness({ record: null, interruptGraceMs: 5 });
  interrupted.client.onTurnStart = async (client) => {
    interrupted.interrupt();
    client.emitFailure(failure);
  };
  const interruptedResult = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    interrupted.dependencies,
  );
  assert.equal(interruptedResult.terminalStatus, "interrupted");
  assert.equal(interrupted.stored().terminalStatus, "interrupted");
  assert.equal(interrupted.client.closed, 1);
});

test("latches the first interrupt and lets terminal notification beat the grace deadline", async () => {
  const fixture = harness({ record: null, interruptGraceMs: 100 });
  fixture.client.onTurnStart = async (client) => {
    fixture.interrupt();
    setTimeout(
      () =>
        client.emitNotification(
          terminalNotification("thread-1", "turn-1", "completed"),
        ),
      10,
    );
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "completed");
  assert.deepEqual(
    fixture.client.calls.filter(([method]) => method === "turnInterrupt"),
    [["turnInterrupt", { threadId: "thread-1", turnId: "turn-1" }]],
  );
});

test("subscribes early enough to latch an interrupt during durable thread reporting", async () => {
  const fixture = harness({ record: null, interruptsOnReport: 1 });
  fixture.client.onTurnStart = async (client) => {
    setTimeout(
      () => client.emitNotification(terminalNotification("thread-1", "turn-1")),
      5,
    );
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "completed");
  assert.deepEqual(
    fixture.client.calls.filter(([method]) => method === "turnInterrupt"),
    [["turnInterrupt", { threadId: "thread-1", turnId: "turn-1" }]],
  );
});

test("finalizes a second reported interrupt without starting a turn", async () => {
  const fixture = harness({ record: null, interruptsOnReport: 2 });
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(result.turnId, null);
  assert.equal(
    fixture.client.calls.some(([method]) => method === "turnStart"),
    false,
  );
  assert.equal(fixture.client.closed, 1);
});

test("finalizes a pre-stable force close but preserves ordinary turn-start failure", async () => {
  const forced = harness({ record: null });
  forced.client.turnStart = async function (params) {
    this.calls.push(["turnStart", params]);
    queueMicrotask(() => {
      forced.interrupt();
      forced.interrupt();
    });
    return await new Promise((_, reject) => {
      this.rejectPendingTurn = reject;
    });
  };
  forced.client.onClose = async () => {
    forced.client.rejectPendingTurn?.(
      Object.assign(new Error("closed"), { code: "APP_SERVER_CLOSED" }),
    );
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    forced.dependencies,
  );
  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(result.turnId, null);
  assert.equal(result.terminalHead, "head-final");
  assert.equal(result.finalGitStatus, "? changed.txt\n");
  assert.equal(forced.client.closed, 1);
  assert.deepEqual(
    forced.writes.map((record) => record.terminalStatus),
    ["not-started", "interrupted"],
  );

  const ordinary = harness({ record: null });
  ordinary.client.turnStart = async function (params) {
    this.calls.push(["turnStart", params]);
    throw Object.assign(new Error("rpc"), { code: "APP_SERVER_REMOTE_ERROR" });
  };
  await assert.rejects(
    coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      ordinary.dependencies,
    ),
    { code: "APP_SERVER_REMOTE_ERROR" },
  );
  assert.deepEqual(
    ordinary.writes.map((record) => record.terminalStatus),
    ["not-started"],
  );
  assert.equal(ordinary.client.closed, 1);
});

for (const operation of ["start", "resume"]) {
  test(`captures post-close Git state for forced no-turn ${operation} interruption`, async () => {
    const finalSnapshot = {
      repositoryRoot: "/repo",
      head: `head-before-close-${operation}`,
      porcelainV2: "",
      clean: true,
    };
    const fixture = harness({
      record: operation === "start" ? null : existingRecord(),
      snapshots: [
        {
          repositoryRoot: "/repo",
          head: "head-new",
          porcelainV2: "",
          clean: true,
        },
        finalSnapshot,
      ],
    });
    let releaseClose;
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    let markCloseStarted;
    const closeStarted = new Promise((resolve) => {
      markCloseStarted = resolve;
    });
    fixture.client.onClose = async () => {
      markCloseStarted();
      await closeGate;
      finalSnapshot.head = `head-after-close-${operation}`;
      finalSnapshot.porcelainV2 = `? post-close-${operation}.txt\n`;
      finalSnapshot.clean = false;
      fixture.order.push("close-mutation");
    };
    const rejectAfterInterrupts = function (params, method) {
      this.calls.push([method, params]);
      return new Promise((_, reject) => {
        queueMicrotask(() => {
          fixture.interrupt();
          fixture.interrupt();
          reject(Object.assign(new Error("closed"), { code: "APP_SERVER_CLOSED" }));
        });
      });
    };
    if (operation === "start") {
      fixture.client.turnStart = function (params) {
        return rejectAfterInterrupts.call(this, params, "turnStart");
      };
    } else {
      fixture.client.threadResume = function (params) {
        return rejectAfterInterrupts.call(this, params, "threadResume");
      };
    }

    const running =
      operation === "start"
        ? coordinator().startNewThread(
            {
              repositoryRoot: "/repo",
              prompt: "x",
              bundleDigest: "bundle-new",
            },
            fixture.dependencies,
          )
        : coordinator().resumeThread(
            "thread-1",
            "continue",
            fixture.dependencies,
          );
    await closeStarted;
    await new Promise((resolve) => setImmediate(resolve));
    releaseClose();
    const result = await running;

    assert.equal(result.terminalStatus, "interrupted", operation);
    assert.equal(result.turnId, null, operation);
    assert.equal(result.terminalHead, `head-after-close-${operation}`, operation);
    assert.equal(
      result.finalGitStatus,
      `? post-close-${operation}.txt\n`,
      operation,
    );
    assert.equal(fixture.client.closed, 1, operation);
    assert.ok(
      fixture.order.indexOf("close-mutation") <
        fixture.order.lastIndexOf("snapshot:/repo"),
      operation,
    );
    assert.ok(
      fixture.order.indexOf("close-mutation") <
        fixture.order.lastIndexOf("write:interrupted"),
      operation,
    );
  });
}

test("settles interruption once on second signal, RPC failure, or grace timeout", async () => {
  for (const mode of ["second", "rpc", "timeout"]) {
    const fixture = harness({ record: null, interruptGraceMs: 10 });
    fixture.client.onTurnStart = async () => {
      queueMicrotask(() => {
        fixture.interrupt();
        if (mode === "second") fixture.interrupt();
      });
    };
    if (mode === "rpc") {
      fixture.client.onTurnInterrupt = async () => {
        throw Object.assign(new Error("rpc"), { code: "APP_SERVER_REMOTE_ERROR" });
      };
    }
    const result = await coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    );
    assert.equal(result.terminalStatus, "interrupted", mode);
    assert.equal(fixture.client.closed, 1, mode);
    fixture.client.emitNotification(
      terminalNotification("thread-1", "turn-1", "completed"),
    );
    assert.equal(fixture.stored().terminalStatus, "interrupted", mode);
  }
});

test("awaits the one in-flight client close before resolving", async () => {
  const fixture = harness({ record: null });
  let releaseClose;
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  let closeStarted = false;
  fixture.client.onClose = async () => {
    closeStarted = true;
    await closeGate;
  };
  fixture.client.onTurnStart = async () => {
    queueMicrotask(() => {
      fixture.interrupt();
      fixture.interrupt();
    });
  };

  const running = coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  while (!closeStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    fixture.order.filter((entry) => entry === "snapshot:/repo").length,
    1,
  );
  assert.deepEqual(
    fixture.writes.map((record) => record.terminalStatus),
    ["not-started"],
  );
  assert.equal(
    await Promise.race([
      running.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]),
    "pending",
  );
  releaseClose();
  const result = await running;
  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(fixture.client.closed, 1);
});

test("terminal approval writer uses bounded fd writes without taking stream ownership", async () => {
  const path = join(tmpdir(), `andrew-agent-writer-${process.pid}`);
  const fd = openSync(path, "w+", 0o600);
  let endCalls = 0;
  let destroyCalls = 0;
  let listenerCalls = 0;
  const output = {
    isTTY: true,
    fd,
    end() {
      endCalls += 1;
    },
    destroy() {
      destroyCalls += 1;
    },
    on() {
      listenerCalls += 1;
    },
  };
  try {
    await coordinator().createTerminalApprovalPromptWriter(output).writePrompt(
      "approve?",
      new AbortController().signal,
    );
    assert.equal(readFileSync(path, "utf8"), "approve?");
    assert.deepEqual([endCalls, destroyCalls, listenerCalls], [0, 0, 0]);
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
});

test("terminal approval writer rejects non-TTY, abort, partial, and failed writes with typed errors", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    coordinator().createTerminalApprovalPromptWriter({ isTTY: false, fd: 2 }).writePrompt("x", signal),
    { code: "TERMINAL_NOT_INTERACTIVE" },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    coordinator().createTerminalApprovalPromptWriter({ isTTY: true, fd: 2 }).writePrompt("x", controller.signal),
    { code: "TERMINAL_WRITE_ABORTED" },
  );
  const chunks = [];
  await coordinator().createTerminalApprovalPromptWriter(
    { isTTY: true, fd: 2 },
    (_fd, bytes, offset) => {
      chunks.push(bytes.subarray(offset, offset + 1).toString());
      return 1;
    },
  ).writePrompt("partial", signal);
  assert.equal(chunks.join(""), "partial");
  await assert.rejects(
    coordinator().createTerminalApprovalPromptWriter(
      { isTTY: true, fd: 2 },
      () => 0,
    ).writePrompt("x", signal),
    { code: "TERMINAL_WRITE_FAILED" },
  );
  await assert.rejects(
    coordinator().createTerminalApprovalPromptWriter(
      { isTTY: true, fd: 2 },
      () => {
        throw new Error("write failed");
      },
    ).writePrompt("x", signal),
    { code: "TERMINAL_WRITE_FAILED" },
  );
});

// An interrupt settles the turn without another notification, so nothing
// re-rendered the state and the renderer's in-flight constant was the last
// word: everything the message had generated was thrown away.
test("an interrupted turn reports a terminal state so partial output survives", async () => {
  const fixture = harness({ record: null, interruptGraceMs: 5 });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "" } },
    });
    client.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "partial answer" },
    });
    setImmediate(() => {
      fixture.interrupt();
      fixture.interrupt();
    });
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "interrupted");
  const last = fixture.states.at(-1);
  assert.notEqual(last, undefined, "the turn state must be reported at least once");
  assert.notEqual(last.terminalStatus, "running", "the last reported state must be terminal");
  assert.equal(last.items.get("msg-1").value.text, "partial answer");
});

test("a normal completion retries its failed terminal report", async () => {
  const fixture = harness({ record: null });
  let terminalAttempts = 0;
  fixture.dependencies.reportTurnState = async (state) => {
    fixture.states.push(state);
    if (state.terminalStatus === "running") return;
    terminalAttempts += 1;
    if (terminalAttempts === 1) throw new Error("first terminal report failed");
  };
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "" } },
    });
    client.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "complete answer" },
    });
    client.emitNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", itemsView: "summary", items: [], status: "completed" },
      },
    });
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "completed");
  assert.equal(terminalAttempts, 2);
  assert.equal(fixture.states.at(-1).items.get("msg-1").value.text, "complete answer");
});

test("an interrupt retries its failed terminal report", async () => {
  const fixture = harness({ record: null, interruptGraceMs: 5 });
  let terminalAttempts = 0;
  fixture.dependencies.reportTurnState = async (state) => {
    fixture.states.push(state);
    if (state.terminalStatus === "running") return;
    terminalAttempts += 1;
    if (terminalAttempts === 1) throw new Error("first terminal report failed");
  };
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "" } },
    });
    client.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "partial answer" },
    });
    setImmediate(() => {
      fixture.interrupt();
      fixture.interrupt();
    });
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  assert.equal(result.terminalStatus, "interrupted");
  assert.equal(terminalAttempts, 2);
  assert.equal(fixture.states.at(-1).items.get("msg-1").value.text, "partial answer");
});

// Reporting is presentation, but losing it cannot look successful. The
// coordinator must persist the terminal record before returning the typed
// output failure to the command layer.
test("exhausted terminal reports persist the interrupted record before failing", async () => {
  const fixture = harness({
    record: null,
    interruptGraceMs: 5,
  });
  const reportError = new Error("stdout closed");
  reportError.code = "COMMAND_OUTPUT_FAILED";
  let terminalAttempts = 0;
  fixture.dependencies.reportTurnState = async (state) => {
    fixture.states.push(state);
    if (state.terminalStatus === "running") return;
    terminalAttempts += 1;
    throw reportError;
  };
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "" } },
    });
    client.emitNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "partial answer" },
    });
    setImmediate(() => {
      fixture.interrupt();
      fixture.interrupt();
    });
  };
  let failure = null;
  try {
    await coordinator().startNewThread(
      { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
      fixture.dependencies,
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure, reportError);
  assert.equal(terminalAttempts, 2);
  assert.equal(fixture.writes.at(-1).terminalStatus, "interrupted");
});

test("carries the last token usage measurement into the persisted terminal record", async () => {
  const fixture = harness({ record: null });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: client.threadId,
        turnId: client.turnId,
        tokenUsage: { total: { totalTokens: 618000 }, last: { totalTokens: 204000 }, modelContextWindow: 272000 },
      },
    });
    client.emitNotification(
      terminalNotification(client.threadId, client.turnId, "completed"),
    );
  };

  const result = await coordinator().startNewThread(
    { repositoryRoot: "/input", prompt: "ship it", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );

  // The record written before the turn starts cannot know a measurement, and
  // the terminal one carries what the App Server last reported.
  assert.equal(fixture.writes[0].tokenUsage, null);
  assert.deepEqual(result.tokenUsage, { totalTokens: 204000, contextWindow: 272000 });
  assert.deepEqual(fixture.writes.at(-1).tokenUsage, { totalTokens: 204000, contextWindow: 272000 });
});

test("a resume carries the stored measurement until the turn reports a new one", async () => {
  const prior = { totalTokens: 30178, contextWindow: 258400 };

  // An interrupt before threadResume returns finalizes without a turn, and
  // that record is the whole thread's record. Writing null there discards the
  // only measurement the thread has, which is exactly the number a resumed
  // thread is long enough to need.
  const forced = harness({ record: existingRecord({ tokenUsage: prior }) });
  forced.client.threadResume = async function (params) {
    this.calls.push(["threadResume", params]);
    queueMicrotask(() => {
      forced.interrupt();
      forced.interrupt();
    });
    return await new Promise((_, reject) => {
      this.rejectPendingResume = reject;
    });
  };
  forced.client.onClose = async () => {
    forced.client.rejectPendingResume?.(Object.assign(new Error("closed"), { code: "APP_SERVER_CLOSED" }));
  };
  const interrupted = await coordinator().resumeThread("thread-1", "continue", forced.dependencies);
  assert.equal(interrupted.terminalStatus, "interrupted");
  assert.deepEqual(interrupted.tokenUsage, prior);
  assert.deepEqual(forced.writes.at(-1).tokenUsage, prior);

  // The running record is written before the turn reports anything, so it
  // carries the stored value too rather than a hole a kill would make
  // permanent.
  const resumed = harness({ record: existingRecord({ tokenUsage: prior }) });
  resumed.client.onTurnStart = async (client) => {
    client.emitNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId: client.threadId, turnId: client.turnId, tokenUsage: { last: { totalTokens: 41000 }, modelContextWindow: 258400 } },
    });
    client.emitNotification(terminalNotification(client.threadId, client.turnId, "completed"));
  };
  const completed = await coordinator().resumeThread("thread-1", "continue", resumed.dependencies);
  assert.deepEqual(resumed.writes.find((record) => record.terminalStatus === "running").tokenUsage, prior);
  assert.deepEqual(completed.tokenUsage, { totalTokens: 41000, contextWindow: 258400 });
});
