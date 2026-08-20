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

export interface OwnedFile {
  readonly path: string;
  readonly mode: FileMode;
  readonly sha256: string;
}

export interface ActiveInstallMetadata {
  readonly schemaVersion: 1;
  readonly bundleDigest: string;
  readonly files: readonly OwnedFile[];
}

export type FileFingerprint =
  | { readonly kind: "absent" }
  | {
      readonly kind: "file";
      readonly mode: FileMode | "0600";
      readonly sha256: string;
    };

export interface InstallOperation {
  readonly type: "write" | "remove";
  readonly path: string;
  readonly before: FileFingerprint;
  readonly after: FileFingerprint;
  readonly preimage: string | null;
}

export interface InstallJournal {
  readonly version: 1;
  readonly transactionId: string;
  readonly previousDigest: string | null;
  readonly candidateDigest: string;
  readonly previousActive: ActiveInstallMetadata | null;
  readonly candidateActive: ActiveInstallMetadata;
  readonly operations: readonly InstallOperation[];
  readonly createdDirectories: readonly string[];
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
  try {
    active = await readActive(stateRoot);
  } catch {
    issues.push("INVALID_ACTIVE_INSTALL");
  }
  try {
    journal = await readJournal(stateRoot);
  } catch {
    issues.push("INVALID_INSTALL_JOURNAL");
  }
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
  if ((await readJournal(stateRoot)) !== null)
    throw new InstallError(
      "RECOVERY_REQUIRED",
      "An interrupted install requires explicit recovery.",
    );
  const previous = await readActive(stateRoot);
  await verifyManagedState(stateRoot, previous);
  if (previous?.bundleDigest === candidate.active.bundleDigest) return;
  const transaction = await prepareTransaction(stateRoot, previous, candidate);
  let journalPublished = false;
  try {
    await publishTransaction(stateRoot, transaction);
    journalPublished = true;
    await checkpointHook?.("journal-published");
    await applyOperations(stateRoot, transaction, candidate.artifactRoot);
    await atomicJson(
      resolve(stateRoot, activeName),
      transaction.candidateActive,
      0o600,
    );
    await checkpointHook?.("active-metadata-published");
    await verifyManagedState(stateRoot, transaction.candidateActive);
    await checkpointHook?.("installation-verified");
    await rm(resolve(stateRoot, journalName));
    journalPublished = false;
    await rm(resolve(stateRoot, preimagesName, transaction.transactionId), {
      recursive: true,
      force: true,
    });
    await removeIfEmpty(resolve(stateRoot, preimagesName));
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
  const journal = await readJournal(stateRoot);
  if (journal === null) return;
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
        schemaVersion: 1,
        bundleDigest: metadata.bundleDigest,
        files: metadata.files,
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
  return value as unknown as BundleMetadata;
}

function validateOwnedFile(
  value: unknown,
  candidate: boolean,
): asserts value is OwnedFile {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["path", "mode", "sha256"]) ||
    typeof value.path !== "string" ||
    (value.mode !== "0644" && value.mode !== "0755") ||
    !isDigest(value.sha256)
  )
    throw new Error("file metadata");
  assertPortablePath(value.path);
  if (candidate && isProtectedPath(value.path))
    throw new Error("protected path");
}

function assertPortablePath(path: string): void {
  if (
    path.length === 0 ||
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
): Promise<ActiveInstallMetadata | null> {
  const path = resolve(stateRoot, activeName);
  let bytes: Buffer;
  try {
    bytes = await readRegular(path);
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
    const active = validateActive(value);
    if (!bytes.equals(Buffer.from(`${JSON.stringify(active, null, 2)}\n`)))
      throw new Error("noncanonical active metadata");
    return active;
  } catch (error) {
    throw new InstallError(
      "INVALID_STATE",
      "Active install metadata is invalid.",
      { cause: error },
    );
  }
}

function validateActive(value: unknown): ActiveInstallMetadata {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "bundleDigest", "files"]) ||
    value.schemaVersion !== 1 ||
    !isDigest(value.bundleDigest) ||
    !Array.isArray(value.files)
  )
    throw new Error("active schema");
  const paths: string[] = [];
  for (const file of value.files) {
    validateOwnedFile(file, true);
    paths.push(file.path);
  }
  assertSortedUnique(paths);
  return value as unknown as ActiveInstallMetadata;
}

