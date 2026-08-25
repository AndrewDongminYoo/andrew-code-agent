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
  // ponytail: the CLI refuses `--capability` on resume, so this is always the
  // empty set today. Step 4 of
  // docs/plans/2026-08-25-v0.2-oracle-capability.md derives the boundary from
  // the thread record and only then accepts a flag that agrees with it.
  _capabilities: readonly RequestedCapability[] = [],
): Promise<number> {
  let phase: "local" | "setup" | "app-server" = "local";
  let lock: ProcessLockHandle | undefined;
  let client: AppServerClient | undefined;
  let delegated = false;
  let outcome = 3;
  let diagnostic: string | undefined;
  try {
    const paths = await dependencies.resolveRuntimePaths();
    const existing = await dependencies.readThreadRecord(
      paths.stateRoot,
      threadId,
    );
    if (prompt === undefined) {
      await renderLocalRecord(existing, io.stdout);
      outcome = 0;
      return outcome;
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
    const artifact = await prepareCandidate(paths, dependencies);
    phase = "app-server";
    client = await dependencies.startAppServer(appServerInput(paths));
    const coordinator = coordinatorDependencies(
      paths,
      artifact.metadata.bundleDigest,
      client,
      io,
      dependencies,
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

async function safeDiagnostic(io: CommandIO, message: string): Promise<void> {
  try {
    await writeLine(io.stderr, message);
  } catch {
    // There is no safe secondary output channel after stderr fails.
  }
}
