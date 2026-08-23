import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { BundleArtifact, BundleMetadata } from "./artifact.js";
import type { FileMode } from "./manifest.js";

const activeName = "active-install.json";
const journalName = "install-journal.json";
const preimagesName = "install-preimages";
const managedName = "codex-home";
const metadataName = "bundle-metadata.json";

export type FileLifecycle = "immutable" | "reset-before-run";

export interface OwnedFile {
  readonly path: string;
  readonly mode: FileMode;
  readonly sha256: string;
  readonly lifecycle: FileLifecycle;
}

export interface ActiveInstallMetadata {
  readonly schemaVersion: 2;
  readonly bundleDigest: string;
  readonly files: readonly OwnedFile[];
}

interface LegacyOwnedFile {
  readonly path: string;
  readonly mode: FileMode;
  readonly sha256: string;
}

interface LegacyActiveInstallMetadata {
  readonly schemaVersion: 1;
  readonly bundleDigest: string;
  readonly files: readonly LegacyOwnedFile[];
}

type StoredActiveInstallMetadata =
  | ActiveInstallMetadata
  | LegacyActiveInstallMetadata;

export type FileFingerprint =
  | { readonly kind: "absent" }
  | {
      readonly kind: "file";
      readonly mode: FileMode;
      readonly sha256: string;
    };

export interface InstallOperation {
  readonly type: "write" | "remove";
  readonly path: string;
  readonly before: FileFingerprint;
  readonly after: FileFingerprint;
  readonly preimage: string | null;
}

export interface DirectoryWitness {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

export interface InstallJournal {
  readonly version: 1;
  readonly transactionId: string;
  readonly previousDigest: string | null;
  readonly candidateDigest: string;
  readonly previousActive: StoredActiveInstallMetadata | null;
  readonly candidateActive: StoredActiveInstallMetadata;
  readonly operations: readonly InstallOperation[];
  readonly createdDirectories: readonly string[];
  readonly directoryWitnesses: readonly DirectoryWitness[];
  readonly stateRootCreated: boolean;
  readonly preimagesRootCreated: boolean;
}

export interface InstallInspection {
  readonly active: ActiveInstallMetadata | null;
  readonly journal: {
    readonly version: 1;
    readonly previousDigest: string | null;
    readonly candidateDigest: string;
    readonly operationCount: number;
  } | null;
  readonly issues: readonly string[];
}

export type InstallErrorCode =
  | "INVALID_BUNDLE"
  | "INVALID_STATE"
  | "RECOVERY_REQUIRED"
  | "OWNERSHIP_CONFLICT"
  | "MANAGED_STATE_DRIFT"
  | "INSTALL_FAILED"
  | "ROLLBACK_FAILED"
  | "RECOVERY_CONFLICT";

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  readonly rollbackCause?: unknown;

  constructor(
    code: InstallErrorCode,
    message: string,
    options?: { cause?: unknown; rollbackCause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "InstallError";
    this.code = code;
    if (options?.rollbackCause !== undefined)
      this.rollbackCause = options.rollbackCause;
  }
}

type CheckpointHook = (checkpoint: string) => void | Promise<void>;
let checkpointHook: CheckpointHook | undefined;

/** Test-only deterministic failure or interruption injection outside public install inputs. */
export function __setInstallCheckpointHookForTests(
  hook: CheckpointHook | undefined,
): void {
  checkpointHook = hook;
}

interface VerifiedCandidate {
  readonly artifactRoot: string;
  readonly metadata: BundleMetadata;
  readonly active: ActiveInstallMetadata;
}

const absent: FileFingerprint = { kind: "absent" };

export async function inspectInstallState(
  stateRoot: string,
): Promise<InstallInspection> {
  const issues: string[] = [];
  let active: ActiveInstallMetadata | null = null;
  let journal: InstallJournal | null = null;
  let layout: ControlLayout | null = null;
  try {
    assertStateRootArgument(stateRoot);
    layout = await inspectControlLayout(stateRoot);
  } catch {
    issues.push("INVALID_CONTROL_STATE");
    return { active: null, journal: null, issues };
  }
  try {
    const storedActive = await readActive(stateRoot);
    active = storedActive === null ? null : migrateActive(storedActive);
  } catch {
    issues.push("INVALID_ACTIVE_INSTALL");
  }
  try {
    journal = await readJournal(stateRoot);
  } catch {
    issues.push("INVALID_INSTALL_JOURNAL");
  }
  if (active !== null) {
    try {
      await verifyManagedState(stateRoot, active);
    } catch {
      issues.push("MANAGED_STATE_DRIFT");
    }
  }
  if (journal !== null) {
    try {
      await preflightRecovery(stateRoot, journal);
    } catch {
      issues.push("INVALID_RECOVERY_MATERIAL");
    }
  }
  if (hasOrphanTransactionControl(layout, journal))
    issues.push("ORPHAN_TRANSACTION_CONTROL");
  return {
    active,
    journal:
      journal === null
        ? null
        : {
            version: 1,
            previousDigest: journal.previousDigest,
            candidateDigest: journal.candidateDigest,
            operationCount: journal.operations.length,
          },
    issues,
  };
}

export async function installBundle(
  stateRoot: string,
  artifact: BundleArtifact,
): Promise<void> {
  const candidate = await verifyCandidate(artifact);
  assertStateRootArgument(stateRoot);
  const layout = await inspectControlLayout(stateRoot);
  const existingJournal = await readJournal(stateRoot);
  if (existingJournal !== null)
    throw new InstallError(
      "RECOVERY_REQUIRED",
      "An interrupted install requires explicit recovery.",
    );
  if (hasOrphanTransactionControl(layout, existingJournal))
    throw new InstallError(
      "INVALID_STATE",
      "Orphan transaction control state requires housekeeping.",
    );
  const stored = await readActive(stateRoot);
  const previous = stored === null ? null : migrateActive(stored);
  await verifyManagedState(stateRoot, previous);
  if (previous?.bundleDigest === candidate.active.bundleDigest) {
    if (JSON.stringify(previous) !== JSON.stringify(candidate.active))
      throw new InstallError(
        "INVALID_STATE",
        "Active metadata does not match the candidate identity.",
      );
    await resetManagedFiles(stateRoot, candidate);
    return;
  }
  await assertResetOwnership(stateRoot, previous, candidate);
  let transaction = await prepareTransaction(
    stateRoot,
    stored,
    candidate,
    layout,
  );
  let journalPublished = false;
  try {
    transaction = await publishTransaction(stateRoot, transaction);
    journalPublished = true;
    await checkpointHook?.("journal-published");
    await applyOperations(stateRoot, transaction, candidate.artifactRoot);
    await atomicJson(
      resolve(stateRoot, activeName),
      transaction.candidateActive,
      0o600,
    );
    await checkpointHook?.("active-metadata-published");
    await verifyManagedState(
      stateRoot,
      migrateActive(transaction.candidateActive),
    );
    await checkpointHook?.("installation-verified");
    await rm(resolve(stateRoot, journalName));
    journalPublished = false;
    await resetManagedFiles(stateRoot, candidate);
    try {
      await checkpointHook?.("post-commit-cleanup");
      await cleanupCommitted(stateRoot, transaction);
    } catch {
      // Journal removal is the irreversible commit point. Orphan control state
      // remains owner-only and is surfaced by inspection for later housekeeping.
    }
  } catch (cause) {
    if (!journalPublished) {
      await cleanupUnpublished(stateRoot, transaction);
      throw cause;
    }
    try {
      await restorePreviousState(stateRoot, transaction);
      await clearTransaction(stateRoot, transaction);
    } catch (rollbackCause) {
      throw new InstallError(
        "ROLLBACK_FAILED",
        "Install rollback failed; recovery state was retained.",
        { cause, rollbackCause },
      );
    }
    throw new InstallError(
      "INSTALL_FAILED",
      "Bundle installation failed and was rolled back.",
      { cause },
    );
  }
}

export async function recoverInterruptedInstall(
  stateRoot: string,
): Promise<void> {
  assertStateRootArgument(stateRoot);
  const layout = await inspectControlLayout(stateRoot);
  const journal = await readJournal(stateRoot);
  if (journal === null) {
    if (hasOrphanTransactionControl(layout, null))
      throw new InstallError(
        "INVALID_STATE",
        "Orphan transaction control state requires housekeeping.",
      );
    return;
  }
  if (hasOrphanTransactionControl(layout, journal))
    throw new InstallError(
      "INVALID_STATE",
      "Install transaction control state is invalid.",
    );
  await preflightRecovery(stateRoot, journal);
  await restorePreviousState(stateRoot, journal);
  await clearTransaction(stateRoot, journal);
}

function assertStateRootArgument(stateRoot: string): void {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot))
    throw new InstallError(
      "INVALID_STATE",
      "State root must be an absolute path.",
    );
}

