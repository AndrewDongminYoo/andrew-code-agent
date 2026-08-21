/// <reference types="node" />

import { writeSync } from "node:fs";
import { isProxy } from "node:util/types";
import type { GitSnapshot } from "../runtime/git.js";
import type { ThreadRecord } from "../runtime/thread-store.js";
import { answerApproval, type ApprovalPromptWriter } from "./approvals.js";
import type { AppServerClient } from "./client.js";
import {
  createTurnState,
  reduceServerMessage,
  type TurnState,
} from "./reducer.js";

export interface RunRequest {
  readonly repositoryRoot: string;
  readonly prompt: string;
  readonly bundleDigest: string;
}

export interface ReleaseIdentity {
  readonly bundleDigest: string;
  readonly productVersion: string;
  readonly codexVersion: string;
}

export interface CoordinatorDependencies {
  readonly client: AppServerClient;
  readonly stateRoot: string;
  readonly git: {
    resolveRepositoryRoot(input: string): Promise<string>;
    readGitSnapshot(input: string): Promise<GitSnapshot>;
    assertCleanGitSnapshot(snapshot: GitSnapshot): GitSnapshot;
  };
  readonly threadStore: {
    readThreadRecord(
      stateRoot: string,
      threadId: string,
      repositoryRoot?: string,
    ): Promise<ThreadRecord>;
    writeThreadRecord(stateRoot: string, record: ThreadRecord): Promise<void>;
  };
  readonly releaseIdentity: ReleaseIdentity;
  readonly approvalInput: NodeJS.ReadableStream;
  readonly approvalWriter: ApprovalPromptWriter;
  readonly approvalTimeoutMs: number;
  readonly subscribeInterrupt: (listener: () => void) => () => void;
  readonly interruptGraceMs: number;
  readonly reportThreadId: (threadId: string) => Promise<void>;
  readonly reportTurnState: (state: TurnState) => void | Promise<void>;
}

export type CoordinatorErrorCode =
  | "APP_SERVER_IDENTITY_MISMATCH"
  | "BUNDLE_DIGEST_MISMATCH"
  | "COORDINATOR_FAILURE"
  | "COORDINATOR_INTERRUPTED"
  | "EVENT_BUFFER_OVERFLOW"
  | "INVALID_COORDINATOR_INPUT"
  | "MALFORMED_APP_SERVER_RESPONSE"
  | "TERMINAL_NOT_INTERACTIVE"
  | "TERMINAL_WRITE_ABORTED"
  | "TERMINAL_WRITE_FAILED"
  | "THREAD_REPOSITORY_MISMATCH";

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;

  constructor(code: CoordinatorErrorCode) {
    super(code);
    this.name = "CoordinatorError";
    this.code = code;
  }
}

type TerminalStatus = ThreadRecord["terminalStatus"];
type TerminalWrite = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

interface ClientLifecycle {
  close(): Promise<void>;
}

interface InterruptLatch {
  bind(listener: (count: number) => void): void;
  count(): number;
  unbind(): void;
  remove(): void;
}

const MAX_BUFFERED_EVENTS = 256;
const MAX_TERMINAL_PROMPT_BYTES = 8192;

function ownString(value: unknown, key: string): string | null {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      isProxy(value)
    )
      return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function nestedResponseId(
  response: unknown,
  container: "thread" | "turn",
): string {
  try {
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response) ||
      isProxy(response)
    )
      throw new CoordinatorError("MALFORMED_APP_SERVER_RESPONSE");
    const descriptor = Object.getOwnPropertyDescriptor(response, container);
    if (descriptor === undefined || !("value" in descriptor))
      throw new CoordinatorError("MALFORMED_APP_SERVER_RESPONSE");
    const id = ownString(descriptor.value, "id");
    if (id === null || id.length === 0)
      throw new CoordinatorError("MALFORMED_APP_SERVER_RESPONSE");
    return id;
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw new CoordinatorError("MALFORMED_APP_SERVER_RESPONSE");
  }
}

function validateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireSnapshotRepository(
  snapshot: GitSnapshot,
  expectedRepositoryRoot: string,
): GitSnapshot {
  if (ownString(snapshot, "repositoryRoot") !== expectedRepositoryRoot)
    throw new CoordinatorError("THREAD_REPOSITORY_MISMATCH");
  return snapshot;
}

