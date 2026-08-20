/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ProcessLockOwner {
  readonly pid: number;
  readonly processStartMarker: string;
  readonly hostname: string;
  readonly command: readonly string[];
  readonly acquiredAt: string;
}

export type ProcessLockDiagnosis =
  | { readonly status: "absent" }
  | {
      readonly status: "live" | "stale" | "unknown";
      readonly owner: ProcessLockOwner;
    }
  | { readonly status: "malformed" };

export type ProcessLockErrorCode =
  | "PROCESS_IDENTITY_UNAVAILABLE"
  | "PROCESS_LOCK_HELD"
  | "PROCESS_LOCK_STALE"
  | "PROCESS_LOCK_MALFORMED"
  | "PROCESS_LOCK_NOT_OWNER";

export class ProcessLockError extends Error {
  readonly code: ProcessLockErrorCode;

  constructor(code: ProcessLockErrorCode, message: string) {
    super(message);
    this.name = "ProcessLockError";
    this.code = code;
  }
}

const lockHandleBrand = Symbol("ProcessLockHandle");

export interface ProcessLockHandle {
  readonly [lockHandleBrand]: true;
}

interface InternalLockHandle extends ProcessLockHandle {
  readonly lockPath: string;
  readonly ownerBytes: Buffer;
  readonly owner: ProcessLockOwner;
}

const activeHandles = new WeakSet<object>();

export async function inspectProcessLock(
  stateRoot: string,
): Promise<ProcessLockDiagnosis> {
  const lockPath = join(stateRoot, "run.lock");
  let metadata;
  let bytes: Buffer;
  let file;
  try {
    file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    metadata = await file.stat();
    bytes = await file.readFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return { status: "absent" };
    return { status: "malformed" };
  } finally {
    await file?.close().catch(() => undefined);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    return { status: "malformed" };
  }
  const owner = parseOwner(bytes);
  if (owner === null) return { status: "malformed" };
  if (owner.hostname !== hostname()) return { status: "unknown", owner };
  let actualMarker: string | null;
  try {
    actualMarker = await readProcessStartMarker(owner.pid);
  } catch {
    return { status: "unknown", owner };
  }
  return actualMarker === null || actualMarker !== owner.processStartMarker
    ? { status: "stale", owner }
    : { status: "live", owner };
}

export async function acquireProcessLock(
  stateRoot: string,
  command: readonly string[] = process.argv,
): Promise<ProcessLockHandle> {
  const lockPath = join(stateRoot, "run.lock");
  const marker = await requireCurrentProcessMarker();
  const owner: ProcessLockOwner = {
    pid: process.pid,
    processStartMarker: marker,
    hostname: hostname(),
    command: [...command],
    acquiredAt: new Date().toISOString(),
  };
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  let file;
  try {
    file = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const diagnosis = await inspectProcessLock(stateRoot);
    if (diagnosis.status === "stale") {
      throw new ProcessLockError(
        "PROCESS_LOCK_STALE",
        "A stale process lock is present.",
      );
    }
    if (diagnosis.status === "malformed") {
      throw new ProcessLockError(
        "PROCESS_LOCK_MALFORMED",
        "A malformed process lock is present.",
      );
    }
    throw new ProcessLockError(
      "PROCESS_LOCK_HELD",
      "The process lock is already held.",
    );
  }
  try {
    await file.chmod(0o600);
    await file.writeFile(ownerBytes);
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  await file.close();
  const handle: InternalLockHandle = {
    [lockHandleBrand]: true,
    lockPath,
    ownerBytes,
    owner,
  };
  activeHandles.add(handle);
  return handle;
}

export async function releaseProcessLock(
  handle: ProcessLockHandle,
): Promise<void> {
  if (
    typeof handle !== "object" ||
    handle === null ||
    !activeHandles.has(handle)
  ) {
    throw new ProcessLockError(
      "PROCESS_LOCK_NOT_OWNER",
      "Lock release requires its live acquisition handle.",
    );
  }
  const internal = handle as InternalLockHandle;
  const marker = await requireCurrentProcessMarker();
  if (
    internal.owner.pid !== process.pid ||
    internal.owner.processStartMarker !== marker
  ) {
    throw new ProcessLockError(
      "PROCESS_LOCK_NOT_OWNER",
      "The current process does not own this lock.",
    );
  }
  let persisted: Buffer;
  let persistedFile;
  try {
    persistedFile = await open(
      internal.lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await persistedFile.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new ProcessLockError(
        "PROCESS_LOCK_NOT_OWNER",
        "The acquired lock record is unsafe.",
      );
    }
    persisted = await persistedFile.readFile();
  } catch {
    throw new ProcessLockError(
      "PROCESS_LOCK_NOT_OWNER",
      "The acquired lock record no longer exists.",
    );
  } finally {
    await persistedFile?.close().catch(() => undefined);
  }
  if (!persisted.equals(internal.ownerBytes)) {
    throw new ProcessLockError(
      "PROCESS_LOCK_NOT_OWNER",
      "The acquired lock record has changed.",
    );
  }
  await unlink(internal.lockPath);
  activeHandles.delete(handle);
}

async function requireCurrentProcessMarker(): Promise<string> {
  let marker: string | null;
  try {
    marker = await readProcessStartMarker(process.pid);
  } catch {
    marker = null;
  }
  if (marker === null) {
    throw new ProcessLockError(
      "PROCESS_IDENTITY_UNAVAILABLE",
      "Current process start identity is unavailable.",
    );
  }
  return marker;
}

async function readProcessStartMarker(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
      },
    );
    return stdout.trim().length === 0 ? null : stdout;
  } catch (error) {
    if (
      isNodeError(error) &&
      typeof error.code === "number" &&
      error.code === 1
    )
      return null;
    throw error;
  }
}

function parseOwner(bytes: Buffer): ProcessLockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "pid",
      "processStartMarker",
      "hostname",
      "command",
      "acquiredAt",
    ])
  )
    return null;
  if (
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.processStartMarker !== "string" ||
    value.processStartMarker.length === 0 ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    !Array.isArray(value.command) ||
    !value.command.every((part) => typeof part === "string") ||
    typeof value.acquiredAt !== "string" ||
    !isIsoTimestamp(value.acquiredAt)
  )
    return null;
  return value as unknown as ProcessLockOwner;
}

function isIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function currentUid(): number {
  return process.getuid?.() ?? -1;
}
