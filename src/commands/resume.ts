/// <reference types="node" />

import type { ProcessLockHandle } from "../runtime/lock.js";
import type { AppServerClient } from "../app-server/client.js";
import { ThreadStoreError } from "../runtime/thread-store.js";
import {
  appServerInput,
  CommandOutputError,
  coordinatorDependencies,
  defaultCommandDependencies,
  prepareCandidate,
  renderFinalRecord,
  renderLocalRecord,
  terminalExit,
  writeLine,
  type CommandDependencies,
  type CommandIO,
} from "./run.js";

export async function resumeCommand(
  threadId: string,
  prompt: string | undefined,
  io: CommandIO,
  dependencies: CommandDependencies = defaultCommandDependencies,
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
    diagnostic =
      phase === "app-server"
        ? "App Server operation failed."
        : phase === "local"
          ? "Local thread lookup failed."
          : "Runtime preparation failed.";
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
