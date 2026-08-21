/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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

  constructor(code: GitRuntimeErrorCode, message: string) {
    super(message);
    this.name = "GitRuntimeError";
    this.code = code;
  }
}

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

export function assertCleanGitSnapshot(snapshot: GitSnapshot): GitSnapshot {
  if (!snapshot.clean || snapshot.porcelainV2.length !== 0) {
    throw new GitRuntimeError(
      "GIT_WORKTREE_DIRTY",
      "Git worktree is not clean.",
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
  const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
  return stdout;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    LANG: "C",
    LC_ALL: "C",
  };
}
