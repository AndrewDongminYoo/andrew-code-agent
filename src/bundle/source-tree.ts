/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
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
  readonly sourcePath: string;
}

export async function resolveSourceFiles(
  sourceRoot: string,
  manifest: BundleManifest,
): Promise<readonly ResolvedSourceFile[]> {
  const canonicalSourceRoot = await resolveSourceRoot(sourceRoot);
  await assertGitWorktreeRoot(canonicalSourceRoot);
  const entries = await resolveEntries(canonicalSourceRoot, manifest.files);
  const initialRevision = await readCleanGitSnapshot(canonicalSourceRoot);

  const resolvedFiles = await Promise.all(
    entries.map(async ({ entry, sourcePath }) => {
      const mode = readExpectedMode(entry);
      const file = await lstat(sourcePath);
      if (!file.isFile()) {
        throw new SourceTreeError(
          "NON_REGULAR_SOURCE",
          `Manifest source for target ${entry.target} is not a regular file.`,
        );
      }
      const actualMode = file.mode & 0o777;
      if (!isAcceptedSourceMode(actualMode, mode)) {
        throw new SourceTreeError(
          "UNEXPECTED_MODE",
          `Manifest source for target ${entry.target} has an unexpected mode.`,
        );
      }
      const bytes = await readFile(sourcePath);
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

      let sourcePath: string;
      try {
        sourcePath = await realpath(requestedPath);
      } catch {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `Manifest source for target ${entry.target} cannot be resolved.`,
        );
      }
      if (!isContainedBy(sourceRoot, sourcePath)) {
        throw new SourceTreeError(
          "SOURCE_PATH_ESCAPE",
          `Manifest source for target ${entry.target} escapes the source root.`,
        );
      }

      const source = await lstat(sourcePath);
      if (!source.isFile()) {
        throw new SourceTreeError(
          "NON_REGULAR_SOURCE",
          `Manifest source for target ${entry.target} is not a regular file.`,
        );
      }
      return { entry, sourcePath };
    }),
  );
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
