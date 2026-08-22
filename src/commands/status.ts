/// <reference types="node" />

import type { ProcessLockHandle } from "../runtime/lock.js";
import type { AppServerClient } from "../app-server/client.js";
import { resolveRepositoryRoot } from "../runtime/git.js";
import { ThreadStoreError } from "../runtime/thread-store.js";
import {
  appServerInput,
  CommandOutputError,
  coordinatorDependencies,
  defaultCommandDependencies,
  renderLocalRecord,
  writeLine,
  type CommandDependencies,
  type CommandIO,
} from "./run.js";

export async function statusCommand(
  threadId: string | undefined,
  io: CommandIO,
  dependencies: CommandDependencies = defaultCommandDependencies,
  cwd = process.cwd(),
): Promise<number> {
  let phase: "local" | "app-server" = "local";
  let lock: ProcessLockHandle | undefined;
  let client: AppServerClient | undefined;
  let delegated = false;
  let outcome = 1;
  let diagnostic: string | undefined;
  try {
    const paths = await dependencies.resolveRuntimePaths();
    if (threadId === undefined) {
      const repositoryRoot = await resolveRepositoryRoot(cwd);
      const record = await dependencies.findLatestThreadRecord(
        paths.stateRoot,
        repositoryRoot,
      );
      await renderLocalRecord(record, io.stdout);
      outcome = 0;
      return outcome;
    }
    const local = await dependencies.readThreadRecord(
      paths.stateRoot,
      threadId,
    );
    lock = await dependencies.acquireProcessLock(paths.stateRoot);
    phase = "app-server";
    client = await dependencies.startAppServer(appServerInput(paths));
    const coordinator = coordinatorDependencies(
      paths,
      local.bundleDigest,
      client,
      io,
      dependencies,
    );
    delegated = true;
    const status = await dependencies.readLiveStatus(threadId, coordinator);
    await writeLine(io.stdout, "Persisted thread record:");
    await renderLocalRecord(status.record, io.stdout);
    await writeLine(
      io.stdout,
      `Live App Server status: ${status.liveStatus.type}`,
    );
    outcome = 0;
  } catch (error) {
    diagnostic =
      phase === "app-server"
        ? "App Server status failed."
        : "Local thread lookup failed.";
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
