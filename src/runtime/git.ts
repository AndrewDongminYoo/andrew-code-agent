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
  | "GIT_WORKTREE_DIRTY";

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
  await assertSupportedIndexFlags(repositoryRoot);
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
  await assertSupportedIndexFlags(repositoryRoot);
  return {
    repositoryRoot,
    head: firstHead,
    porcelainV2,
    clean: porcelainV2.length === 0,
  };
}

async function assertSupportedIndexFlags(
  repositoryRoot: string,
): Promise<void> {
  let indexEntries: string;
  try {
    indexEntries = await runGit(repositoryRoot, [
      "ls-files",
      "--cached",
      "--full-name",
      "-v",
      "-z",
    ]);
  } catch {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }

  const indexTags = parseIndexTags(indexEntries);
  if (indexTags === null) {
    throw new GitRuntimeError(
      "GIT_STATUS_FAILED",
      "Unable to read Git worktree status.",
    );
  }
  if (indexTags.some((tag) => tag !== "H")) {
    throw new GitRuntimeError(
      "GIT_WORKTREE_DIRTY",
      "Git worktree is not clean.",
    );
  }
}

function parseIndexTags(indexEntries: string): string[] | null {
  if (indexEntries.length === 0) return [];
  if (!indexEntries.endsWith("\0")) return null;
  const indexEntriesWithoutTerminalNul = indexEntries.slice(0, -1).split("\0");
  if (
    indexEntriesWithoutTerminalNul.some(
      (entry) => entry.length < 3 || entry[1] !== " ",
    )
  ) {
    return null;
  }
  return indexEntriesWithoutTerminalNul.map((entry) => entry[0]!);
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
    LANG: "C",
    LC_ALL: "C",
  };
}
