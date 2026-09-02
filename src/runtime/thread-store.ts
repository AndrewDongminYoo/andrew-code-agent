/// <reference types="node" />

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { RequestedCapability } from "../constants.js";

export interface ThreadRecord {
  readonly threadId: string;
  readonly repositoryRoot: string;
  readonly startingHead: string;
  readonly terminalHead: string | null;
  readonly bundleDigest: string;
  readonly productVersion: string;
  readonly codexVersion: string;
  readonly turnId: string | null;
  readonly terminalStatus:
    "not-started" | "running" | "completed" | "failed" | "interrupted";
  readonly finalGitStatus: string | null;
  // What this thread was granted, and against which data scope. The set alone
  // does not hold the boundary: the same ["oracle"] can name two different
  // wikis, so the root is bound too, as a digest rather than the path.
  readonly requestedCapabilities: readonly RequestedCapability[];
  readonly oracleRootDigest: string | null;
  // The last measurement the App Server reported during the turn, or null
  // when it reported none and for every record written before the turn ran.
  readonly tokenUsage: {
    readonly totalTokens: number;
    readonly contextWindow: number | null;
  } | null;
}

export type ThreadStoreErrorCode =
  | "THREAD_ID_INVALID"
  | "THREAD_NOT_FOUND"
  | "THREAD_CORRUPT"
  | "THREAD_REPOSITORY_MISMATCH"
  | "THREAD_STORE_UNSAFE";

export class ThreadStoreError extends Error {
  readonly code: ThreadStoreErrorCode;

  constructor(code: ThreadStoreErrorCode, message: string) {
    super(message);
    this.name = "ThreadStoreError";
    this.code = code;
  }
}

