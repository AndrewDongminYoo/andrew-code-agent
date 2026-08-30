/// <reference types="node" />

import { realpath } from "node:fs/promises";

import { executeGit } from "../git/process.js";

export interface DirtyPathSummary {
  readonly paths: readonly string[];
  readonly omittedPathCount: number;
}

export interface GitSnapshot {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly porcelainV2: string;
  readonly clean: boolean;
}

export type GitRuntimeErrorCode =
  | "NOT_GIT_REPOSITORY"
  | "GIT_HEAD_UNAVAILABLE"
  | "GIT_STATUS_FAILED"
  | "GIT_SNAPSHOT_RACE"
  | "GIT_WORKTREE_DIRTY"
  | "UNSUPPORTED_GIT_SUBMODULE";

export class GitRuntimeError extends Error {
  readonly code: GitRuntimeErrorCode;
  readonly dirtyPathSummary?: DirtyPathSummary;

  constructor(
    code: GitRuntimeErrorCode,
    message: string,
    dirtyPathSummary?: DirtyPathSummary,
  ) {
    super(message);
    this.name = "GitRuntimeError";
    this.code = code;
    if (dirtyPathSummary !== undefined)
      this.dirtyPathSummary = dirtyPathSummary;
  }
}

const MAX_DIRTY_PATHS = 8;

export async function resolveRepositoryRoot(input: string): Promise<string> {
  let canonicalInput: string;
  try {
    canonicalInput = await realpath(input);
  } catch {
    throw new GitRuntimeError(
      "NOT_GIT_REPOSITORY",
      "Input is not a Git worktree.",
    );
  }
  let topLevel: string;
  try {
    topLevel = await runGit(canonicalInput, ["rev-parse", "--show-toplevel"]);
    return await realpath(topLevel.trim());
  } catch {
    throw new GitRuntimeError(
      "NOT_GIT_REPOSITORY",
      "Input is not a Git worktree.",
    );
  }
}

export async function readGitSnapshot(input: string): Promise<GitSnapshot> {
  const repositoryRoot = await resolveRepositoryRoot(input);
  const firstHead = await readHead(repositoryRoot);
  await assertSupportedHeadTree(repositoryRoot, firstHead);
  await assertSupportedIndexState(repositoryRoot);
  let porcelainV2: string;
  try {
    porcelainV2 = await runGit(repositoryRoot, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    ]);
  } catch {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  const secondHead = await readHead(repositoryRoot);
  if (firstHead !== secondHead) {
    throw new GitRuntimeError(
      "GIT_SNAPSHOT_RACE",
      "Git HEAD changed while the worktree snapshot was read.",
    );
  }
  await assertSupportedIndexState(repositoryRoot);
  return {
    repositoryRoot,
    head: firstHead,
    porcelainV2,
    clean: porcelainV2.length === 0,
  };
}