async function verifyCandidate(
  artifact: BundleArtifact,
): Promise<VerifiedCandidate> {
  try {
    if (
      !isRecord(artifact) ||
      !onlyKeys(artifact, ["artifactRoot", "metadata"]) ||
      typeof artifact.artifactRoot !== "string" ||
      !isAbsolute(artifact.artifactRoot)
    )
      throw new Error("input");
    const rootStat = await lstat(artifact.artifactRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (await realpath(artifact.artifactRoot)) !== resolve(artifact.artifactRoot)
    )
      throw new Error("root");
    const metadata = validateBundleMetadata(artifact.metadata);
    const metadataBytes = await readRegular(
      resolve(artifact.artifactRoot, metadataName),
    );
    if (
      !metadataBytes.equals(
        Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
      )
    )
      throw new Error("metadata bytes");
    const found = await readArtifactClosure(artifact.artifactRoot);
    const expected = new Set([
      metadataName,
      ...metadata.files.map((file) => file.path),
    ]);
    if (
      found.size !== expected.size ||
      [...found].some((path) => !expected.has(path))
    )
      throw new Error("closure");
    const digestFiles: { path: string; mode: FileMode; bytes: Buffer }[] = [];
    for (const file of metadata.files) {
      const target = resolvePortable(artifact.artifactRoot, file.path);
      const stat = await lstat(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        normalizeMode(stat.mode) !== file.mode
      )
        throw new Error("type or mode");
      const bytes = await readFile(target);
      if (sha256(bytes) !== file.sha256) throw new Error("hash");
      digestFiles.push({ path: file.path, mode: file.mode, bytes });
    }
    if (computeBundleDigest(metadata, digestFiles) !== metadata.bundleDigest)
      throw new Error("digest");
    return {
      artifactRoot: artifact.artifactRoot,
      metadata,
      active: {
        schemaVersion: 2,
        bundleDigest: metadata.bundleDigest,
        files: withLifecycle(metadata.files),
      },
    };
  } catch (error) {
    throw new InstallError("INVALID_BUNDLE", "Candidate bundle is invalid.", {
      cause: error,
    });
  }
}

function validateBundleMetadata(value: unknown): BundleMetadata {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "sourceRevision",
      "manifestDigest",
      "bundleDigest",
      "builderVersion",
      "requestedCapabilities",
      "enabledCapabilities",
      "files",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceRevision !== "string" ||
    !isDigest(value.manifestDigest) ||
    !isDigest(value.bundleDigest) ||
    typeof value.builderVersion !== "string" ||
    value.builderVersion.length === 0 ||
    !stringArray(value.requestedCapabilities) ||
    !stringArray(value.enabledCapabilities) ||
    !Array.isArray(value.files)
  )
    throw new Error("metadata schema");
  assertSortedUnique(value.requestedCapabilities);
  assertSortedUnique(value.enabledCapabilities);
  const paths: string[] = [];
  for (const file of value.files) {
    validateOwnedFile(file, true);
    paths.push(file.path);
  }
  assertSortedUnique(paths);
  assertCaseFoldUnique(paths);
  return value as unknown as BundleMetadata;
}

