/// <reference types="node" />

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { startAppServer, type AppServerClient } from "../app-server/client.js";
import {
  createTerminalApprovalPromptWriter,
  CoordinatorError,
  readLiveStatus,
  resumeThread,
  startNewThread,
  type CoordinatorDependencies,
} from "../app-server/coordinator.js";
import { formatTokenUsage, renderTurnState } from "../app-server/renderer.js";
import { boundedTerminalText } from "../app-server/terminal.js";
import { ArtifactError, buildBundle } from "../bundle/artifact.js";
import { RenderError, type CapabilityInputs } from "../bundle/render.js";
import {
  InstallError,
  installBundle,
  recoverInterruptedInstall,
} from "../bundle/install.js";
import { runDoctor } from "./doctor.js";
import {
  PRODUCT_VERSION,
  REQUIRED_CODEX_VERSION,
  type RequestedCapability,
} from "../constants.js";
import {
  assertCleanGitSnapshot,
  GitRuntimeError,
  readGitSnapshot,
  resolveRepositoryRoot,
} from "../runtime/git.js";
import { acquireProcessLock, releaseProcessLock } from "../runtime/lock.js";
import {
  RuntimePathError,
  initializeRuntimeState,
  resolveRuntimePaths,
  type RuntimePaths,
} from "../runtime/paths.js";
import {
  readThreadRecord,
  findLatestThreadRecord,
  writeThreadRecord,
  type ThreadRecord,
} from "../runtime/thread-store.js";

const APP_SERVER_HANDSHAKE_TIMEOUT_MS = 10_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 120_000;
const INTERRUPT_GRACE_MS = 5_000;
const DOCTOR_TIMEOUT_MS = 10_000;
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 4 * 1024;
const WRITE_COMPLETION_TIMEOUT_MS = 500;
const LATE_WRITE_ERROR_CLEANUP_TIMEOUT_MS = 250;
const TRUNCATION_MARKER = " [truncated]";

export interface CommandIO {
  readonly stdin?: Readable;
  readonly stdout: Pick<Writable, "write"> & {
    readonly destroyed?: boolean;
    readonly isTTY?: boolean;
    readonly fd?: number;
  };
  readonly stderr: Pick<Writable, "write"> & {
    readonly destroyed?: boolean;
    readonly isTTY?: boolean;
    readonly fd?: number;
  };
}

export interface CommandDependencies {
  readonly resolveRuntimePaths: typeof resolveRuntimePaths;
  readonly readGitSnapshot: typeof readGitSnapshot;
  readonly assertCleanGitSnapshot: typeof assertCleanGitSnapshot;
  readonly initializeRuntimeState: typeof initializeRuntimeState;
  readonly acquireProcessLock: typeof acquireProcessLock;
  readonly recoverInterruptedInstall: typeof recoverInterruptedInstall;
  readonly buildBundle: typeof buildBundle;
  readonly installBundle: typeof installBundle;
  readonly runDoctor: typeof runDoctor;
  readonly startAppServer: typeof startAppServer;
  readonly startNewThread: typeof startNewThread;
  readonly resumeThread: typeof resumeThread;
  readonly readLiveStatus: typeof readLiveStatus;
  readonly releaseProcessLock: typeof releaseProcessLock;
  readonly readThreadRecord: typeof readThreadRecord;
  readonly findLatestThreadRecord: typeof findLatestThreadRecord;
  readonly renderTurnState: typeof renderTurnState;
  readonly createTerminalApprovalPromptWriter: typeof createTerminalApprovalPromptWriter;
  readonly scratchParent?: string;
  readonly platform?: NodeJS.Platform;
  readonly platformVersion?: string;
}

export const defaultCommandDependencies: CommandDependencies = {
  resolveRuntimePaths,
  readGitSnapshot,
  assertCleanGitSnapshot,
  initializeRuntimeState,
  acquireProcessLock,
  recoverInterruptedInstall,
  buildBundle,
  installBundle,
  runDoctor,
  startAppServer,
  startNewThread,
  resumeThread,
  readLiveStatus,
  releaseProcessLock,
  readThreadRecord,
  findLatestThreadRecord,
  renderTurnState,
  createTerminalApprovalPromptWriter,
};

export class CommandOutputError extends Error {
  readonly code = "COMMAND_OUTPUT_FAILED";
}
const MAX_REPORTED_BLOCKERS = 8;