async function assertSupportedHeadTree(
  repositoryRoot: string,
  head: string,
): Promise<void> {
  let treeModes: string;
  try {
    treeModes = await runGit(repositoryRoot, [
      "ls-tree",
      "-r",
      "-z",
      "--format=%(objectmode)",
      head,
    ]);
  } catch {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }

  const parsedTreeModes = parseTreeModes(treeModes);
  if (parsedTreeModes === null) {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  if (parsedTreeModes.includes("160000")) {
    throw new GitRuntimeError(
      "UNSUPPORTED_GIT_SUBMODULE",
      "Submodules are unsupported in v0.1.",
    );
  }
}

async function assertSupportedIndexState(
  repositoryRoot: string,
): Promise<void> {
  let indexEntries: string;
  try {
    indexEntries = await runGit(repositoryRoot, [
      "ls-files",
      "--cached",
      "--stage",
      "-v",
      "-z",
    ]);
  } catch {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }

  const parsedIndexEntries = parseIndexEntries(indexEntries);
  if (parsedIndexEntries === null) {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  if (parsedIndexEntries.some(({ mode }) => mode === "160000")) {
    throw new GitRuntimeError(
      "UNSUPPORTED_GIT_SUBMODULE",
      "Submodules are unsupported in v0.1.",
    );
  }
  if (parsedIndexEntries.some(({ tag }) => tag !== "H")) {
    throw new GitRuntimeError(
      "GIT_WORKTREE_DIRTY",
      "Git worktree is not clean.",
    );
  }
}

function parseTreeModes(treeModes: string): string[] | null {
  if (treeModes.length === 0) return [];
  if (!treeModes.endsWith("\0")) return null;
  const treeModesWithoutTerminalNul = treeModes.slice(0, -1).split("\0");
  if (treeModesWithoutTerminalNul.some((mode) => !/^[0-7]{6}$/.test(mode))) {
    return null;
  }
  return treeModesWithoutTerminalNul;
}

function parseIndexEntries(
  indexEntries: string,
): { readonly tag: string; readonly mode: string }[] | null {
  if (indexEntries.length === 0) return [];
  if (!indexEntries.endsWith("\0")) return null;
  const indexEntriesWithoutTerminalNul = indexEntries.slice(0, -1).split("\0");
  const parsedEntries = indexEntriesWithoutTerminalNul.map((entry) => {
    const tabIndex = entry.indexOf("\t");
    if (tabIndex < 0 || tabIndex === entry.length - 1) return null;
    const fields = entry.slice(0, tabIndex).split(" ");
    if (
      fields.length !== 4 ||
      !/^[A-Za-z]$/.test(fields[0]!) ||
      !/^[0-7]{6}$/.test(fields[1]!) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[2]!) ||
      !/^[0-3]$/.test(fields[3]!)
    ) {
      return null;
    }
    return { tag: fields[0]!, mode: fields[1]! };
  });
  if (parsedEntries.some((entry) => entry === null)) return null;
  return parsedEntries.filter(
    (entry): entry is { readonly tag: string; readonly mode: string } =>
      entry !== null,
  );
}

function parseDirtyPathSummary(
  porcelainV2: string,
): DirtyPathSummary | null | undefined {
  if (porcelainV2.length === 0) return undefined;
  if (!porcelainV2.endsWith("\0")) return null;
  const records = porcelainV2.slice(0, -1).split("\0");
  const paths: string[] = [];
  let omittedPathCount = 0;
  const addPath = (path: string): boolean => {
    if (!isRepositoryRelativePath(path)) return false;
    if (paths.length < MAX_DIRTY_PATHS) paths.push(path);
    else omittedPathCount += 1;
    return true;
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    switch (record[0]) {
      case "1": {
        const fields = splitPorcelainPathRecord(record, 8);
        if (
          fields === null ||
          fields[0] !== "1" ||
          !isPorcelainStatus(fields[1]!) ||
          !isPorcelainSubmodule(fields[2]!) ||
          !isPorcelainMode(fields[3]!) ||
          !isPorcelainMode(fields[4]!) ||
          !isPorcelainMode(fields[5]!) ||
          !isPorcelainObjectId(fields[6]!) ||
          !isPorcelainObjectId(fields[7]!) ||
          !addPath(fields[8]!)
        )
          return null;
        break;
      }
      case "2": {
        const fields = splitPorcelainPathRecord(record, 9);
        const originalPath = records[index + 1];
        if (
          fields === null ||
          fields[0] !== "2" ||
          !isPorcelainStatus(fields[1]!) ||
          !isPorcelainSubmodule(fields[2]!) ||
          !isPorcelainMode(fields[3]!) ||
          !isPorcelainMode(fields[4]!) ||
          !isPorcelainMode(fields[5]!) ||
          !isPorcelainObjectId(fields[6]!) ||
          !isPorcelainObjectId(fields[7]!) ||
          !/^[RC](?:100|[1-9]?[0-9])$/.test(fields[8]!) ||
          originalPath === undefined ||
          !isRepositoryRelativePath(originalPath) ||
          !addPath(fields[9]!)
        )
          return null;
        index += 1;
        break;
      }
      case "u": {
        const fields = splitPorcelainPathRecord(record, 10);
        if (
          fields === null ||
          fields[0] !== "u" ||
          !isPorcelainStatus(fields[1]!) ||
          !isPorcelainSubmodule(fields[2]!) ||
          !isPorcelainMode(fields[3]!) ||
          !isPorcelainMode(fields[4]!) ||
          !isPorcelainMode(fields[5]!) ||
          !isPorcelainMode(fields[6]!) ||
          !isPorcelainObjectId(fields[7]!) ||
          !isPorcelainObjectId(fields[8]!) ||
          !isPorcelainObjectId(fields[9]!) ||
          !addPath(fields[10]!)
        )
          return null;
        break;
      }
      case "?":
        if (!record.startsWith("? ") || !addPath(record.slice(2))) return null;
        break;
      default:
        return null;
    }
  }
  return { paths, omittedPathCount };
}

function splitPorcelainPathRecord(
  record: string,
  fieldCount: number,
): string[] | null {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const delimiter = record.indexOf(" ", offset);
    if (delimiter < 0) return null;
    fields.push(record.slice(offset, delimiter));
    offset = delimiter + 1;
  }
  const path = record.slice(offset);
  return path.length === 0 ? null : [...fields, path];
}

function isPorcelainStatus(value: string): boolean {
  return /^[.MADRCUT]{2}$/.test(value);
}

function isPorcelainSubmodule(value: string): boolean {
  return /^(?:N\.\.\.|S[.C][.M][.U])$/.test(value);
}

function isPorcelainMode(value: string): boolean {
  return /^[0-7]{6}$/.test(value);
}

function isPorcelainObjectId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function isRepositoryRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export async function assertCleanGitSnapshot(
  snapshot: GitSnapshot,
): Promise<GitSnapshot> {
  if (snapshot.clean !== (snapshot.porcelainV2.length === 0)) {
    throw new GitRuntimeError(
      "GIT_SNAPSHOT_RACE",
      "Git worktree status changed while the snapshot was checked.",
    );
  }

  let nulDelimitedPorcelainV2: string;
  try {
    nulDelimitedPorcelainV2 = await runGit(snapshot.repositoryRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
  } catch {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  const dirtyPathSummary = parseDirtyPathSummary(nulDelimitedPorcelainV2);
  if (dirtyPathSummary === null) {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  if (snapshot.clean !== (dirtyPathSummary === undefined)) {
    throw new GitRuntimeError(
      "GIT_SNAPSHOT_RACE",
      "Git worktree status changed while the snapshot was checked.",
    );
  }
  if (dirtyPathSummary !== undefined) {
    throw new GitRuntimeError(
      "GIT_WORKTREE_DIRTY",
      "Git worktree is not clean.",
      dirtyPathSummary,
    );
  }
  return snapshot;
}

async function readHead(repositoryRoot: string): Promise<string> {
  try {
    return (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    throw new GitRuntimeError(
      "GIT_HEAD_UNAVAILABLE",
      "Unable to read Git HEAD.",
    );
  }
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  return executeGit(repositoryRoot, args);
}