function validateOwnedFile(
  value: unknown,
  candidate: boolean,
  lifecycle = false,
): asserts value is OwnedFile {
  if (
    !isRecord(value) ||
    !onlyKeys(
      value,
      lifecycle
        ? ["path", "mode", "sha256", "lifecycle"]
        : ["path", "mode", "sha256"],
    ) ||
    typeof value.path !== "string" ||
    !isFileMode(value.mode) ||
    !isDigest(value.sha256) ||
    // The class is a function of the path, not independent data. A record
    // claiming otherwise would let a forged entry turn off the digest check
    // on a file that must stay immutable.
    (lifecycle && value.lifecycle !== lifecycleFor(value.path))
  )
    throw new Error("file metadata");
  assertPortablePath(value.path);
  if (candidate && isProtectedPath(value.path))
    throw new Error("protected path");
}

function assertPortablePath(path: string): void {
  if (
    path.length === 0 ||
    !/^[\x20-\x7e]+$/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    path === metadataName ||
    path.split("/").some((part) => part.startsWith(".install-"))
  )
    throw new Error("portable path");
}

function isProtectedPath(path: string): boolean {
  const first = path.split("/", 1)[0]?.toLowerCase() ?? "";
  const protectedNames = new Set([
    "auth",
    "auth" + ".json",
    "authentication",
    "sessions",
    "session",
    "threads",
    "thread",
    "rollouts",
    "rollout",
    "logs",
    "log",
    "cache",
    "desktop",
    "runtime",
    "runtime-state",
    "history.jsonl",
    "shell_snapshots",
    "tmp",
  ]);
  return (
    protectedNames.has(first) ||
    /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3|log)(?:$|\/)/i.test(path)
  );
}

async function readArtifactClosure(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (!contained(root, target) || entry.isSymbolicLink())
        throw new Error("artifact link");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile())
        found.add(relative(root, target).split(sep).join("/"));
      else throw new Error("artifact type");
    }
  }
  await visit(root);
  return found;
}

function computeBundleDigest(
  metadata: BundleMetadata,
  files: readonly { path: string; mode: FileMode; bytes: Buffer }[],
): string {
  const hash = createHash("sha256");
  for (const value of [
    "andrew-code-agent.bundle.v1",
    "sourceRevision",
    metadata.sourceRevision,
    "manifestDigest",
    metadata.manifestDigest,
    "builderVersion",
    metadata.builderVersion,
    "requestedCapabilities",
    String(metadata.requestedCapabilities.length),
    ...metadata.requestedCapabilities,
    "enabledCapabilities",
    String(metadata.enabledCapabilities.length),
    ...metadata.enabledCapabilities,
    "files",
    String(files.length),
  ])
    updateFrame(hash, value);
  for (const file of files) {
    updateFrame(hash, file.path);
    updateFrame(hash, file.mode);
    updateFrame(hash, file.bytes);
  }
  return hash.digest("hex");
}

function updateFrame(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

async function readActive(
  stateRoot: string,
): Promise<StoredActiveInstallMetadata | null> {
  const path = resolve(stateRoot, activeName);
  let bytes: Buffer;
  try {
    bytes = await readControlFile(path, 0o600);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new InstallError(
      "INVALID_STATE",
      "Active install metadata is invalid.",
      { cause: error },
    );
  }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const stored = validateActive(value);
    if (!bytes.equals(Buffer.from(`${JSON.stringify(stored, null, 2)}\n`)))
      throw new Error("noncanonical active metadata");
    return stored;
  } catch (error) {
    throw new InstallError(
      "INVALID_STATE",
      "Active install metadata is invalid.",
      { cause: error },
    );
  }
}

function validateActive(value: unknown): StoredActiveInstallMetadata {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "bundleDigest", "files"]) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isDigest(value.bundleDigest) ||
    !Array.isArray(value.files)
  )
    throw new Error("active schema");
  const paths: string[] = [];
  for (const file of value.files) {
    validateOwnedFile(file, true, value.schemaVersion === 2);
    paths.push(file.path);
  }
  assertSortedUnique(paths);
  assertCaseFoldUnique(paths);
  return value as unknown as StoredActiveInstallMetadata;
}

async function readJournal(stateRoot: string): Promise<InstallJournal | null> {
  const path = resolve(stateRoot, journalName);
  let bytes: Buffer;
  try {
    bytes = await readControlFile(path, 0o600);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new InstallError("INVALID_STATE", "Install journal is invalid.", {
      cause: error,
    });
  }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const stored = validateJournal(value);
    if (!bytes.equals(Buffer.from(`${JSON.stringify(stored, null, 2)}\n`)))
      throw new Error("noncanonical journal");
    return stored;
  } catch (error) {
    throw new InstallError("INVALID_STATE", "Install journal is invalid.", {
      cause: error,
    });
  }
}

