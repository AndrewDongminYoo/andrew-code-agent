import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import { executeGit } from "../git/process.js";
import { parseBundleManifest, type FileMode } from "./manifest.js";
import { renderBundle, type CapabilityInputs } from "./render.js";
import {
  readTrackedSourceFileBytes,
  SourceTreeError,
  type ResolvedSourceFile,
} from "./source-tree.js";

const metadataPath = "bundle-metadata.json";
const stagingPrefix = ".bundle-staging-";
const lockSuffix = ".lock";

export interface BundleMetadata {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly manifestDigest: string;
  readonly bundleDigest: string;
  readonly builderVersion: string;
  readonly requestedCapabilities: readonly string[];
  readonly enabledCapabilities: readonly string[];
  readonly files: readonly {
    path: string;
    mode: FileMode;
    sha256: string;
  }[];
}

export interface BuildBundleInput {
  readonly sourceRoot: string;
  readonly artifactsRoot: string;
  readonly requestedCapabilities: readonly "oracle"[];
  readonly capabilityInputs: CapabilityInputs;
  readonly builderVersion: string;
}

export interface BundleArtifact {
  readonly artifactRoot: string;
  readonly metadata: BundleMetadata;
}

export type ArtifactErrorCode =
  | "INVALID_INPUT"
  | "INVALID_REQUESTED_CAPABILITIES"
  | "UNREQUESTED_CAPABILITY_INPUT"
  | "SOURCE_ROOT_INVALID"
  | "SOURCE_GIT_ERROR"
  | "DIRTY_SOURCE"
  | "SOURCE_CHANGED_DURING_BUILD"
  | "MANIFEST_UNAVAILABLE"
  | "RESERVED_OUTPUT_PATH"
  | "ARTIFACT_ROOT_INVALID"
  | "UNDECLARED_OUTPUT"
  | "OUTPUT_CLOSURE_INVALID"
  | "ARTIFACT_COLLISION"
  | "ARTIFACT_LOCKED";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
  }
}

type ArtifactTestHook = (stagingRoot: string) => void | Promise<void>;
let artifactTestHook: ArtifactTestHook | undefined;
type ArtifactPublicationTestHook = () => void | Promise<void>;
let artifactPublicationTestHook: ArtifactPublicationTestHook | undefined;

/** Test-only deterministic failure injection that is intentionally outside BuildBundleInput. */
export function __setArtifactTestHookForTests(
  hook: ArtifactTestHook | undefined,
): void {
  artifactTestHook = hook;
}

/** Test-only deterministic publication injection that is intentionally outside BuildBundleInput. */
export function __setArtifactPublicationTestHookForTests(
  hook: ArtifactPublicationTestHook | undefined,
): void {
  artifactPublicationTestHook = hook;
}