const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const recordKeys = [
  "threadId",
  "repositoryRoot",
  "startingHead",
  "terminalHead",
  "bundleDigest",
  "productVersion",
  "codexVersion",
  "turnId",
  "terminalStatus",
  "finalGitStatus",
] as const;
// Schema 2 adds the capability binding. The key set is the discriminator —
// there is no version field — so a record written before it is migrated in
// memory to the empty grant and rewritten in the current shape.
const capabilityKeys = ["requestedCapabilities", "oracleRootDigest"] as const;
// Schema 3 adds the token usage measurement on the same terms.
const tokenUsageKeys = ["tokenUsage"] as const;
const schema1Keys = recordKeys;
const schema2Keys = [...recordKeys, ...capabilityKeys] as const;
const currentRecordKeys = [...schema2Keys, ...tokenUsageKeys] as const;
const oracleRootDigestPattern = /^[0-9a-f]{64}$/;
const terminalStatuses = new Set([
  "not-started",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export async function writeThreadRecord(
  stateRoot: string,
  record: ThreadRecord,
): Promise<void> {
  assertThreadId(record.threadId);
  const repositoryRoot = await canonicalRepository(record.repositoryRoot);
  const normalized = validateRecord({ ...record, repositoryRoot });
  const threadsRoot = join(stateRoot, "threads");
  await ensureThreadsDirectory(threadsRoot);
  const target = join(threadsRoot, `${record.threadId}.json`);
  const existing = await readRecordIfPresent(target);
  if (existing !== null && existing.threadId !== record.threadId) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Existing thread record ID does not match its filename.",
    );
  }
  if (existing !== null && existing.repositoryRoot !== repositoryRoot) {
    throw new ThreadStoreError(
      "THREAD_REPOSITORY_MISMATCH",
      "Thread ID already belongs to a different repository.",
    );
  }

  const temporary = join(
    threadsRoot,
    `.${record.threadId}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.chmod(0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, target);
    const directory = await open(threadsRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof ThreadStoreError) throw error;
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Unable to atomically write thread record.",
    );
  }
}

export async function readThreadRecord(
  stateRoot: string,
  threadId: string,
  repositoryRoot?: string,
): Promise<ThreadRecord> {
  assertThreadId(threadId);
  await requireReadableThreadsDirectory(join(stateRoot, "threads"));
  const record = await readRecord(
    join(stateRoot, "threads", `${threadId}.json`),
  );
  if (record.threadId !== threadId) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record ID does not match its filename.",
    );
  }
  if (repositoryRoot !== undefined) {
    const expectedRoot = await canonicalRepository(repositoryRoot);
    if (record.repositoryRoot !== expectedRoot) {
      throw new ThreadStoreError(
        "THREAD_REPOSITORY_MISMATCH",
        "Thread record belongs to a different repository.",
      );
    }
  }
  return record;
}

export async function findLatestThreadRecord(
  stateRoot: string,
  repositoryRoot: string,
): Promise<ThreadRecord> {
  const expectedRoot = await canonicalRepository(repositoryRoot);
  const threadsRoot = join(stateRoot, "threads");
  await requireReadableThreadsDirectory(threadsRoot);
  let entries;
  try {
    entries = await readdir(threadsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ThreadStoreError(
        "THREAD_NOT_FOUND",
        "No thread records exist.",
      );
    }
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Unable to inspect thread store.",
    );
  }
  let latest: { record: ThreadRecord; mtimeNs: bigint } | null = null;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ThreadStoreError(
        "THREAD_CORRUPT",
        `Thread metadata is corrupt: ${entry.name}`,
      );
    }
    const path = join(threadsRoot, entry.name);
    const record = await readRecord(path);
    const filenameThreadId = entry.name.slice(0, -".json".length);
    if (record.threadId !== filenameThreadId) {
      throw new ThreadStoreError(
        "THREAD_CORRUPT",
        `Thread record ID does not match its filename: ${entry.name}`,
      );
    }
    if (record.repositoryRoot !== expectedRoot) continue;
    const metadata = await stat(path, { bigint: true });
    if (
      latest === null ||
      metadata.mtimeNs > latest.mtimeNs ||
      (metadata.mtimeNs === latest.mtimeNs &&
        record.threadId > latest.record.threadId)
    ) {
      latest = { record, mtimeNs: metadata.mtimeNs };
    }
  }
  if (latest === null) {
    throw new ThreadStoreError(
      "THREAD_NOT_FOUND",
      "No thread record exists for this repository.",
    );
  }
  return latest.record;
}

function assertThreadId(threadId: string): void {
  if (!threadIdPattern.test(threadId)) {
    throw new ThreadStoreError(
      "THREAD_ID_INVALID",
      "Thread ID is not a safe filename component.",
    );
  }
}

async function canonicalRepository(repositoryRoot: string): Promise<string> {
  try {
    const canonical = await realpath(repositoryRoot);
    if (!(await lstat(canonical)).isDirectory())
      throw new Error("not a directory");
    return canonical;
  } catch {
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Repository root cannot be canonicalized.",
    );
  }
}

async function ensureThreadsDirectory(threadsRoot: string): Promise<void> {
  try {
    await mkdir(threadsRoot, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new ThreadStoreError(
        "THREAD_STORE_UNSAFE",
        "Unable to create thread store.",
      );
    }
  }
  const metadata = await lstat(threadsRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Thread store is not owner-only and ordinary.",
    );
  }
}

async function requireReadableThreadsDirectory(
  threadsRoot: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(threadsRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ThreadStoreError(
        "THREAD_NOT_FOUND",
        "No thread records exist.",
      );
    }
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Unable to inspect thread store.",
    );
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Thread store is not owner-only and ordinary.",
    );
  }
}

async function readRecordIfPresent(path: string): Promise<ThreadRecord | null> {
  try {
    return await readRecord(path);
  } catch (error) {
    if (error instanceof ThreadStoreError && error.code === "THREAD_NOT_FOUND")
      return null;
    throw error;
  }
}

async function readRecord(path: string): Promise<ThreadRecord> {
  let metadata;
  let bytes: Buffer;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    metadata = await file.stat();
    bytes = await file.readFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ThreadStoreError(
        "THREAD_NOT_FOUND",
        "Thread record was not found.",
      );
    }
    throw new ThreadStoreError(
      "THREAD_STORE_UNSAFE",
      "Unable to read thread record.",
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record is not an owner-only regular file.",
    );
  }
  try {
    const record = validateRecord(JSON.parse(bytes.toString("utf8")));
    let repositoryRoot: string;
    try {
      repositoryRoot = await canonicalRepository(record.repositoryRoot);
    } catch {
      throw new ThreadStoreError(
        "THREAD_CORRUPT",
        "Thread record repository root is invalid.",
      );
    }
    return { ...record, repositoryRoot };
  } catch (error) {
    if (error instanceof ThreadStoreError) throw error;
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record contains invalid JSON.",
    );
  }
}

function validateRecord(value: unknown): ThreadRecord {
  if (!isObject(value)) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record has an invalid schema.",
    );
  }
  if (hasOnlyKeys(value, schema1Keys)) {
    return validateRecord({
      ...value,
      requestedCapabilities: [],
      oracleRootDigest: null,
    });
  }
  if (hasOnlyKeys(value, schema2Keys)) {
    return validateRecord({ ...value, tokenUsage: null });
  }
  if (!hasOnlyKeys(value, currentRecordKeys)) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record has an invalid schema.",
    );
  }
  if (
    typeof value.threadId !== "string" ||
    !threadIdPattern.test(value.threadId) ||
    typeof value.repositoryRoot !== "string" ||
    typeof value.startingHead !== "string" ||
    !nullableString(value.terminalHead) ||
    typeof value.bundleDigest !== "string" ||
    typeof value.productVersion !== "string" ||
    typeof value.codexVersion !== "string" ||
    !nullableString(value.turnId) ||
    typeof value.terminalStatus !== "string" ||
    !terminalStatuses.has(value.terminalStatus) ||
    !nullableString(value.finalGitStatus) ||
    !isCapabilityList(value.requestedCapabilities) ||
    !isOracleRootDigest(value.oracleRootDigest) ||
    !isTokenUsage(value.tokenUsage)
  ) {
    throw new ThreadStoreError(
      "THREAD_CORRUPT",
      "Thread record has invalid field values.",
    );
  }
  return value as unknown as ThreadRecord;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityList(
  value: unknown,
): value is readonly RequestedCapability[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => entry === "oracle") &&
    new Set(value).size === value.length
  );
}

function isOracleRootDigest(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && oracleRootDigestPattern.test(value))
  );
}

function isTokenUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value) || !hasOnlyKeys(value, ["totalTokens", "contextWindow"]))
    return false;
  return (
    isTokenCount(value.totalTokens) &&
    (value.contextWindow === null || isTokenCount(value.contextWindow, 1))
  );
}

function isTokenCount(value: unknown, minimum = 0): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
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