function validateJournal(value: unknown): InstallJournal {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "version",
      "transactionId",
      "previousDigest",
      "candidateDigest",
      "previousActive",
      "candidateActive",
      "operations",
      "createdDirectories",
      "directoryWitnesses",
      "stateRootCreated",
      "preimagesRootCreated",
    ]) ||
    value.version !== 1 ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.transactionId) ||
    !(value.previousDigest === null || isDigest(value.previousDigest)) ||
    !isDigest(value.candidateDigest) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.createdDirectories) ||
    !Array.isArray(value.directoryWitnesses) ||
    typeof value.stateRootCreated !== "boolean" ||
    typeof value.preimagesRootCreated !== "boolean"
  )
    throw new Error("journal schema");
  const previous =
    value.previousActive === null ? null : validateActive(value.previousActive);
  const candidate = validateActive(value.candidateActive);
  if (
    value.previousDigest !== (previous?.bundleDigest ?? null) ||
    value.candidateDigest !== candidate.bundleDigest
  )
    throw new Error("journal digest");
  const previousByPath = new Map(
    previous?.files.map((file) => [file.path, file as OwnedFile]) ?? [],
  );
  const candidateByPath = new Map(
    candidate.files.map((file) => [file.path, file as OwnedFile]),
  );
  const expectedPaths = journalPaths(previousByPath, candidateByPath);
  if (value.operations.length !== expectedPaths.length)
    throw new Error("journal operation closure");
  for (const [index, operation] of value.operations.entries()) {
    if (
      !isRecord(operation) ||
      !onlyKeys(operation, ["type", "path", "before", "after", "preimage"]) ||
      typeof operation.path !== "string" ||
      operation.path !== expectedPaths[index] ||
      (operation.type !== "write" && operation.type !== "remove")
    )
      throw new Error("journal operation");
    const before = fingerprintFromOwned(previousByPath.get(operation.path));
    const after = fingerprintFromOwned(candidateByPath.get(operation.path));
    validateFingerprint(operation.before);
    validateFingerprint(operation.after);
    if (
      !sameFingerprint(operation.before, before) ||
      !sameFingerprint(operation.after, after) ||
      operation.type !== (after.kind === "absent" ? "remove" : "write") ||
      operation.preimage !==
        (before.kind === "file" ? `${index}.preimage` : null)
    )
      throw new Error("journal operation data");
  }
  const directories: string[] = [];
  for (const directory of value.createdDirectories) {
    if (typeof directory !== "string") throw new Error("journal directory");
    assertPortableDirectory(directory);
    directories.push(directory);
  }
  assertSortedUnique(directories);
  const possibleDirectories = new Set<string>();
  for (const operation of value.operations) {
    if (!isRecord(operation) || operation.type !== "write") continue;
    let parent = dirname(`codex-home/${String(operation.path)}`)
      .split(sep)
      .join("/");
    while (parent === "codex-home" || parent.startsWith("codex-home/")) {
      possibleDirectories.add(parent);
      if (parent === "codex-home") break;
      parent = dirname(parent).split(sep).join("/");
    }
  }
  if (directories.some((directory) => !possibleDirectories.has(directory)))
    throw new Error("journal directory is unrelated to write operations");
  const witnesses: DirectoryWitness[] = [];
  for (const [index, witness] of value.directoryWitnesses.entries()) {
    if (
      !isRecord(witness) ||
      !onlyKeys(witness, ["path", "dev", "ino"]) ||
      witness.path !== directories[index] ||
      typeof witness.dev !== "string" ||
      !/^\d+$/.test(witness.dev) ||
      typeof witness.ino !== "string" ||
      !/^\d+$/.test(witness.ino)
    )
      throw new Error("journal directory witness");
    witnesses.push(witness as unknown as DirectoryWitness);
  }
  if (witnesses.length !== directories.length)
    throw new Error("journal directory witness closure");
  return value as unknown as InstallJournal;
}

function validateFingerprint(value: unknown): asserts value is FileFingerprint {
  if (
    !isRecord(value) ||
    (value.kind === "absent"
      ? !onlyKeys(value, ["kind"])
      : value.kind !== "file" ||
        !onlyKeys(value, ["kind", "mode", "sha256"]) ||
        !isFileMode(value.mode) ||
        !isDigest(value.sha256))
  )
    throw new Error("fingerprint");
}

async function verifyManagedState(
  stateRoot: string,
  active: ActiveInstallMetadata | null,
): Promise<void> {
  if (active === null) return;
  for (const file of active.files) {
    if (isResetBeforeRun(file)) continue;
    const target = resolvePortable(resolve(stateRoot, managedName), file.path);
    let fingerprint: FileFingerprint;
    try {
      fingerprint = await fingerprintPath(target);
    } catch (error) {
      throw new InstallError(
        "MANAGED_STATE_DRIFT",
        "Managed install state has drifted.",
        { cause: error },
      );
    }
    if (!sameFingerprint(fingerprint, fingerprintFromOwned(file)))
      throw new InstallError(
        "MANAGED_STATE_DRIFT",
        "Managed install state has drifted.",
      );
  }
}

// Converge every reset-before-run file on the candidate's recorded bytes and
// mode. Resetting a file to known content needs no rollback: an interrupted
// reset is redone by the next run, so this stays outside the journal. A file
// the previous install did not own is still refused rather than overwritten.
// Refused before any state changes, so a conflict never surfaces after the
// journal has been removed and the install committed.
async function assertResetOwnership(
  stateRoot: string,
  previous: ActiveInstallMetadata | null,
  candidate: VerifiedCandidate,
): Promise<void> {
  const managedRoot = resolve(stateRoot, managedName);
  const owned = new Set(previous?.files.map((file) => file.path) ?? []);
  for (const file of candidate.active.files) {
    if (!isResetBeforeRun(file) || owned.has(file.path)) continue;
    if (await pathExists(resolvePortable(managedRoot, file.path)))
      throw new InstallError(
        "OWNERSHIP_CONFLICT",
        "A candidate target is not owned by the active install.",
      );
  }
}

async function resetManagedFiles(
  stateRoot: string,
  candidate: VerifiedCandidate,
): Promise<void> {
  const managedRoot = resolve(stateRoot, managedName);
  for (const file of candidate.active.files) {
    if (!isResetBeforeRun(file)) continue;
    const target = resolvePortable(managedRoot, file.path);
    if (
      sameFingerprint(await fingerprintPath(target), fingerprintFromOwned(file))
    )
      continue;
    const bytes = await readRegular(
      resolvePortable(candidate.artifactRoot, file.path),
    );
    if (sha256(bytes) !== file.sha256) throw new Error("candidate changed");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await atomicFile(target, bytes, Number.parseInt(file.mode, 8));
  }
}