class ReadinessError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super("readiness");
  }
}

export async function runCommand(
  repository: string,
  prompt: string,
  io: CommandIO,
  dependencies: CommandDependencies = defaultCommandDependencies,
  // Trails the injection seam so the existing call sites keep their shape.
  capabilities: readonly RequestedCapability[] = [],
): Promise<number> {
  let phase: "preflight" | "setup" | "app-server" = "preflight";
  let lock: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
  let client: AppServerClient | undefined;
  let delegated = false;
  let outcome = 3;
  let diagnostic: string | undefined;
  try {
    const paths = await dependencies.resolveRuntimePaths({ capabilities });
    const snapshot = await dependencies.readGitSnapshot(repository);
    await dependencies.assertCleanGitSnapshot(snapshot);
    phase = "setup";
    await dependencies.initializeRuntimeState(paths);
    lock = await dependencies.acquireProcessLock(paths.stateRoot);
    const artifact = await prepareCandidate(paths, dependencies, capabilities);
    phase = "app-server";
    client = await dependencies.startAppServer(appServerInput(paths));
    const coordinator = coordinatorDependencies(
      paths,
      artifact.metadata.bundleDigest,
      client,
      io,
      dependencies,
      capabilities,
    );
    delegated = true;
    const record = await dependencies.startNewThread(
      {
        repositoryRoot: snapshot.repositoryRoot,
        prompt,
        bundleDigest: artifact.metadata.bundleDigest,
      },
      coordinator,
    );
    await renderFinalRecord(record, io.stdout);
    outcome = terminalExit(record);
  } catch (error) {
    if (
      error instanceof CoordinatorError &&
      error.code === "COORDINATOR_INTERRUPTED"
    ) {
      outcome = 130;
    } else {
      diagnostic = diagnosticFor(error, phase);
      outcome =
        error instanceof CommandOutputError
          ? 1
          : phase === "app-server"
            ? 4
            : 3;
    }
  } finally {
    if (client !== undefined && !delegated) {
      try {
        await client.close();
      } catch {
        outcome = 4;
        diagnostic = "App Server cleanup failed.";
      }
    }
    if (lock !== undefined) {
      try {
        await dependencies.releaseProcessLock(lock);
      } catch {
        outcome = 3;
        diagnostic = "Process lock release failed.";
      }
    }
  }
  if (diagnostic !== undefined) await writeDiagnostic(io.stderr, diagnostic);
  return outcome;
}

export async function prepareCandidate(
  paths: RuntimePaths,
  dependencies: CommandDependencies,
  capabilities: readonly RequestedCapability[] = [],
) {
  // Derived from the resolved paths rather than the environment, so the bundle
  // and the doctor gate that admits it see the same root, canonicalized once.
  const capabilityInputs: CapabilityInputs =
    paths.oracleRoot === undefined
      ? {}
      : { oracle: { llmWikiRoot: paths.oracleRoot } };
  await dependencies.recoverInterruptedInstall(paths.stateRoot);
  const artifact = await dependencies.buildBundle({
    sourceRoot: paths.sourceRoot,
    artifactsRoot: join(paths.stateRoot, "bundles"),
    requestedCapabilities: capabilities,
    capabilityInputs,
    builderVersion: PRODUCT_VERSION,
  });
  await dependencies.installBundle(paths.stateRoot, artifact);
  const readiness = await dependencies.runDoctor({
    productVersion: PRODUCT_VERSION,
    platform: dependencies.platform ?? process.platform,
    platformVersion: dependencies.platformVersion ?? release(),
    paths,
    builderVersion: PRODUCT_VERSION,
    requestedCapabilities: capabilities,
    capabilityInputs,
    scratchParent: dependencies.scratchParent ?? (await realpath(tmpdir())),
    commandTimeoutMs: DOCTOR_TIMEOUT_MS,
  });
  if (readiness.exitCode !== 0)
    throw new ReadinessError(
      readiness.findings
        .filter((finding) => finding.severity === "blocker")
        .map((finding) => finding.code),
    );
  return artifact;
}

// The Oracle root is bound as a digest of its canonical form, never the path:
// the record has to be able to refuse a different wiki without storing where
// either one lives.
export function oracleRootDigest(paths: RuntimePaths): string | null {
  return paths.oracleRoot === undefined
    ? null
    : createHash("sha256").update(paths.oracleRoot, "utf8").digest("hex");
}

