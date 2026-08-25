/// <reference types="node" />

import type { ProcessLockHandle } from "../runtime/lock.js";
import type { AppServerClient } from "../app-server/client.js";
import type { RequestedCapability } from "../constants.js";
import { ThreadStoreError } from "../runtime/thread-store.js";
import { GitRuntimeError } from "../runtime/git.js";
import {
  appServerInput,
  CommandOutputError,
  coordinatorDependencies,
  defaultCommandDependencies,
  diagnosticFor,
  oracleRootDigest,
  prepareCandidate,
  renderFinalRecord,
  renderLocalRecord,
  terminalExit,
  writeLine,
  type CommandDependencies,
  type CommandIO,
} from "./run.js";

const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID_PATTERN.test(value);
}

export async function resumeCommand(
  threadId: string,
  prompt: string | undefined,
  io: CommandIO,
  dependencies: CommandDependencies = defaultCommandDependencies,
  // Trails the injection seam so the existing call sites keep their shape.
  // A flag here can only agree with the record or be refused; the boundary
  // itself is always derived from what the thread was granted.
  capabilities: readonly RequestedCapability[] = [],
): Promise<number> {
  let phase: "local" | "setup" | "app-server" = "local";
  let lock: ProcessLockHandle | undefined;
  let client: AppServerClient | undefined;
  let delegated = false;
  let outcome = 3;
  let diagnostic: string | undefined;
  try {
    // The state root does not depend on the capability set, so the first pass
    // is only how the record is found. A thread granted nothing needs no
    // second pass, which keeps resuming a pre-capability thread identical to
    // what it was before this step.
    const locating = await dependencies.resolveRuntimePaths();
    const existing = await dependencies.readThreadRecord(
      locating.stateRoot,
      threadId,
    );
    // The read-only form starts no turn and no App Server, so there is nothing
    // for the capability boundary to protect and it is checked below instead.
    // Gating it would make inspecting a granted thread fail whenever the flag
    // is absent or the root has since moved.
    if (prompt === undefined) {
      await renderLocalRecord(existing, io.stdout);
      outcome = 0;
      return outcome;
    }
    const granted = existing.requestedCapabilities;
    if (!sameCapabilitySet(capabilities, granted)) {
      await safeDiagnostic(io, "Resume refused: THREAD_CAPABILITY_MISMATCH.");
      return 3;
    }
    const paths =
      granted.length === 0
        ? locating
        : await dependencies.resolveRuntimePaths({ capabilities: granted });
    if (oracleRootDigest(paths) !== existing.oracleRootDigest) {
      // Neither root is named: the codes say the scope moved, and step 5's
      // no-leak requirement applies to diagnostics as much as to the bundle.
      await safeDiagnostic(io, "Resume refused: THREAD_ORACLE_ROOT_CHANGED.");
      return 3;
    }
    const snapshot = await dependencies.readGitSnapshot(
      existing.repositoryRoot,
    );
    if (snapshot.repositoryRoot !== existing.repositoryRoot) {
      throw new Error("repository identity changed");
    }
    dependencies.assertCleanGitSnapshot(snapshot);
    if (
      (existing.terminalHead !== null &&
        !isGitObjectId(existing.terminalHead)) ||
      !isGitObjectId(snapshot.head)
    ) {
      throw new Error("invalid Git object ID");
    }
    if (
      existing.terminalHead !== null &&
      existing.terminalHead !== snapshot.head
    ) {
      await writeLine(
        io.stdout,
        `Repository HEAD changed: stored ${existing.terminalHead}, current ${snapshot.head}.`,
      );
    }
    phase = "setup";
    await dependencies.initializeRuntimeState(paths);
    lock = await dependencies.acquireProcessLock(paths.stateRoot);
    const artifact = await prepareCandidate(paths, dependencies, granted);
    phase = "app-server";
    client = await dependencies.startAppServer(appServerInput(paths));
    const coordinator = coordinatorDependencies(
      paths,
      artifact.metadata.bundleDigest,
      client,
      io,
      dependencies,
      granted,
    );
    delegated = true;
    const record = await dependencies.resumeThread(
      threadId,
      prompt,
      coordinator,
    );
    await renderFinalRecord(record, io.stdout);
    outcome = terminalExit(record);
  } catch (error) {
    diagnostic = diagnosticFor(error, phase);
    outcome =
      error instanceof CommandOutputError
        ? 1
        : error instanceof ThreadStoreError && error.code === "THREAD_NOT_FOUND"
          ? 1
          : phase === "app-server"
            ? 4
            : 3;
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
  if (diagnostic !== undefined) await safeDiagnostic(io, diagnostic);
  return outcome;
}

function sameCapabilitySet(
  requested: readonly RequestedCapability[],
  granted: readonly RequestedCapability[],
): boolean {
  const left = [...new Set(requested)].sort();
  const right = [...new Set(granted)].sort();
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

async function safeDiagnostic(io: CommandIO, message: string): Promise<void> {
  try {
    await writeLine(io.stderr, message);
  } catch {
    // There is no safe secondary output channel after stderr fails.
  }
}