async function prepareTransaction(
  stateRoot: string,
  previous: StoredActiveInstallMetadata | null,
  candidate: VerifiedCandidate,
  layout: ControlLayout,
): Promise<InstallJournal> {
  const managedRoot = resolve(stateRoot, managedName);
  const previousByPath = new Map(
    previous?.files.map((file) => [file.path, file as OwnedFile]) ?? [],
  );
  const candidateByPath = new Map(
    candidate.active.files.map((file) => [file.path, file]),
  );
  const operationPaths = journalPaths(previousByPath, candidateByPath);
  const operations: InstallOperation[] = [];
  for (const [index, path] of operationPaths.entries()) {
    const before = fingerprintFromOwned(previousByPath.get(path));
    const after = fingerprintFromOwned(candidateByPath.get(path));
    const target = resolvePortable(managedRoot, path);
    if (before.kind === "absent" && (await pathExists(target)))
      throw new InstallError(
        "OWNERSHIP_CONFLICT",
        "A candidate target is not owned by the active install.",
      );
    await assertExistingParents(managedRoot, dirname(target));
    operations.push({
      type: after.kind === "absent" ? "remove" : "write",
      path,
      before,
      after,
      preimage: before.kind === "file" ? `${index}.preimage` : null,
    });
  }
  const createdDirectories = await findCreatedDirectories(
    stateRoot,
    managedRoot,
    operations
      .filter((operation) => operation.type === "write")
      .map((operation) =>
        dirname(resolvePortable(managedRoot, operation.path)),
      ),
  );
  return {
    version: 1,
    transactionId: randomUUID(),
    previousDigest: previous?.bundleDigest ?? null,
    candidateDigest: candidate.active.bundleDigest,
    previousActive: previous,
    candidateActive: candidate.active,
    operations,
    createdDirectories,
    directoryWitnesses: [],
    stateRootCreated: !layout.stateRootExists,
    preimagesRootCreated: !layout.preimagesRootExists,
  };
}

async function publishTransaction(
  stateRoot: string,
  journal: InstallJournal,
): Promise<InstallJournal> {
  const preimagesRoot = resolve(stateRoot, preimagesName);
  const transactionRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
  );
  try {
    if (journal.stateRootCreated) await mkdir(stateRoot, { mode: 0o700 });
    if (journal.preimagesRootCreated)
      await mkdir(preimagesRoot, { mode: 0o700 });
    await mkdir(transactionRoot, { mode: 0o700 });
    await assertOrdinaryDirectory(transactionRoot, 0o700);
    const directoryWitnesses = await stageCreatedDirectories(
      stateRoot,
      transactionRoot,
      journal.createdDirectories,
    );
    const publishedJournal: InstallJournal = {
      ...journal,
      directoryWitnesses,
    };
    const managedRoot = resolve(stateRoot, managedName);
    let preimageIndex = 0;
    for (const operation of publishedJournal.operations) {
      if (operation.preimage === null) continue;
      const source = resolvePortable(managedRoot, operation.path);
      const bytes = await readRegular(source);
      if (!sameFingerprint(await fingerprintPath(source), operation.before))
        throw new Error("preimage source drift");
      const target = resolve(transactionRoot, operation.preimage);
      await atomicFile(target, bytes, 0o600);
      if (
        operation.before.kind !== "file" ||
        !sameFingerprint(await fingerprintPath(target), {
          kind: "file",
          mode: "0600",
          sha256: operation.before.sha256,
        })
      )
        throw new Error("preimage publication mismatch");
      preimageIndex += 1;
      await checkpointHook?.(`preimage:${preimageIndex}`);
    }
    await atomicJson(resolve(stateRoot, journalName), publishedJournal, 0o600);
    await readJournal(stateRoot);
    return publishedJournal;
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    if (journal.preimagesRootCreated) await removeIfEmpty(preimagesRoot);
    if (journal.stateRootCreated) await removeIfEmpty(stateRoot);
    throw new InstallError(
      "INSTALL_FAILED",
      "Install transaction could not be published.",
      { cause: error },
    );
  }
}

async function applyOperations(
  stateRoot: string,
  journal: InstallJournal,
  artifactRoot: string,
): Promise<void> {
  const roots = maximalCreatedDirectoryRoots(journal.createdDirectories);
  const stagedRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
    "created",
  );
  for (const [index, directory] of roots.entries()) {
    const source = resolvePortable(stagedRoot, directory);
    const target = resolvePortable(stateRoot, directory);
    if (await pathExists(target))
      throw new Error("created directory destination exists");
    await assertWitnessedDirectory(source, witnessFor(journal, directory));
    await rename(source, target);
    await checkpointHook?.(`directory:${index + 1}`);
  }
  const managedRoot = resolve(stateRoot, managedName);
  for (const [index, operation] of journal.operations.entries()) {
    const target = resolvePortable(managedRoot, operation.path);
    if (operation.type === "remove") await rm(target);
    else {
      const source = resolvePortable(artifactRoot, operation.path);
      const bytes = await readRegular(source);
      if (
        operation.after.kind !== "file" ||
        sha256(bytes) !== operation.after.sha256
      )
        throw new Error("candidate changed");
      await atomicFile(target, bytes, Number.parseInt(operation.after.mode, 8));
    }
    await checkpointHook?.(`operation:${index + 1}`);
  }
}

async function preflightRecovery(
  stateRoot: string,
  journal: InstallJournal,
): Promise<ReadonlyMap<string, "staged" | "live">> {
  try {
    const transactionRoot = resolve(
      stateRoot,
      preimagesName,
      journal.transactionId,
    );
    await assertTransactionMaterial(stateRoot, journal);
    for (const operation of journal.operations) {
      const current = await fingerprintPath(
        resolvePortable(resolve(stateRoot, managedName), operation.path),
      );
      if (
        !sameFingerprint(current, operation.before) &&
        !sameFingerprint(current, operation.after)
      )
        throw new Error("target conflict");
      if (operation.preimage !== null) {
        const preimage = resolve(transactionRoot, operation.preimage);
        const stat = await lstat(preimage);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o777) !== 0o600 ||
          sha256(await readFile(preimage)) !==
            (operation.before.kind === "file" ? operation.before.sha256 : "")
        )
          throw new Error("preimage invalid");
      }
    }
    const currentActive = await fingerprintPath(resolve(stateRoot, activeName));
    const previousActive = metadataFingerprint(journal.previousActive);
    const candidateActive = metadataFingerprint(journal.candidateActive);
    if (
      !sameFingerprint(currentActive, previousActive) &&
      !sameFingerprint(currentActive, candidateActive)
    )
      throw new Error("active metadata conflict");
    return await classifyDirectorySubtrees(stateRoot, journal);
  } catch (error) {
    throw new InstallError(
      "RECOVERY_CONFLICT",
      "Interrupted install conflicts with current state.",
      { cause: error },
    );
  }
}