export async function buildBundle(
  input: BuildBundleInput,
): Promise<BundleArtifact> {
  assertInput(input);
  const sourceRoot = await resolveGitRoot(input.sourceRoot);
  const sourceRevision = await readCleanGitHead(sourceRoot);
  const manifestBytes = await readManifestBytes(sourceRoot);
  const manifest = parseBundleManifest(
    new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
  );
  const requestedCapabilities = normalizeRequestedCapabilities(
    input.requestedCapabilities,
  );
  const capabilityInputs = normalizeCapabilityInputs(
    requestedCapabilities,
    input.capabilityInputs,
  );
  const rendered = await renderBundle(sourceRoot, manifest, capabilityInputs);
  await assertSourceUnchanged(sourceRoot, sourceRevision);

  const files = normalizeFiles(rendered.files);
  if (files.some((file) => file.path === metadataPath)) {
    throw new ArtifactError(
      "RESERVED_OUTPUT_PATH",
      "Rendered output contains the reserved metadata path.",
    );
  }
  const enabledCapabilities = [...rendered.enabledCapabilities].sort(
    compareCodeUnits,
  );
  const metadata = createMetadata({
    sourceRevision,
    manifestDigest: sha256(manifestBytes),
    builderVersion: input.builderVersion,
    requestedCapabilities,
    enabledCapabilities,
    files,
  });
  const artifactRoot = await resolveArtifactsRoot(input.artifactsRoot);
  const publishedRoot = resolve(artifactRoot, metadata.bundleDigest);
  if (!isContainedBy(artifactRoot, publishedRoot)) {
    throw new ArtifactError(
      "ARTIFACT_ROOT_INVALID",
      "Artifact root is invalid.",
    );
  }
  const metadataBytes = metadataFileBytes(metadata);
  const lockPath = artifactLockPath(artifactRoot, metadata.bundleDigest);
  await acquireArtifactLock(lockPath);
  let stagingRoot: string | undefined;
  let published = false;
  try {
    if (await pathExists(publishedRoot)) {
      await assertPublishedArtifact(publishedRoot, files, metadataBytes);
      await assertSourceUnchanged(sourceRoot, sourceRevision);
      return { artifactRoot: publishedRoot, metadata };
    }

    stagingRoot = await mkdtemp(resolve(artifactRoot, stagingPrefix));
    await chmod(stagingRoot, 0o700);
    await writeFiles(stagingRoot, files);
    await artifactTestHook?.(stagingRoot);
    await assertOutputClosure(stagingRoot, files);
    await assertSourceUnchanged(sourceRoot, sourceRevision);
    await writeFile(resolve(stagingRoot, metadataPath), metadataBytes, {
      mode: 0o644,
    });
    await chmod(resolve(stagingRoot, metadataPath), 0o644);
    await assertPublishedArtifact(stagingRoot, files, metadataBytes);

    if (await pathExists(publishedRoot)) {
      await assertPublishedArtifact(publishedRoot, files, metadataBytes);
      await assertSourceUnchanged(sourceRoot, sourceRevision);
      return { artifactRoot: publishedRoot, metadata };
    }
    await artifactPublicationTestHook?.();
    if (await pathExists(publishedRoot)) {
      throw new ArtifactError(
        "ARTIFACT_COLLISION",
        "An artifact target already exists.",
      );
    }
    try {
      await assertSourceUnchanged(sourceRoot, sourceRevision);
      await rename(stagingRoot, publishedRoot);
      published = true;
      await assertPublishedArtifact(publishedRoot, files, metadataBytes);
    } catch (error) {
      if (!(await pathExists(publishedRoot))) {
        throw error;
      }
      await assertPublishedArtifact(publishedRoot, files, metadataBytes);
    }
    return { artifactRoot: publishedRoot, metadata };
  } finally {
    try {
      if (!published && stagingRoot !== undefined) {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function assertSourceUnchanged(
  sourceRoot: string,
  sourceRevision: string,
): Promise<void> {
  if ((await readCleanGitHead(sourceRoot)) !== sourceRevision) {
    throw new ArtifactError(
      "SOURCE_CHANGED_DURING_BUILD",
      "Source repository changed during bundle construction.",
    );
  }
}

function assertInput(input: BuildBundleInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.sourceRoot !== "string" ||
    typeof input.artifactsRoot !== "string" ||
    typeof input.builderVersion !== "string" ||
    input.builderVersion.length === 0 ||
    !Array.isArray(input.requestedCapabilities) ||
    typeof input.capabilityInputs !== "object" ||
    input.capabilityInputs === null
  ) {
    throw new ArtifactError("INVALID_INPUT", "Bundle input is invalid.");
  }
}

function normalizeRequestedCapabilities(
  requestedCapabilities: readonly "oracle"[],
): readonly "oracle"[] {
  const normalized = [...requestedCapabilities].sort(compareCodeUnits);
  if (
    normalized.some((capability) => capability !== "oracle") ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new ArtifactError(
      "INVALID_REQUESTED_CAPABILITIES",
      "Requested capabilities are invalid.",
    );
  }
  return normalized;
}

function normalizeCapabilityInputs(
  requestedCapabilities: readonly "oracle"[],
  capabilityInputs: CapabilityInputs,
): CapabilityInputs {
  const candidate = capabilityInputs as unknown;
  if (typeof candidate !== "object" || candidate === null) {
    throw new ArtifactError("INVALID_INPUT", "Bundle input is invalid.");
  }
  const record = candidate as Record<PropertyKey, unknown>;
  const hasOwnOracle = Object.hasOwn(record, "oracle");
  if (!hasOwnOracle && "oracle" in record) {
    if (!requestedCapabilities.includes("oracle")) {
      throw new ArtifactError(
        "UNREQUESTED_CAPABILITY_INPUT",
        "Capability inputs include a capability that was not requested.",
      );
    }
    throw new ArtifactError("INVALID_INPUT", "Bundle input is invalid.");
  }
  if (
    (Object.getPrototypeOf(record) !== Object.prototype &&
      Object.getPrototypeOf(record) !== null) ||
    Reflect.ownKeys(record).some((key) => key !== "oracle")
  ) {
    throw new ArtifactError("INVALID_INPUT", "Bundle input is invalid.");
  }
  if (hasOwnOracle && !requestedCapabilities.includes("oracle")) {
    throw new ArtifactError(
      "UNREQUESTED_CAPABILITY_INPUT",
      "Capability inputs include a capability that was not requested.",
    );
  }
  if (!hasOwnOracle) {
    return {};
  }
  return Object.defineProperty({}, "oracle", {
    enumerable: true,
    value: record.oracle,
  }) as CapabilityInputs;
}

async function resolveGitRoot(sourceRoot: string): Promise<string> {
  let canonicalSourceRoot: string;
  try {
    canonicalSourceRoot = await realpath(sourceRoot);
    const stdout = await executeGit(canonicalSourceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if ((await realpath(stdout.trim())) !== canonicalSourceRoot) {
      throw new Error("not a Git root");
    }
  } catch {
    throw new ArtifactError(
      "SOURCE_ROOT_INVALID",
      "Source root is not a Git worktree root.",
    );
  }
  return canonicalSourceRoot;
}

async function readCleanGitHead(sourceRoot: string): Promise<string> {
  for (const arguments_ of [
    ["diff", "--quiet", "--ignore-submodules", "--"],
    ["diff", "--cached", "--quiet", "--ignore-submodules", "--"],
  ]) {
    const status = await gitStatus(sourceRoot, arguments_);
    if (status === 1) {
      throw new ArtifactError("DIRTY_SOURCE", "Source repository is dirty.");
    }
    if (status !== 0) {
      throw new ArtifactError(
        "SOURCE_GIT_ERROR",
        "Source repository cannot be inspected.",
      );
    }
  }
  try {
    const untracked = await executeGit(sourceRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    if (untracked.length > 0) {
      throw new ArtifactError("DIRTY_SOURCE", "Source repository is dirty.");
    }
    const revision = await executeGit(sourceRoot, ["rev-parse", "HEAD"]);
    return revision.trim();
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw error;
    }
    throw new ArtifactError(
      "SOURCE_GIT_ERROR",
      "Source repository cannot be inspected.",
    );
  }
}

async function gitStatus(
  sourceRoot: string,
  arguments_: readonly string[],
): Promise<number> {
  try {
    await executeGit(sourceRoot, arguments_);
    return 0;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
      ? error.code
      : 2;
  }
}

async function readManifestBytes(sourceRoot: string): Promise<Uint8Array> {
  try {
    return await readTrackedSourceFileBytes(sourceRoot, "agent-bundle.toml");
  } catch (error) {
    if (error instanceof SourceTreeError) {
      if (error.code === "DIRTY_SOURCE") {
        throw new ArtifactError("DIRTY_SOURCE", "Source repository is dirty.");
      }
      if (error.code === "SOURCE_GIT_ERROR") {
        throw new ArtifactError(
          "SOURCE_GIT_ERROR",
          "Source repository cannot be inspected.",
        );
      }
      if (error.code === "SOURCE_CHANGED_DURING_READ") {
        throw new ArtifactError(
          "SOURCE_CHANGED_DURING_BUILD",
          "Source repository changed during bundle construction.",
        );
      }
    }
    throw new ArtifactError("MANIFEST_UNAVAILABLE", "Manifest is unavailable.");
  }
}

function normalizeFiles(
  renderedFiles: readonly ResolvedSourceFile[],
): readonly {
  path: string;
  mode: FileMode;
  bytes: Uint8Array;
  sha256: string;
}[] {
  return renderedFiles
    .map((file) => ({
      path: file.targetPath,
      mode: normalizeMode(file.mode),
      bytes: file.bytes,
      sha256: sha256(file.bytes),
    }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

function normalizeMode(mode: number): FileMode {
  if (mode === 0o600) {
    return "0600";
  }
  if (mode === 0o644) {
    return "0644";
  }
  if (mode === 0o755) {
    return "0755";
  }
  throw new ArtifactError(
    "OUTPUT_CLOSURE_INVALID",
    "Rendered file mode is invalid.",
  );
}

function createMetadata(input: {
  readonly sourceRevision: string;
  readonly manifestDigest: string;
  readonly builderVersion: string;
  readonly requestedCapabilities: readonly string[];
  readonly enabledCapabilities: readonly string[];
  readonly files: readonly {
    path: string;
    mode: FileMode;
    bytes: Uint8Array;
    sha256: string;
  }[];
}): BundleMetadata {
  return {
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    manifestDigest: input.manifestDigest,
    bundleDigest: bundleDigest(input),
    builderVersion: input.builderVersion,
    requestedCapabilities: input.requestedCapabilities,
    enabledCapabilities: input.enabledCapabilities,
    files: input.files.map(({ path, mode, sha256: fileDigest }) => ({
      path,
      mode,
      sha256: fileDigest,
    })),
  };
}

function bundleDigest(input: {
  readonly sourceRevision: string;
  readonly manifestDigest: string;
  readonly builderVersion: string;
  readonly requestedCapabilities: readonly string[];
  readonly enabledCapabilities: readonly string[];
  readonly files: readonly {
    path: string;
    mode: FileMode;
    bytes: Uint8Array;
  }[];
}): string {
  const hash = createHash("sha256");
  updateFrame(hash, "andrew-code-agent.bundle.v1");
  updateFrame(hash, "sourceRevision");
  updateFrame(hash, input.sourceRevision);
  updateFrame(hash, "manifestDigest");
  updateFrame(hash, input.manifestDigest);
  updateFrame(hash, "builderVersion");
  updateFrame(hash, input.builderVersion);
  updateFrame(hash, "requestedCapabilities");
  updateFrame(hash, input.requestedCapabilities.length.toString());
  for (const capability of input.requestedCapabilities) {
    updateFrame(hash, capability);
  }
  updateFrame(hash, "enabledCapabilities");
  updateFrame(hash, input.enabledCapabilities.length.toString());
  for (const capability of input.enabledCapabilities) {
    updateFrame(hash, capability);
  }
  updateFrame(hash, "files");
  updateFrame(hash, input.files.length.toString());
  for (const file of input.files) {
    updateFrame(hash, file.path);
    updateFrame(hash, file.mode);
    updateFrame(hash, file.bytes);
  }
  return hash.digest("hex");
}

function updateFrame(
  hash: ReturnType<typeof createHash>,
  value: string | Uint8Array,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveArtifactsRoot(artifactsRoot: string): Promise<string> {
  try {
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(artifactsRoot);
    if (!(await lstat(canonicalRoot)).isDirectory()) {
      throw new Error("not a directory");
    }
    await chmod(canonicalRoot, 0o700);
    return canonicalRoot;
  } catch {
    throw new ArtifactError(
      "ARTIFACT_ROOT_INVALID",
      "Artifact root is invalid.",
    );
  }
}

function artifactLockPath(artifactRoot: string, digest: string): string {
  const lockPath = resolve(artifactRoot, `.${digest}${lockSuffix}`);
  if (!isContainedBy(artifactRoot, lockPath)) {
    throw new ArtifactError(
      "ARTIFACT_ROOT_INVALID",
      "Artifact root is invalid.",
    );
  }
  return lockPath;
}

async function acquireArtifactLock(lockPath: string): Promise<void> {
  let acquired = false;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    acquired = true;
    await chmod(lockPath, 0o700);
  } catch {
    if (acquired) {
      await rm(lockPath, { recursive: true, force: true });
    }
    throw new ArtifactError(
      "ARTIFACT_LOCKED",
      "Artifact publication is already locked.",
    );
  }
}

async function writeFiles(
  stagingRoot: string,
  files: readonly { path: string; mode: FileMode; bytes: Uint8Array }[],
): Promise<void> {
  for (const file of files) {
    const outputPath = resolve(stagingRoot, file.path);
    if (!isContainedBy(stagingRoot, outputPath)) {
      throw new ArtifactError(
        "OUTPUT_CLOSURE_INVALID",
        "Rendered output path is invalid.",
      );
    }
    const parent = resolve(outputPath, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    await writeFile(outputPath, file.bytes, {
      mode: Number.parseInt(file.mode, 8),
    });
    await chmod(outputPath, Number.parseInt(file.mode, 8));
  }
}

async function assertOutputClosure(
  root: string,
  expectedFiles: readonly { path: string; mode: FileMode; bytes: Uint8Array }[],
): Promise<void> {
  const expected = new Map(expectedFiles.map((file) => [file.path, file]));
  const found = await readRegularFiles(root);
  for (const [path, file] of found) {
    const expectedFile = expected.get(path);
    if (expectedFile === undefined) {
      throw new ArtifactError(
        "UNDECLARED_OUTPUT",
        "Rendered output contains an undeclared path.",
      );
    }
    const metadata = await lstat(file);
    if ((metadata.mode & 0o777) !== Number.parseInt(expectedFile.mode, 8)) {
      throw new ArtifactError(
        "OUTPUT_CLOSURE_INVALID",
        "Rendered output mode does not match the manifest.",
      );
    }
    const bytes = await readFile(file);
    if (!bytes.equals(Buffer.from(expectedFile.bytes))) {
      throw new ArtifactError(
        "OUTPUT_CLOSURE_INVALID",
        "Rendered output bytes do not match the renderer.",
      );
    }
  }
  if (found.size !== expected.size) {
    throw new ArtifactError(
      "OUTPUT_CLOSURE_INVALID",
      "Rendered output is incomplete.",
    );
  }
}

async function assertPublishedArtifact(
  root: string,
  files: readonly { path: string; mode: FileMode; bytes: Uint8Array }[],
  metadataBytes: Uint8Array,
): Promise<void> {
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new Error("not a directory");
    }
    await assertOutputClosure(root, [
      ...files,
      { path: metadataPath, mode: "0644", bytes: metadataBytes },
    ]);
    const metadataFile = resolve(root, metadataPath);
    const metadata = await readFile(metadataFile);
    const stat = await lstat(metadataFile);
    if (
      (stat.mode & 0o777) !== 0o644 ||
      !metadata.equals(Buffer.from(metadataBytes))
    ) {
      throw new Error("metadata mismatch");
    }
    const found = await readRegularFiles(root);
    if (found.size !== files.length + 1 || !found.has(metadataPath)) {
      throw new Error("unexpected artifact file");
    }
  } catch (error) {
    throw new ArtifactError(
      "ARTIFACT_COLLISION",
      "An existing artifact does not match its digest.",
    );
  }
}

async function readRegularFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new ArtifactError(
          "OUTPUT_CLOSURE_INVALID",
          "Artifact output contains a non-regular file.",
        );
      }
      const target = relative(root, path);
      if (!isContainedBy(root, path) || files.has(target)) {
        throw new ArtifactError(
          "OUTPUT_CLOSURE_INVALID",
          "Artifact output path is invalid.",
        );
      }
      files.set(target, path);
    }
  }
  await visit(root);
  return files;
}

function metadataFileBytes(metadata: BundleMetadata): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isContainedBy(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../"));
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
