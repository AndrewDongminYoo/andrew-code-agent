/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { BundleManifest, BundleFileEntry } from "./manifest.js";

const execFile = promisify(execFileCallback);
const outputRoot = "/andrew-code-agent-portable-output";

export interface ResolvedSourceFile {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly mode: 0o644 | 0o755;
  readonly bytes: Uint8Array;
  readonly capability?: "oracle" | "shared-memory";
}

export type SourceTreeErrorCode =
  | "SOURCE_ROOT_NOT_FOUND"
  | "SOURCE_ROOT_NOT_GIT_ROOT"
  | "SOURCE_PATH_ESCAPE"
  | "OUTPUT_PATH_ESCAPE"
  | "DUPLICATE_TARGET"
  | "CASE_COLLIDING_TARGET"
  | "NON_PORTABLE_TARGET"
  | "NON_REGULAR_SOURCE"
  | "UNEXPECTED_MODE"
  | "DIRTY_SOURCE"
  | "SOURCE_CHANGED_DURING_READ"
  | "SOURCE_GIT_ERROR";

export class SourceTreeError extends Error {
  readonly code: SourceTreeErrorCode;

  constructor(code: SourceTreeErrorCode, message: string) {
    super(message);
    this.name = "SourceTreeError";
    this.code = code;
  }
}

interface ResolvedEntry {
  readonly entry: BundleFileEntry;
  readonly trackedPaths: readonly string[];
  readonly sourcePath: string;
}

export async function resolveSourceFiles(
  sourceRoot: string,
  manifest: BundleManifest,
): Promise<readonly ResolvedSourceFile[]> {
  const canonicalSourceRoot = await resolveSourceRoot(sourceRoot);
  await assertGitWorktreeRoot(canonicalSourceRoot);
  const initialRevision = await readCleanGitSnapshot(canonicalSourceRoot);
  const entries = await resolveEntries(canonicalSourceRoot, manifest.files);
  await assertIndexedSourcePaths(canonicalSourceRoot, entries);

  const resolvedFiles = await Promise.all(
    entries.map(async ({ entry, sourcePath }) => {
      const mode = readExpectedMode(entry);
      const file = await lstat(sourcePath, { bigint: true });
      if (!file.isFile()) {
        throw new SourceTreeError(
          "NON_REGULAR_SOURCE",
          `Manifest source for target ${entry.target} is not a regular file.`,
        );
      }
      const actualMode = Number(file.mode & 0o777n);
      if (!isAcceptedSourceMode(actualMode, mode)) {
        throw new SourceTreeError(
          "UNEXPECTED_MODE",
          `Manifest source for target ${entry.target} has an unexpected mode.`,
        );
      }
      const bytes = await readOpenedSource(
        sourcePath,
        `Manifest source for target ${entry.target}`,
        file,
        mode,
      );
      return entry.capability === undefined
        ? { sourcePath, targetPath: entry.target, mode, bytes }
        : {
            sourcePath,
            targetPath: entry.target,
            mode,
            bytes,
            capability: entry.capability,
          };
    }),
  );

  const finalRevision = await readFinalGitSnapshot(canonicalSourceRoot);
  if (finalRevision !== initialRevision) {
    throw new SourceTreeError(
      "SOURCE_CHANGED_DURING_READ",
      "Source repository changed while selected files were read.",
    );
  }

  return resolvedFiles.sort((left, right) =>
    compareCodeUnits(left.targetPath, right.targetPath),
  );
}