function preserveTypedError(error: unknown): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error;
  return error instanceof CoordinatorError
    ? error
    : new CoordinatorError("COORDINATOR_FAILURE");
}

async function closeClient(client: AppServerClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // The operation's typed outcome remains authoritative during cleanup.
  }
}

function createClientLifecycle(client: AppServerClient): ClientLifecycle {
  let closing: Promise<void> | null = null;
  return {
    async close() {
      closing ??= closeClient(client);
      await closing;
    },
  };
}

function createInterruptLatch(
  dependencies: CoordinatorDependencies,
  lifecycle: ClientLifecycle,
): InterruptLatch {
  let count = 0;
  let listener: ((count: number) => void) | null = null;
  const remove = dependencies.subscribeInterrupt(() => {
    count += 1;
    if (listener !== null) listener(count);
    else if (count >= 2) void lifecycle.close();
  });
  return {
    bind(nextListener) {
      listener = nextListener;
      if (count > 0) nextListener(count);
    },
    count() {
      return count;
    },
    unbind() {
      listener = null;
    },
    remove,
  };
}

async function finalizeWithoutTurn(
  status: "failed" | "interrupted",
  identity: {
    readonly threadId: string;
    readonly repositoryRoot: string;
    readonly startingHead: string;
  },
  dependencies: CoordinatorDependencies,
  lifecycle: ClientLifecycle,
  closeBeforeSnapshot = true,
): Promise<ThreadRecord> {
  if (closeBeforeSnapshot) await lifecycle.close();
  const finalSnapshot = requireSnapshotRepository(
    await dependencies.git.readGitSnapshot(identity.repositoryRoot),
    identity.repositoryRoot,
  );
  const finalRecord: ThreadRecord = {
    threadId: identity.threadId,
    repositoryRoot: identity.repositoryRoot,
    startingHead: identity.startingHead,
    terminalHead: finalSnapshot.head,
    bundleDigest: dependencies.releaseIdentity.bundleDigest,
    productVersion: dependencies.releaseIdentity.productVersion,
    codexVersion: dependencies.releaseIdentity.codexVersion,
    turnId: null,
    terminalStatus: status,
    finalGitStatus: finalSnapshot.porcelainV2,
  };
  await dependencies.threadStore.writeThreadRecord(
    dependencies.stateRoot,
    finalRecord,
  );
  if (!closeBeforeSnapshot) await lifecycle.close();
  return finalRecord;
}

function runningRecord(
  threadId: string,
  repositoryRoot: string,
  startingHead: string,
  turnId: string,
  release: ReleaseIdentity,
): ThreadRecord {
  return {
    threadId,
    repositoryRoot,
    startingHead,
    terminalHead: null,
    bundleDigest: release.bundleDigest,
    productVersion: release.productVersion,
    codexVersion: release.codexVersion,
    turnId,
    terminalStatus: "running",
    finalGitStatus: null,
  };
}