async function readJournal(stateRoot: string): Promise<InstallJournal | null> {
  const path = resolve(stateRoot, journalName);
  let bytes: Buffer;
  try {
    bytes = await readRegular(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new InstallError("INVALID_STATE", "Install journal is invalid.", {
      cause: error,
    });
  }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const journal = validateJournal(value);
    if (!bytes.equals(Buffer.from(`${JSON.stringify(journal, null, 2)}\n`)))
      throw new Error("noncanonical journal");
    return journal;
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
    ]) ||
    value.version !== 1 ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.transactionId) ||
    !(value.previousDigest === null || isDigest(value.previousDigest)) ||
    !isDigest(value.candidateDigest) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.createdDirectories)
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
    previous?.files.map((file) => [file.path, file]) ?? [],
  );
  const candidateByPath = new Map(
    candidate.files.map((file) => [file.path, file]),
  );
  const expectedPaths = [
    ...new Set([...previousByPath.keys(), ...candidateByPath.keys()]),
  ]
    .sort(compareCodeUnits)
    .filter(
      (path) => !sameOwned(previousByPath.get(path), candidateByPath.get(path)),
    );
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
  return value as unknown as InstallJournal;
}

function validateFingerprint(value: unknown): asserts value is FileFingerprint {
  if (
    !isRecord(value) ||
    (value.kind === "absent"
      ? !onlyKeys(value, ["kind"])
      : value.kind !== "file" ||
        !onlyKeys(value, ["kind", "mode", "sha256"]) ||
        (value.mode !== "0644" && value.mode !== "0755") ||
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

async function prepareTransaction(
  stateRoot: string,
  previous: ActiveInstallMetadata | null,
  candidate: VerifiedCandidate,
): Promise<InstallJournal> {
  await validateExistingStateRoot(stateRoot);
  const managedRoot = resolve(stateRoot, managedName);
  const previousByPath = new Map(
    previous?.files.map((file) => [file.path, file]) ?? [],
  );
  const candidateByPath = new Map(
    candidate.active.files.map((file) => [file.path, file]),
  );
  const operationPaths = [
    ...new Set([...previousByPath.keys(), ...candidateByPath.keys()]),
  ]
    .sort(compareCodeUnits)
    .filter(
      (path) => !sameOwned(previousByPath.get(path), candidateByPath.get(path)),
    );
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
  };
}

async function publishTransaction(
  stateRoot: string,
  journal: InstallJournal,
): Promise<void> {
  const transactionRoot = resolve(
    stateRoot,
    preimagesName,
    journal.transactionId,
  );
  try {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    await chmod(resolve(stateRoot, preimagesName), 0o700);
    await chmod(transactionRoot, 0o700);
    const managedRoot = resolve(stateRoot, managedName);
    for (const operation of journal.operations) {
      if (operation.preimage === null) continue;
      const source = resolvePortable(managedRoot, operation.path);
      const bytes = await readRegular(source);
      if (!sameFingerprint(await fingerprintPath(source), operation.before))
        throw new Error("preimage source drift");
      const target = resolve(transactionRoot, operation.preimage);
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      await chmod(target, 0o600);
    }
    await atomicJson(resolve(stateRoot, journalName), journal, 0o600);
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    await removeIfEmpty(resolve(stateRoot, preimagesName));
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
  for (const directory of journal.createdDirectories) {
    const target = resolvePortable(stateRoot, directory);
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
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
): Promise<void> {
  try {
    const transactionRoot = resolve(
      stateRoot,
      preimagesName,
      journal.transactionId,
    );
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
    for (const directory of journal.createdDirectories) {
      const target = resolvePortable(stateRoot, directory);
      try {
        const stat = await lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("directory conflict");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
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
  await preflightRecovery(stateRoot, journal);
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
  for (const directory of [...journal.createdDirectories].reverse()) {
    try {
      await rmdir(resolvePortable(stateRoot, directory));
    } catch (error) {
      if (!isMissing(error) && !isNotEmpty(error)) throw error;
    }
  }
  const active = await readActive(stateRoot);
  if (JSON.stringify(active) !== JSON.stringify(journal.previousActive))
    throw new Error("active restore mismatch");
  await verifyManagedState(stateRoot, journal.previousActive);
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
  await removeIfEmpty(resolve(stateRoot, preimagesName));
}

async function validateExistingStateRoot(stateRoot: string): Promise<void> {
  try {
    const stat = await lstat(stateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("state root");
  } catch (error) {
    if (isMissing(error)) return;
    throw new InstallError("INVALID_STATE", "State root is invalid.", {
      cause: error,
    });
  }
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

async function fingerprintPath(path: string): Promise<FileFingerprint> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("not a regular file");
    return {
      kind: "file",
      mode: normalizeFingerprintMode(stat.mode),
      sha256: sha256(await readFile(path)),
    };
  } catch (error) {
    if (isMissing(error)) return absent;
    throw error;
  }
}

function fingerprintFromOwned(file: OwnedFile | undefined): FileFingerprint {
  return file === undefined
    ? absent
    : { kind: "file", mode: file.mode, sha256: file.sha256 };
}

function metadataFingerprint(
  metadata: ActiveInstallMetadata | null,
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
  if (normalized === 0o644) return "0644";
  if (normalized === 0o755) return "0755";
  throw new Error("unsupported file mode");
}

function normalizeFingerprintMode(mode: number): FileMode | "0600" {
  if ((mode & 0o777) === 0o600) return "0600";
  return normalizeMode(mode);
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