export async function readTrackedSourceFileBytes(
  sourceRoot: string,
  source: string,
): Promise<Uint8Array> {
  const canonicalSourceRoot = await resolveSourceRoot(sourceRoot);
  await assertGitWorktreeRoot(canonicalSourceRoot);
  const initialRevision = await readCleanGitSnapshot(canonicalSourceRoot);
  const requestedPath = resolve(canonicalSourceRoot, source);
  if (!isContainedBy(canonicalSourceRoot, requestedPath)) {
    throw new SourceTreeError(
      "SOURCE_PATH_ESCAPE",
      `Source file ${source} escapes the source root.`,
    );
  }
  const { sourcePath, trackedPaths } = await resolveSourcePath(
    canonicalSourceRoot,
    requestedPath,
    `Source file ${source}`,
  );
  await assertIndexedSourcePaths(canonicalSourceRoot, [{ trackedPaths }]);

  const file = await lstat(sourcePath, { bigint: true });
  if (!file.isFile()) {
    throw new SourceTreeError(
      "NON_REGULAR_SOURCE",
      `Source file ${source} is not a regular file.`,
    );
  }
  const bytes = await readOpenedSource(
    sourcePath,
    `Source file ${source}`,
    file,
  );

  const finalRevision = await readFinalGitSnapshot(canonicalSourceRoot);
  if (finalRevision !== initialRevision) {
    throw new SourceTreeError(
      "SOURCE_CHANGED_DURING_READ",
      "Source repository changed while the tracked file was read.",
    );
  }
  return bytes;
}

async function readOpenedSource(
  sourcePath: string,
  sourceDescription: string,
  expected: BigIntStats,
  mode?: 0o644 | 0o755,
): Promise<Uint8Array> {
  let file;
  try {
    file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new SourceTreeError(
      "NON_REGULAR_SOURCE",
      `${sourceDescription} is not a regular file.`,
    );
  }
  try {
    const before = await file.stat({ bigint: true });
    assertOpenedSource(sourceDescription, expected, before, mode);
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    assertOpenedSource(sourceDescription, before, after, mode, true);
    return bytes;
  } finally {
    await file.close();
  }
}

function assertOpenedSource(
  sourceDescription: string,
  expected: BigIntStats,
  actual: BigIntStats,
  mode?: 0o644 | 0o755,
  compareContentMetadata = false,
): void {
  const currentUid = process.getuid?.();
  if (
    !actual.isFile() ||
    (currentUid !== undefined && actual.uid !== BigInt(currentUid)) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new SourceTreeError(
      "NON_REGULAR_SOURCE",
      `${sourceDescription} is not a regular file.`,
    );
  }
  const actualMode = Number(actual.mode & 0o777n);
  if (mode !== undefined && !isAcceptedSourceMode(actualMode, mode)) {
    throw new SourceTreeError(
      "UNEXPECTED_MODE",
      `${sourceDescription} has an unexpected mode.`,
    );
  }
  if (
    compareContentMetadata &&
    (actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs ||
      actual.ctimeNs !== expected.ctimeNs)
  ) {
    throw new SourceTreeError(
      "SOURCE_CHANGED_DURING_READ",
      "Source repository changed while selected files were read.",
    );
  }
}

function isAcceptedSourceMode(
  actualMode: number,
  expectedMode: 0o644 | 0o755,
): boolean {
  return (
    actualMode === expectedMode ||
    (actualMode === 0o600 && expectedMode === 0o644) ||
    (actualMode === 0o700 && expectedMode === 0o755)
  );
}

async function assertGitWorktreeRoot(sourceRoot: string): Promise<void> {
  let topLevel: string;
  try {
    ({ stdout: topLevel } = await execFile("git", [
      "-C",
      sourceRoot,
      "rev-parse",
      "--show-toplevel",
    ]));
  } catch {
    throw new SourceTreeError(
      "SOURCE_ROOT_NOT_GIT_ROOT",
      "Source root is not a Git worktree root.",
    );
  }

  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = await realpath(topLevel.trim());
  } catch {
    throw new SourceTreeError(
      "SOURCE_ROOT_NOT_GIT_ROOT",
      "Source root is not a Git worktree root.",
    );
  }
  if (canonicalTopLevel !== sourceRoot) {
    throw new SourceTreeError(
      "SOURCE_ROOT_NOT_GIT_ROOT",
      "Source root is not a Git worktree root.",
    );
  }
}

async function resolveSourceRoot(sourceRoot: string): Promise<string> {
  try {
    return await realpath(sourceRoot);
  } catch {
    throw new SourceTreeError(
      "SOURCE_ROOT_NOT_FOUND",
      "Source root cannot be resolved.",
    );
  }
}