export function coordinatorDependencies(
  paths: RuntimePaths,
  bundleDigest: string,
  client: AppServerClient,
  io: CommandIO,
  dependencies: CommandDependencies,
  capabilities: readonly RequestedCapability[] = [],
): CoordinatorDependencies {
  const rendered = new Set<string>();
  return {
    client,
    stateRoot: paths.stateRoot,
    git: { resolveRepositoryRoot, readGitSnapshot, assertCleanGitSnapshot },
    threadStore: { readThreadRecord, writeThreadRecord },
    releaseIdentity: {
      bundleDigest,
      productVersion: PRODUCT_VERSION,
      codexVersion: REQUIRED_CODEX_VERSION,
      requestedCapabilities: capabilities,
      oracleRootDigest: oracleRootDigest(paths),
    },
    approvalInput: io.stdin ?? process.stdin,
    approvalWriter: dependencies.createTerminalApprovalPromptWriter(io.stderr),
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    subscribeInterrupt(listener) {
      process.on("SIGINT", listener);
      return () => process.off("SIGINT", listener);
    },
    interruptGraceMs: INTERRUPT_GRACE_MS,
    async reportThreadId(threadId) {
      await writeLine(io.stdout, `Thread ID: ${bounded(threadId)}`);
    },
    async reportTurnState(state) {
      for (const line of dependencies.renderTurnState(state)) {
        if (rendered.has(line)) continue;
        await writeLine(io.stdout, line);
        rendered.add(line);
      }
    },
  };
}

export function appServerInput(paths: RuntimePaths) {
  return {
    codexBinary: paths.codexBin,
    codexHome: paths.codexHome,
    productVersion: PRODUCT_VERSION,
    handshakeTimeoutMs: APP_SERVER_HANDSHAKE_TIMEOUT_MS,
    requestTimeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
    // Taken from the resolved paths rather than re-read from the environment,
    // so the child is told the same canonical root the bundle was rendered
    // against. `oracleRoot` is set only when the capability was requested.
    ...(paths.oracleRoot === undefined
      ? {}
      : { llmWikiRoot: paths.oracleRoot }),
  };
}

export function terminalExit(record: ThreadRecord): 0 | 1 | 130 {
  if (record.terminalStatus === "completed") return 0;
  if (record.terminalStatus === "interrupted") return 130;
  return 1;
}

export async function renderFinalRecord(
  record: ThreadRecord,
  output: CommandIO["stdout"],
): Promise<void> {
  await writeLine(output, `Starting HEAD: ${bounded(record.startingHead)}`);
  await writeLine(
    output,
    `Terminal HEAD: ${bounded(record.terminalHead ?? "unavailable")}`,
  );
  await writeLine(
    output,
    `Turn ID: ${bounded(record.turnId ?? "unavailable")}`,
  );
  await writeLine(output, `Terminal status: ${bounded(record.terminalStatus)}`);
  await writeLine(
    output,
    `Final Git status: ${bounded(record.finalGitStatus ?? "unavailable")}`,
  );
  // Absent rather than "unavailable": a run the App Server never measured has
  // no pressure to report, and a placeholder would read as one.
  const usage = formatTokenUsage(record.tokenUsage);
  if (usage !== null) await writeLine(output, usage);
}

export async function renderLocalRecord(
  record: ThreadRecord,
  output: CommandIO["stdout"],
): Promise<void> {
  await writeLine(output, `Thread ID: ${bounded(record.threadId)}`);
  await writeLine(output, `Repository: ${bounded(record.repositoryRoot)}`);
  await renderFinalRecord(record, output);
}