async function runTurn(
  prompt: string,
  identity: {
    readonly threadId: string;
    readonly repositoryRoot: string;
    readonly startingHead: string;
  },
  dependencies: CoordinatorDependencies,
  lifecycle: ClientLifecycle,
  interruptLatch: InterruptLatch,
): Promise<ThreadRecord> {
  const client = dependencies.client;
  let state: TurnState | null = null;
  let turnId: string | null = null;
  let interruptCount = 0;
  let interruptStarted = false;
  let graceTimer: NodeJS.Timeout | null = null;
  let settled = false;
  let fatalFailure = false;
  let infrastructureFailure: Error | null = null;
  let removeNotification = () => {};
  let removeRequest = () => {};
  let removeFailure = () => {};
  let resolveSettlement!: (status: TerminalStatus) => void;
  const approvalController = new AbortController();
  const settlement = new Promise<TerminalStatus>((resolve) => {
    resolveSettlement = resolve;
  });
  const buffered: {
    readonly kind: "notification" | "request" | "failure";
    value: unknown;
  }[] = [];
  let notificationSerial = Promise.resolve();
  let requestSerial = Promise.resolve();

  const closeOnce = (): Promise<void> => lifecycle.close();
  const settle = (status: TerminalStatus): boolean => {
    if (settled) return false;
    settled = true;
    if (graceTimer !== null) clearTimeout(graceTimer);
    approvalController.abort();
    resolveSettlement(fatalFailure ? "failed" : status);
    return true;
  };
  const interruptActiveTurn = (): void => {
    if (interruptStarted || turnId === null || settled) return;
    interruptStarted = true;
    graceTimer = setTimeout(
      () => {
        if (settle("interrupted")) void closeOnce();
      },
      Math.max(1, Math.min(dependencies.interruptGraceMs, 60_000)),
    );
    void client
      .turnInterrupt({ threadId: identity.threadId, turnId })
      .catch(() => {
        if (settle("interrupted")) void closeOnce();
      });
  };
  const failClosed = (): void => {
    fatalFailure = true;
    interruptCount = Math.max(1, interruptCount);
    interruptActiveTurn();
  };
  const onInterrupt = (count: number): void => {
    interruptCount = count;
    if (interruptCount === 1 && !interruptStarted) {
      interruptActiveTurn();
      return;
    }
    if (settle("interrupted")) void closeOnce();
  };
  const processNotification = async (message: unknown): Promise<void> => {
    if (settled || state === null) return;
    try {
      state = reduceServerMessage(state, message);
      if (state.terminalStatus !== "running") settle(state.terminalStatus);
      await dependencies.reportTurnState(state);
    } catch {
      if (!settled) failClosed();
    }
  };
  const processRequest = async (message: unknown): Promise<void> => {
    if (settled) return;
    let requestId: string | number;
    try {
      const descriptor =
        typeof message === "object" && message !== null && !isProxy(message)
          ? Object.getOwnPropertyDescriptor(message, "id")
          : undefined;
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !(
          typeof descriptor.value === "string" ||
          (typeof descriptor.value === "number" &&
            Number.isFinite(descriptor.value))
        )
      ) {
        failClosed();
        return;
      }
      requestId = descriptor.value;
    } catch {
      failClosed();
      return;
    }
    const outcome = await answerApproval(
      message,
      dependencies.approvalInput,
      dependencies.approvalWriter,
      dependencies.approvalTimeoutMs,
      approvalController.signal,
    );
    if (outcome.kind === "failClosed") {
      failClosed();
      return;
    }
    const allowsUncorrelatedTurn =
      outcome.correlation.method === "mcpServer/elicitation/request" &&
      outcome.correlation.turnId === null;
    if (
      outcome.correlation.threadId !== identity.threadId ||
      (!allowsUncorrelatedTurn && outcome.correlation.turnId !== turnId)
    ) {
      failClosed();
      return;
    }
    if (settled) return;
    try {
      await client.respond(requestId, outcome.response);
    } catch {
      failClosed();
    }
  };
  const processFailure = (error: Error): void => {
    if (settled) return;
    if (interruptStarted || interruptCount > 0) {
      settle("interrupted");
      return;
    }
    infrastructureFailure = error;
    settle("failed");
  };
  const enqueue = (
    kind: "notification" | "request" | "failure",
    value: unknown,
  ): void => {
    if (settled) return;
    if (state === null) {
      if (kind === "failure") {
        processFailure(value as Error);
        return;
      }
      if (buffered.length >= MAX_BUFFERED_EVENTS) {
        failClosed();
        return;
      }
      buffered.push({ kind, value });
      return;
    }
    if (kind === "notification")
      notificationSerial = notificationSerial.then(() =>
        processNotification(value),
      );
    else if (kind === "failure")
      notificationSerial = notificationSerial.then(() =>
        processFailure(value as Error),
      );
    else requestSerial = requestSerial.then(() => processRequest(value));
  };
  const finalizeSettledWithoutTurn = async (): Promise<ThreadRecord> => {
    const terminalStatus = await settlement;
    if (terminalStatus !== "failed" && terminalStatus !== "interrupted")
      throw new CoordinatorError("COORDINATOR_FAILURE");
    return await finalizeWithoutTurn(
      terminalStatus,
      identity,
      dependencies,
      lifecycle,
      infrastructureFailure === null,
    );
  };

  try {
    removeNotification = client.onNotification((message) =>
      enqueue("notification", message),
    );
    removeRequest = client.onRequest((message) => enqueue("request", message));
    removeFailure = client.onFailure((error) => enqueue("failure", error));
    interruptLatch.bind(onInterrupt);
    if (settled) return await finalizeSettledWithoutTurn();
    let response;
    try {
      response = await client.turnStart({
        threadId: identity.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: identity.repositoryRoot,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [identity.repositoryRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
    } catch (error) {
      if (!settled) throw error;
      const finalRecord = await finalizeSettledWithoutTurn();
      if (infrastructureFailure !== null) throw infrastructureFailure;
      return finalRecord;
    }
    turnId = nestedResponseId(response, "turn");
    state = createTurnState(identity.threadId, turnId);
    const activeRecord = runningRecord(
      identity.threadId,
      identity.repositoryRoot,
      identity.startingHead,
      turnId,
      dependencies.releaseIdentity,
    );
    if (!settled)
      await dependencies.threadStore.writeThreadRecord(
        dependencies.stateRoot,
        activeRecord,
      );
    if (interruptCount > 0) interruptActiveTurn();
    for (const event of buffered.splice(0)) enqueue(event.kind, event.value);
    await notificationSerial;
    const terminalStatus = await settlement;
    await Promise.all([notificationSerial, requestSerial]);
    const failure = infrastructureFailure;
    if (failure === null) await closeOnce();
    const finalSnapshot = requireSnapshotRepository(
      await dependencies.git.readGitSnapshot(identity.repositoryRoot),
      identity.repositoryRoot,
    );
    const finalRecord: ThreadRecord = {
      ...activeRecord,
      terminalHead: finalSnapshot.head,
      terminalStatus,
      finalGitStatus: finalSnapshot.porcelainV2,
    };
    await dependencies.threadStore.writeThreadRecord(
      dependencies.stateRoot,
      finalRecord,
    );
    if (failure !== null) {
      await closeOnce();
      throw failure;
    }
    return finalRecord;
  } catch (error) {
    throw preserveTypedError(error);
  } finally {
    approvalController.abort();
    if (graceTimer !== null) clearTimeout(graceTimer);
    removeNotification();
    removeRequest();
    removeFailure();
    interruptLatch.unbind();
    await closeOnce();
  }
}

export async function startNewThread(
  request: RunRequest,
  dependencies: CoordinatorDependencies,
): Promise<ThreadRecord> {
  const lifecycle = createClientLifecycle(dependencies.client);
  let delegatesClientLifecycle = false;
  let interruptLatch: InterruptLatch | null = null;
  try {
    interruptLatch = createInterruptLatch(dependencies, lifecycle);
    const repositoryInput = request?.repositoryRoot;
    const prompt = request?.prompt;
    const bundleDigest = request?.bundleDigest;
    if (
      !validateString(repositoryInput) ||
      !validateString(prompt) ||
      !validateString(bundleDigest)
    )
      throw new CoordinatorError("INVALID_COORDINATOR_INPUT");
    if (bundleDigest !== dependencies.releaseIdentity.bundleDigest)
      throw new CoordinatorError("BUNDLE_DIGEST_MISMATCH");
    const repositoryRoot =
      await dependencies.git.resolveRepositoryRoot(repositoryInput);
    const snapshot = dependencies.git.assertCleanGitSnapshot(
      requireSnapshotRepository(
        await dependencies.git.readGitSnapshot(repositoryRoot),
        repositoryRoot,
      ),
    );
    let response;
    try {
      response = await dependencies.client.threadStart({
        cwd: repositoryRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      });
    } catch (error) {
      if (interruptLatch.count() >= 2)
        throw new CoordinatorError("COORDINATOR_INTERRUPTED");
      throw error;
    }
    const threadId = nestedResponseId(response, "thread");
    const initialRecord: ThreadRecord = {
      threadId,
      repositoryRoot,
      startingHead: snapshot.head,
      terminalHead: null,
      bundleDigest: dependencies.releaseIdentity.bundleDigest,
      productVersion: dependencies.releaseIdentity.productVersion,
      codexVersion: dependencies.releaseIdentity.codexVersion,
      turnId: null,
      terminalStatus: "not-started",
      finalGitStatus: null,
    };
    await dependencies.threadStore.writeThreadRecord(
      dependencies.stateRoot,
      initialRecord,
    );
    await dependencies.reportThreadId(threadId);
    delegatesClientLifecycle = true;
    return await runTurn(
      prompt,
      { threadId, repositoryRoot, startingHead: snapshot.head },
      dependencies,
      lifecycle,
      interruptLatch,
    );
  } catch (error) {
    throw preserveTypedError(error);
  } finally {
    interruptLatch?.remove();
    if (!delegatesClientLifecycle) await lifecycle.close();
  }
}

export async function resumeThread(
  threadId: string,
  prompt: string | undefined,
  dependencies: CoordinatorDependencies,
): Promise<ThreadRecord> {
  const lifecycle = createClientLifecycle(dependencies.client);
  let delegatesClientLifecycle = false;
  let interruptLatch: InterruptLatch | null = null;
  try {
    if (
      !validateString(threadId) ||
      (prompt !== undefined && !validateString(prompt))
    )
      throw new CoordinatorError("INVALID_COORDINATOR_INPUT");
    if (prompt !== undefined)
      interruptLatch = createInterruptLatch(dependencies, lifecycle);
    const record = await dependencies.threadStore.readThreadRecord(
      dependencies.stateRoot,
      threadId,
    );
    const repositoryRoot = await dependencies.git.resolveRepositoryRoot(
      record.repositoryRoot,
    );
    if (repositoryRoot !== record.repositoryRoot)
      throw new CoordinatorError("THREAD_REPOSITORY_MISMATCH");
    const snapshot = dependencies.git.assertCleanGitSnapshot(
      requireSnapshotRepository(
        await dependencies.git.readGitSnapshot(repositoryRoot),
        repositoryRoot,
      ),
    );
    let response;
    try {
      response = await dependencies.client.threadResume({
        threadId,
        cwd: repositoryRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      });
    } catch (error) {
      if ((interruptLatch?.count() ?? 0) < 2) throw error;
      return await finalizeWithoutTurn(
        "interrupted",
        { threadId, repositoryRoot, startingHead: snapshot.head },
        dependencies,
        lifecycle,
      );
    }
    if (nestedResponseId(response, "thread") !== threadId)
      throw new CoordinatorError("APP_SERVER_IDENTITY_MISMATCH");
    if (prompt === undefined) return record;
    delegatesClientLifecycle = true;
    return await runTurn(
      prompt,
      { threadId, repositoryRoot, startingHead: snapshot.head },
      dependencies,
      lifecycle,
      interruptLatch!,
    );
  } catch (error) {
    throw preserveTypedError(error);
  } finally {
    interruptLatch?.remove();
    if (!delegatesClientLifecycle) await lifecycle.close();
  }
}

export async function readLiveStatus(
  threadId: string,
  dependencies: CoordinatorDependencies,
): Promise<ThreadRecord> {
  try {
    if (!validateString(threadId))
      throw new CoordinatorError("INVALID_COORDINATOR_INPUT");
    const record = await dependencies.threadStore.readThreadRecord(
      dependencies.stateRoot,
      threadId,
    );
    const response = await dependencies.client.threadRead({
      threadId,
      includeTurns: false,
    });
    if (nestedResponseId(response, "thread") !== threadId)
      throw new CoordinatorError("APP_SERVER_IDENTITY_MISMATCH");
    return record;
  } catch (error) {
    throw preserveTypedError(error);
  } finally {
    await closeClient(dependencies.client);
  }
}

export function createTerminalApprovalPromptWriter(
  output: { readonly isTTY?: boolean; readonly fd?: number },
  terminalWrite: TerminalWrite = writeSync,
): ApprovalPromptWriter {
  return {
    async writePrompt(value, signal) {
      let isTTY: boolean;
      let fd: number | undefined;
      try {
        isTTY = output.isTTY === true;
        fd = output.fd;
      } catch {
        throw new CoordinatorError("TERMINAL_NOT_INTERACTIVE");
      }
      if (!isTTY || !Number.isSafeInteger(fd) || fd! < 0)
        throw new CoordinatorError("TERMINAL_NOT_INTERACTIVE");
      if (signal.aborted) throw new CoordinatorError("TERMINAL_WRITE_ABORTED");
      const bytes = Buffer.from(value, "utf8");
      if (bytes.length > MAX_TERMINAL_PROMPT_BYTES)
        throw new CoordinatorError("TERMINAL_WRITE_FAILED");
      let offset = 0;
      while (offset < bytes.length) {
        if (signal.aborted)
          throw new CoordinatorError("TERMINAL_WRITE_ABORTED");
        let written: number;
        try {
          written = terminalWrite(fd!, bytes, offset, bytes.length - offset);
        } catch {
          throw new CoordinatorError("TERMINAL_WRITE_FAILED");
        }
        if (!Number.isSafeInteger(written) || written <= 0)
          throw new CoordinatorError("TERMINAL_WRITE_FAILED");
        offset += written;
      }
    },
  };
}