async function resolveEntries(
  sourceRoot: string,
  entries: readonly BundleFileEntry[],
): Promise<readonly ResolvedEntry[]> {
  const targets = new Map<string, string>();
  return Promise.all(
    entries.map(async (entry) => {
      assertOutputTarget(entry.target, targets);
      const requestedPath = resolve(sourceRoot, entry.source);
      if (!isContainedBy(sourceRoot, requestedPath)) {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `Manifest source for target ${entry.target} escapes the source root.`,
        );
      }

      const { sourcePath, trackedPaths } = await resolveSourcePath(
        sourceRoot,
        requestedPath,
        `Manifest source for target ${entry.target}`,
      );
      return { entry, trackedPaths, sourcePath };
    }),
  );
}

async function resolveSourcePath(
  sourceRoot: string,
  requestedPath: string,
  sourceDescription: string,
): Promise<{ readonly sourcePath: string; readonly trackedPaths: string[] }> {
  const trackedPaths: string[] = [];
  let unresolvedPath = requestedPath;
  let remainingSymlinkTraversals = 40;

  while (true) {
    const unresolvedRelativePath = relative(sourceRoot, unresolvedPath);
    if (!isContainedBy(sourceRoot, unresolvedPath)) {
      throw new SourceTreeError(
        "SOURCE_PATH_ESCAPE",
        `${sourceDescription} escapes the source root.`,
      );
    }
    const components =
      unresolvedRelativePath === "" ? [] : unresolvedRelativePath.split(sep);
    let currentPath = sourceRoot;
    let finalSource: Stats | undefined;
    let followedSymlink = false;

    for (const [index, component] of components.entries()) {
      currentPath = resolve(currentPath, component);
      let source;
      try {
        source = await lstat(currentPath);
      } catch {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `${sourceDescription} cannot be resolved.`,
        );
      }
      if (!source.isSymbolicLink()) {
        if (index === components.length - 1) {
          finalSource = source;
        }
        continue;
      }

      if (remainingSymlinkTraversals === 0) {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `${sourceDescription} cannot be resolved.`,
        );
      }
      remainingSymlinkTraversals -= 1;
      trackedPaths.push(currentPath);

      let target: string;
      try {
        target = await readlink(currentPath);
      } catch {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `${sourceDescription} cannot be resolved.`,
        );
      }
      unresolvedPath = resolve(
        currentPath,
        "..",
        target,
        ...components.slice(index + 1),
      );
      followedSymlink = true;
      break;
    }

    if (followedSymlink) {
      continue;
    }

    let sourcePath: string;
    try {
      sourcePath = await realpath(unresolvedPath);
    } catch {
      throw new SourceTreeError(
        "SOURCE_PATH_ESCAPE",
        `${sourceDescription} cannot be resolved.`,
      );
    }
    if (!isContainedBy(sourceRoot, sourcePath)) {
      throw new SourceTreeError(
        "SOURCE_PATH_ESCAPE",
        `${sourceDescription} escapes the source root.`,
      );
    }
    const source = finalSource ?? (await lstat(sourcePath));
    if (!source.isFile()) {
      throw new SourceTreeError(
        "NON_REGULAR_SOURCE",
        `${sourceDescription} is not a regular file.`,
      );
    }
    trackedPaths.push(sourcePath);
    return { sourcePath, trackedPaths };
  }
}