export async function writeLine(
  output: CommandIO["stdout"] | CommandIO["stderr"],
  value: string,
): Promise<void> {
  const line = bounded(value, MAX_WRITE_BYTES - 1);
  const bytes = `${line}\n`;
  try {
    if (output.destroyed === true) throw new Error("closed");
    const writable = output as Writable;
    if (
      typeof writable.once !== "function" ||
      typeof writable.removeListener !== "function"
    ) {
      output.write(bytes);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let completionTimer: NodeJS.Timeout | undefined;
      let cleanupTimer: NodeJS.Timeout | undefined;
      const removeErrorListener = () => {
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        writable.removeListener("error", onError);
      };
      const fail = (absorbLateError = false) => {
        if (settled) return;
        settled = true;
        if (completionTimer !== undefined) clearTimeout(completionTimer);
        if (absorbLateError) {
          cleanupTimer = setTimeout(
            removeErrorListener,
            LATE_WRITE_ERROR_CLEANUP_TIMEOUT_MS,
          );
          cleanupTimer.unref();
        } else {
          removeErrorListener();
        }
        reject(new CommandOutputError());
      };
      const onError = () => {
        if (settled) {
          removeErrorListener();
          return;
        }
        fail();
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        if (completionTimer !== undefined) clearTimeout(completionTimer);
        removeErrorListener();
        resolve();
      };
      writable.once("error", onError);
      completionTimer = setTimeout(
        () => fail(true),
        WRITE_COMPLETION_TIMEOUT_MS,
      );
      try {
        writable.write(bytes, (error) => {
          if (error) fail(true);
          else succeed();
        });
      } catch {
        fail();
      }
    });
  } catch {
    throw new CommandOutputError();
  }
}

async function writeDiagnostic(output: CommandIO["stderr"], value: string) {
  try {
    for (const line of value.split("\n")) await writeLine(output, line);
  } catch {
    // There is no safe secondary output channel after stderr fails.
  }
}

function bounded(value: string, limit = MAX_FIELD_BYTES): string {
  return boundedTerminalText(value, limit, TRUNCATION_MARKER);
}

export function diagnosticFor(error: unknown, phase: string): string {
  if (error instanceof CommandOutputError) return "Output stream failed.";
  if (
    error instanceof GitRuntimeError &&
    error.code === "UNSUPPORTED_GIT_SUBMODULE"
  ) {
    return "Submodules are unsupported in v0.1.";
  }
  if (error instanceof GitRuntimeError) {
    const dirtyWorktreeDiagnostic = diagnosticForDirtyWorktree(error);
    if (dirtyWorktreeDiagnostic !== undefined) return dirtyWorktreeDiagnostic;
  }
  if (error instanceof ReadinessError)
    return withCause("Candidate readiness failed", blockerList(error.blockers));
  // Resolving the runtime paths is preparation whatever phase the caller
  // labelled it: resume does it while still in its local phase, and reporting
  // a missing codex binary as a thread lookup failure sends the operator to
  // the wrong place.
  if (error instanceof RuntimePathError)
    return withCause("Runtime preparation failed", error.code);
  if (phase === "app-server") return "App Server operation failed.";
  if (phase === "local") return "Local thread lookup failed.";
  if (phase === "preflight")
    return withCause("Repository preflight failed", errorCode(error));
  return withCause("Runtime preparation failed", errorCode(error));
}

function diagnosticForDirtyWorktree(
  error: GitRuntimeError,
): string | undefined {
  if (
    error.code !== "GIT_WORKTREE_DIRTY" ||
    error.dirtyPathSummary === undefined ||
    error.dirtyPathSummary.paths.length === 0
  )
    return undefined;
  const { paths, omittedPathCount } = error.dirtyPathSummary;
  const omitted =
    omittedPathCount === 0 ? "" : `; ${omittedPathCount} path(s) omitted`;
  return `${withCause("Repository preflight failed", error.code)}\nAffected paths: ${paths
    .map((path) => bounded(path))
    .join(", ")}${omitted}.`;
}

function blockerList(blockers: readonly string[]): string | undefined {
  if (blockers.length === 0) return undefined;
  const reported = blockers.slice(0, MAX_REPORTED_BLOCKERS);
  const omitted = blockers.length - reported.length;
  return omitted === 0
    ? reported.join(", ")
    : `${reported.join(", ")} and ${omitted} more`;
}

// Only the stable error code, never the message or its cause.
function errorCode(error: unknown): string | undefined {
  if (
    error instanceof InstallError ||
    error instanceof ArtifactError ||
    error instanceof GitRuntimeError ||
    error instanceof RuntimePathError ||
    // Reachable only once a capability can be requested: renderBundle throws
    // this straight through buildBundle, and without it a refused capability
    // aborts the run with no name for why.
    error instanceof RenderError
  )
    return error.code;
  return undefined;
}

function withCause(headline: string, cause: string | undefined): string {
  return cause === undefined
    ? `${headline}.`
    : bounded(`${headline}: ${cause}.`);
}