async function restorePreviousState(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  const directoryStates = await preflightRecovery(stateRoot, journal);
  const transactionRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
  );
  const managedRoot = resolve(stateRoot, managedName);
  for (const operation of [...journal.operations].reverse()) {
    const target = resolvePortable(managedRoot, operation.path);
    const current = await fingerprintPath(target);
    if (sameFingerprint(current, operation.before)) continue;
    if (operation.before.kind === "absent") await rm(target);
    else {
      if (operation.preimage === null)
        throw new Error("missing preimage reference");
      const bytes = await readRegular(
        resolve(transactionRoot, operation.preimage),
      );
      await atomicFile(
        target,
        bytes,
        Number.parseInt(operation.before.mode, 8),
      );
    }
  }
  const activePath = resolve(stateRoot, activeName);
  const currentActive = await fingerprintPath(activePath);
  const previousFingerprint = metadataFingerprint(journal.previousActive);
  if (!sameFingerprint(currentActive, previousFingerprint)) {
    if (journal.previousActive === null) await rm(activePath);
    else await atomicJson(activePath, journal.previousActive, 0o600);
  }
  const stagedRoot = resolve(transactionRoot, "created");
  for (const directory of [
    ...maximalCreatedDirectoryRoots(journal.createdDirectories),
  ].reverse()) {
    if (directoryStates.get(directory) !== "live") continue;
    const source = resolvePortable(stateRoot, directory);
    const target = resolvePortable(stagedRoot, directory);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (await pathExists(target))
      throw new Error("staged rollback target exists");
    await rename(source, target);
  }
  const storedActive = await readActive(stateRoot);
  const active = storedActive === null ? null : migrateActive(storedActive);
  const restored =
    journal.previousActive === null
      ? null
      : migrateActive(journal.previousActive);
  if (JSON.stringify(active) !== JSON.stringify(restored))
    throw new Error("active restore mismatch");
  await verifyManagedState(stateRoot, restored);
}

async function clearTransaction(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  await rm(resolve(stateRoot, journalName));
  await rm(resolve(stateRoot, preimagesName, journal.transactionId), {
    recursive: true,
    force: true,
  });
  if (journal.preimagesRootCreated)
    await removeIfEmpty(resolve(stateRoot, preimagesName));
  if (journal.stateRootCreated) await removeIfEmpty(stateRoot);
}

async function cleanupCommitted(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  await rm(resolve(stateRoot, preimagesName, journal.transactionId), {
    recursive: true,
    force: true,
  });
  if (journal.preimagesRootCreated)
    await removeIfEmpty(resolve(stateRoot, preimagesName));
}

async function cleanupUnpublished(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  await rm(resolve(stateRoot, preimagesName, journal.transactionId), {
    recursive: true,
    force: true,
  });
  if (journal.preimagesRootCreated)
    await removeIfEmpty(resolve(stateRoot, preimagesName));
  if (journal.stateRootCreated) await removeIfEmpty(stateRoot);
}

interface ControlLayout {
  readonly stateRootExists: boolean;
  readonly preimagesRootExists: boolean;
  readonly transactionNames: readonly string[];
}

async function inspectControlLayout(stateRoot: string): Promise<ControlLayout> {
  try {
    let rootStat;
    try {
      rootStat = await lstat(stateRoot);
    } catch (error) {
      if (isMissing(error))
        return {
          stateRootExists: false,
          preimagesRootExists: false,
          transactionNames: [],
        };
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("state root is not an ordinary directory");
    await assertControlFileIfPresent(resolve(stateRoot, activeName), 0o600);
    await assertControlFileIfPresent(resolve(stateRoot, journalName), 0o600);
    const preimagesRoot = resolve(stateRoot, preimagesName);
    try {
      await assertOrdinaryDirectory(preimagesRoot, 0o700);
    } catch (error) {
      if (isMissing(error))
        return {
          stateRootExists: true,
          preimagesRootExists: false,
          transactionNames: [],
        };
      throw error;
    }
    const transactionNames = (await readdir(preimagesRoot)).sort(
      compareCodeUnits,
    );
    for (const name of transactionNames) {
      assertTransactionId(name);
      const transactionRoot = resolve(preimagesRoot, name);
      await assertOrdinaryDirectory(transactionRoot, 0o700);
      const createdRoot = resolve(transactionRoot, "created");
      try {
        await assertOrdinaryDirectory(createdRoot, 0o700);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return {
      stateRootExists: true,
      preimagesRootExists: true,
      transactionNames,
    };
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError(
      "INVALID_STATE",
      "Install control state is invalid.",
      {
        cause: error,
      },
    );
  }
}

async function assertControlFileIfPresent(
  path: string,
  mode: number,
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode)
      throw new Error("control file mode or type is invalid");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertOrdinaryDirectory(
  path: string,
  mode: number,
): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== mode
  )
    throw new Error("control directory mode or type is invalid");
}

function hasOrphanTransactionControl(
  layout: ControlLayout,
  journal: InstallJournal | null,
): boolean {
  if (!layout.preimagesRootExists) return false;
  if (journal === null) return layout.transactionNames.length > 0;
  return (
    layout.transactionNames.length !== 1 ||
    layout.transactionNames[0] !== journal.transactionId
  );
}

function assertTransactionId(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("invalid transaction id");
}

async function assertExistingParents(
  managedRoot: string,
  parent: string,
): Promise<void> {
  const relativeParent = relative(managedRoot, parent);
  const segments = relativeParent === "" ? [] : relativeParent.split(sep);
  let current = managedRoot;
  for (const segment of ["", ...segments]) {
    if (segment !== "") current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new InstallError(
          "OWNERSHIP_CONFLICT",
          "A candidate parent is not an ordinary directory.",
        );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function findCreatedDirectories(
  stateRoot: string,
  managedRoot: string,
  parents: readonly string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const parent of parents) {
    const relativeParent = relative(stateRoot, parent);
    const parts = relativeParent.split(sep);
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      const target = resolvePortable(stateRoot, current);
      try {
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new InstallError(
            "OWNERSHIP_CONFLICT",
            "A candidate parent is not an ordinary directory.",
          );
      } catch (error) {
        if (isMissing(error)) candidates.add(current);
        else throw error;
      }
    }
  }
  if (parents.length > 0 && !contained(stateRoot, managedRoot))
    throw new Error("managed root containment");
  return [...candidates].sort(compareCodeUnits);
}

async function stageCreatedDirectories(
  stateRoot: string,
  transactionRoot: string,
  directories: readonly string[],
): Promise<readonly DirectoryWitness[]> {
  if (directories.length === 0) return [];
  const createdRoot = resolve(transactionRoot, "created");
  await mkdir(createdRoot, { mode: 0o700 });
  for (const directory of directories)
    await mkdir(resolvePortable(createdRoot, directory), {
      recursive: true,
      mode: 0o700,
    });
  await assertControlDirectoryTree(createdRoot, directories);
  const witnesses: DirectoryWitness[] = [];
  for (const directory of directories) {
    const staged = resolvePortable(createdRoot, directory);
    const stat = await lstat(staged);
    witnesses.push({
      path: directory,
      dev: String(stat.dev),
      ino: String(stat.ino),
    });
  }
  if (directories.some((directory) => !directory.startsWith(`${managedName}`)))
    throw new Error("created directory escapes managed root");
  if (!contained(stateRoot, resolve(stateRoot, managedName)))
    throw new Error("managed root containment");
  return witnesses;
}

async function assertControlDirectoryTree(
  root: string,
  createdDirectories: readonly string[],
  relativePath = "",
): Promise<void> {
  await assertOrdinaryDirectory(root, 0o700);
  const allowed = createdDirectoryPrefixClosure(createdDirectories);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = resolve(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("staged control tree contains a non-directory");
    const childPath =
      relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    if (!allowed.has(childPath))
      throw new Error("staged control tree contains an unexpected directory");
    await assertControlDirectoryTree(target, createdDirectories, childPath);
  }
}

function createdDirectoryPrefixClosure(
  directories: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const directory of directories) {
    const parts = directory.split("/");
    let prefix = "";
    for (const part of parts) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      allowed.add(prefix);
    }
  }
  return allowed;
}