async function assertIndexedSourcePaths(
  sourceRoot: string,
  entries: readonly Pick<ResolvedEntry, "trackedPaths">[],
): Promise<void> {
  const exactPaths = [
    ...new Set(
      entries.flatMap(({ trackedPaths }) =>
        trackedPaths.map((path) => relative(sourceRoot, path)),
      ),
    ),
  ];
  if (exactPaths.length === 0) {
    return;
  }

  let indexed: string;
  try {
    ({ stdout: indexed } = await execFile("git", [
      "--literal-pathspecs",
      "-C",
      sourceRoot,
      "ls-files",
      "--cached",
      "--full-name",
      "-z",
      "--",
      ...exactPaths,
    ]));
  } catch {
    throw new SourceTreeError(
      "SOURCE_GIT_ERROR",
      "Source repository cannot be inspected.",
    );
  }

  const indexedPaths = new Set(indexed.split("\0").filter(Boolean));
  if (exactPaths.some((path) => !indexedPaths.has(path))) {
    throw new SourceTreeError("DIRTY_SOURCE", "Source repository is dirty.");
  }
}

function assertOutputTarget(
  target: string,
  targets: Map<string, string>,
): void {
  if (!/^[\x20-\x7e]+$/u.test(target)) {
    throw new SourceTreeError(
      "NON_PORTABLE_TARGET",
      "Manifest output target is not ASCII portable.",
    );
  }
  const resolvedTarget = resolve(outputRoot, target);
  if (!isContainedBy(outputRoot, resolvedTarget)) {
    throw new SourceTreeError(
      "OUTPUT_PATH_ESCAPE",
      "Manifest output target escapes the portable output root.",
    );
  }

  const normalizedTarget = target.normalize("NFC");
  const comparableTarget = normalizedTarget.toLowerCase();
  const existingTarget = targets.get(comparableTarget);
  if (existingTarget !== undefined) {
    throw new SourceTreeError(
      existingTarget === target ? "DUPLICATE_TARGET" : "CASE_COLLIDING_TARGET",
      `Manifest output target ${target} conflicts with another target.`,
    );
  }
  targets.set(comparableTarget, target);
}

function readExpectedMode(entry: BundleFileEntry): 0o644 | 0o755 {
  if (entry.mode === "0644") {
    return 0o644;
  }
  if (entry.mode === "0755") {
    return 0o755;
  }
  throw new SourceTreeError(
    "UNEXPECTED_MODE",
    `Manifest source for target ${entry.target} has an unsupported mode.`,
  );
}

async function readCleanGitSnapshot(sourceRoot: string): Promise<string> {
  const checkedCommands = [
    ["diff", "--quiet", "--ignore-submodules", "--"],
    ["diff", "--cached", "--quiet", "--ignore-submodules", "--"],
  ];
  for (const arguments_ of checkedCommands) {
    const result = await runGit(sourceRoot, arguments_);
    if (result === 1) {
      throw new SourceTreeError("DIRTY_SOURCE", "Source repository is dirty.");
    }
    if (result !== 0) {
      throw new SourceTreeError(
        "SOURCE_GIT_ERROR",
        "Source repository cannot be inspected.",
      );
    }
  }

  let untracked: string;
  try {
    ({ stdout: untracked } = await execFile("git", [
      "-C",
      sourceRoot,
      "ls-files",
      "--others",
      "--exclude-standard",
    ]));
  } catch {
    throw new SourceTreeError(
      "SOURCE_GIT_ERROR",
      "Source repository cannot be inspected.",
    );
  }
  if (untracked.length > 0) {
    throw new SourceTreeError("DIRTY_SOURCE", "Source repository is dirty.");
  }

  return runGitRevision(sourceRoot);
}

async function readFinalGitSnapshot(sourceRoot: string): Promise<string> {
  try {
    return await readCleanGitSnapshot(sourceRoot);
  } catch (error) {
    if (error instanceof SourceTreeError && error.code === "DIRTY_SOURCE") {
      throw new SourceTreeError(
        "SOURCE_CHANGED_DURING_READ",
        "Source repository changed while selected files were read.",
      );
    }
    throw error;
  }
}

async function runGit(
  sourceRoot: string,
  arguments_: readonly string[],
): Promise<number> {
  try {
    await execFile("git", ["-C", sourceRoot, ...arguments_]);
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

async function runGitRevision(sourceRoot: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", [
      "-C",
      sourceRoot,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim();
  } catch {
    throw new SourceTreeError(
      "SOURCE_GIT_ERROR",
      "Source revision cannot be read.",
    );
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
