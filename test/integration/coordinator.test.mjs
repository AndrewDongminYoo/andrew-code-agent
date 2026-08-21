import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const coordinatorModule = await import(
  "../../dist/app-server/coordinator.js"
).catch(() => null);

function coordinator() {
  assert.notEqual(
    coordinatorModule,
    null,
    "the built app-server coordinator module must be available",
  );
  return coordinatorModule;
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

class FakeClient {
  calls = [];
  notifications = new Set();
  requests = new Set();
  failures = new Set();
  closed = 0;
  threadId = "thread-1";
  turnId = "turn-1";
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
    return { thread: { id: this.threadId } };
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
    approvalInput: ttyInput(),
    approvalWriter: overrides.approvalWriter ?? { async writePrompt() {} },
    approvalTimeoutMs: 50,
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

test("reads live status with exact identity and no mutation", async () => {
  const fixture = harness();
  const original = fixture.stored();
  const result = await coordinator().readLiveStatus(
    "thread-1",
    fixture.dependencies,
  );
  assert.deepEqual(result, original);
  assert.deepEqual(fixture.client.calls, [
    ["threadRead", { threadId: "thread-1", includeTurns: false }],
  ]);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.order.some((entry) => entry.startsWith("snapshot:")), false);
  assert.equal(fixture.client.closed, 1);

  const mismatch = harness();
  mismatch.client.threadId = "other-thread";
  await assert.rejects(
    coordinator().readLiveStatus("thread-1", mismatch.dependencies),
    { code: "APP_SERVER_IDENTITY_MISMATCH" },
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

test("keeps an observed terminal notification authoritative when reporting fails", async () => {
  const fixture = harness({
    record: null,
    reportStateError: new Error("renderer unavailable"),
  });
  fixture.client.onTurnStart = async (client) => {
    client.emitNotification(terminalNotification("thread-1", "turn-1"));
  };
  const result = await coordinator().startNewThread(
    { repositoryRoot: "/repo", prompt: "x", bundleDigest: "bundle-new" },
    fixture.dependencies,
  );
  assert.equal(result.terminalStatus, "completed");
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