function maximalCreatedDirectoryRoots(
  directories: readonly string[],
): readonly string[] {
  return directories.filter(
    (directory) =>
      !directories.some(
        (candidate) =>
          candidate !== directory && directory.startsWith(`${candidate}/`),
      ),
  );
}

function witnessFor(journal: InstallJournal, path: string): DirectoryWitness {
  const witness = journal.directoryWitnesses.find(
    (entry) => entry.path === path,
  );
  if (witness === undefined) throw new Error("directory witness is missing");
  return witness;
}

async function assertWitnessedDirectory(
  path: string,
  witness: DirectoryWitness,
): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    String(stat.dev) !== witness.dev ||
    String(stat.ino) !== witness.ino
  )
    throw new Error("directory witness mismatch");
}

async function assertTransactionMaterial(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  const transactionRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
  );
  await assertOrdinaryDirectory(resolve(stateRoot, preimagesName), 0o700);
  await assertOrdinaryDirectory(transactionRoot, 0o700);
  const expectedEntries = new Set<string>();
  if (journal.createdDirectories.length > 0) expectedEntries.add("created");
  for (const operation of journal.operations) {
    if (operation.preimage === null) continue;
    expectedEntries.add(operation.preimage);
    const preimage = resolve(transactionRoot, operation.preimage);
    const stat = await lstat(preimage);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600 ||
      operation.before.kind !== "file" ||
      sha256(await readFile(preimage)) !== operation.before.sha256
    )
      throw new Error("preimage invalid");
  }
  const entries = await readdir(transactionRoot);
  if (
    entries.length !== expectedEntries.size ||
    entries.some((entry) => !expectedEntries.has(entry))
  )
    throw new Error("transaction material closure invalid");
  if (journal.createdDirectories.length > 0)
    await assertControlDirectoryTree(
      resolve(transactionRoot, "created"),
      journal.createdDirectories,
    );
}

async function classifyDirectorySubtrees(
  stateRoot: string,
  journal: InstallJournal,
): Promise<ReadonlyMap<string, "staged" | "live">> {
  const result = new Map<string, "staged" | "live">();
  const stagedRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
    "created",
  );
  for (const root of maximalCreatedDirectoryRoots(journal.createdDirectories)) {
    const staged = resolvePortable(stagedRoot, root);
    const live = resolvePortable(stateRoot, root);
    const stagedExists = await pathExists(staged);
    const liveExists = await pathExists(live);
    if (stagedExists === liveExists)
      throw new Error("directory placement conflict");
    if (stagedExists) {
      await assertWitnessClosure(stagedRoot, journal, root);
      await assertCreatedTreeClosure(stagedRoot, journal, root, false);
      result.set(root, "staged");
    } else {
      await assertWitnessClosure(stateRoot, journal, root);
      await assertCreatedTreeClosure(stateRoot, journal, root, true);
      result.set(root, "live");
    }
  }
  return result;
}

async function assertWitnessClosure(
  locationRoot: string,
  journal: InstallJournal,
  maximalRoot: string,
): Promise<void> {
  for (const witness of journal.directoryWitnesses) {
    if (
      witness.path === maximalRoot ||
      witness.path.startsWith(`${maximalRoot}/`)
    )
      await assertWitnessedDirectory(
        resolvePortable(locationRoot, witness.path),
        witness,
      );
  }
}

async function assertCreatedTreeClosure(
  locationRoot: string,
  journal: InstallJournal,
  maximalRoot: string,
  live: boolean,
): Promise<void> {
  const expectedDirectories = new Set(
    journal.createdDirectories.filter(
      (path) => path === maximalRoot || path.startsWith(`${maximalRoot}/`),
    ),
  );
  const operationByLivePath = new Map(
    journal.operations.map((operation) => [
      `${managedName}/${operation.path}`,
      operation,
    ]),
  );
  const foundDirectories = new Set<string>();
  const root = resolvePortable(locationRoot, maximalRoot);
  async function visit(directory: string, relativePath: string): Promise<void> {
    foundDirectories.add(relativePath);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      const childPath = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("created tree symlink");
      if (entry.isDirectory()) {
        await visit(child, childPath);
        continue;
      }
      if (!live || !entry.isFile()) throw new Error("created tree closure");
      const operation = operationByLivePath.get(childPath);
      if (operation === undefined) throw new Error("unowned created tree file");
      const fingerprint = await fingerprintPath(child);
      if (
        !sameFingerprint(fingerprint, operation.before) &&
        !sameFingerprint(fingerprint, operation.after)
      )
        throw new Error("created tree file conflict");
    }
  }
  await visit(root, maximalRoot);
  if (
    foundDirectories.size !== expectedDirectories.size ||
    [...foundDirectories].some((path) => !expectedDirectories.has(path))
  )
    throw new Error("created directory closure mismatch");
}

async function fingerprintPath(path: string): Promise<FileFingerprint> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("not a regular file");
    return {
      kind: "file",
      mode: normalizeMode(stat.mode),
      sha256: sha256(await readFile(path)),
    };
  } catch (error) {
    if (isMissing(error)) return absent;
    throw error;
  }
}

// Codex writes to its own home: on its first session in a repository it
// appends a [projects."<path>"] trust block to config.toml and rewrites the
// file owner-only. The bundle still owns that file's contents, so it is reset
// from the candidate before every run instead of being verified against the
// recorded fingerprint. Everything else the bundle installs is immutable, and
// drift on it still fails closed.
const resetBeforeRunPaths: ReadonlySet<string> = new Set(["config.toml"]);

function lifecycleFor(path: string): FileLifecycle {
  return resetBeforeRunPaths.has(path) ? "reset-before-run" : "immutable";
}

function withLifecycle(
  files: readonly LegacyOwnedFile[],
): readonly OwnedFile[] {
  return files.map((file) => ({
    path: file.path,
    mode: file.mode,
    sha256: file.sha256,
    lifecycle: lifecycleFor(file.path),
  }));
}

// Which view of an active record a site needs follows one rule, and getting it
// wrong is silent: fingerprints simply stop matching.
//
//   stored   — anything fingerprinted, or written back to a control file. The
//              bytes on disk are the thing being compared, and they are in the
//              schema whatever wrote them used.
//   migrated — anything that reads a lifecycle, or is compared against a value
//              some other site has already migrated.
//
// readActive and readJournal both return the stored view for that reason, and
// callers migrate at the point of use.
function migrateActive(
  stored: StoredActiveInstallMetadata,
): ActiveInstallMetadata {
  return stored.schemaVersion === 2
    ? stored
    : {
        schemaVersion: 2,
        bundleDigest: stored.bundleDigest,
        files: withLifecycle(stored.files),
      };
}

function isResetBeforeRun(file: OwnedFile | undefined): boolean {
  return file?.lifecycle === "reset-before-run";
}

// Reset-before-run paths never enter the journal. publishTransaction checks
// every preimage source against the recorded fingerprint, which is exactly the
// assumption a runtime rewrite breaks, so those paths are converged by
// resetManagedFiles instead.
function journalPaths(
  previousByPath: ReadonlyMap<string, OwnedFile>,
  candidateByPath: ReadonlyMap<string, OwnedFile>,
): string[] {
  return [...new Set([...previousByPath.keys(), ...candidateByPath.keys()])]
    .sort(compareCodeUnits)
    .filter(
      (path) =>
        !isResetBeforeRun(previousByPath.get(path)) &&
        !isResetBeforeRun(candidateByPath.get(path)) &&
        !sameOwned(previousByPath.get(path), candidateByPath.get(path)),
    );
}

function fingerprintFromOwned(file: OwnedFile | undefined): FileFingerprint {
  return file === undefined
    ? absent
    : { kind: "file", mode: file.mode, sha256: file.sha256 };
}

function metadataFingerprint(
  metadata: StoredActiveInstallMetadata | null,
): FileFingerprint {
  return metadata === null
    ? absent
    : {
        kind: "file",
        mode: "0600",
        sha256: sha256(Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)),
      };
}

function sameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint,
): boolean {
  return left.kind === "absent"
    ? right.kind === "absent"
    : right.kind === "file" &&
        left.mode === right.mode &&
        left.sha256 === right.sha256;
}

function sameOwned(
  left: OwnedFile | undefined,
  right: OwnedFile | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.mode === right.mode &&
        left.sha256 === right.sha256;
}

function normalizeMode(mode: number): FileMode {
  const normalized = mode & 0o777;
  if (normalized === 0o600) return "0600";
  if (normalized === 0o644) return "0644";
  if (normalized === 0o755) return "0755";
  throw new Error("unsupported file mode");
}

function isFileMode(value: unknown): value is FileMode {
  return value === "0600" || value === "0644" || value === "0755";
}

async function atomicJson(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  await atomicFile(
    path,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    mode,
  );
}

async function atomicFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporary = resolve(dirname(path), `.install-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

async function readRegular(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("not a regular file");
  return await readFile(path);
}

async function readControlFile(path: string, mode: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode)
    throw new Error("control file mode or type is invalid");
  return await readFile(path);
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!isMissing(error) && !isNotEmpty(error)) throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function resolvePortable(root: string, path: string): string {
  assertPortableDirectory(path);
  const target = resolve(root, ...path.split("/"));
  if (!contained(root, target)) throw new Error("path escapes root");
  return target;
}

function assertPortableDirectory(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("portable directory");
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function assertSortedUnique(values: readonly string[]): void {
  for (let index = 0; index < values.length; index += 1) {
    if (
      index > 0 &&
      compareCodeUnits(values[index - 1] ?? "", values[index] ?? "") >= 0
    )
      throw new Error("not sorted unique");
  }
}

function assertCaseFoldUnique(values: readonly string[]): void {
  const folded = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (folded.has(key)) throw new Error("case-folded path collision");
    folded.add(key);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isNotEmpty(error: unknown): boolean {
  return isErrorCode(error, "ENOTEMPTY") || isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
