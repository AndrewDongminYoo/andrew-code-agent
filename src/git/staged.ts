/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveRepositoryRoot } from "../runtime/git.js";
import { executeGit } from "./process.js";

export type StagedRefusalReason =
  | "MERGE_IN_PROGRESS"
  | "UNRESOLVED_CONFLICT"
  | "STAGED_SUBMODULE"
  | "STAGED_PATHS_UNREADABLE"
  | "CHANGED_WHILE_READ";

// Each command maps the reason to its own wording, so the reader never
// speaks for `commit` or `review`.
export class StagedInputError extends Error {
  readonly reason: StagedRefusalReason;

  constructor(reason: StagedRefusalReason) {
    super(`Staged input refused: ${reason}.`);
    this.reason = reason;
  }
}

export interface StagedChanges {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly headRef: string;
  readonly index: string;
  readonly indexDigest: string;
  readonly patch: string;
  readonly paths: readonly string[];
}

export async function readStagedChanges(input: string): Promise<StagedChanges> {
  const repositoryRoot = await resolveRepositoryRoot(input);
  await assertNoMergeHead(repositoryRoot);
  const head = (await executeGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const headRef = (
    await executeGit(repositoryRoot, [
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ])
  ).trim();
  const index = await executeGit(repositoryRoot, ["ls-files", "--stage", "-z"]);
  if (index.split("\0").some((entry) => /^\d+ [0-9a-f]+ [123]\t/.test(entry)))
    throw new StagedInputError("UNRESOLVED_CONFLICT");
  // `commit` compares this patch with an unflagged diff of the commit it
  // creates, so its arguments must not change.
  const patch = await executeGit(repositoryRoot, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--",
  ]);
  const rawPaths = await executeGit(repositoryRoot, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--",
  ]);
  const paths = rawPaths.endsWith("\0")
    ? rawPaths.slice(0, -1).split("\0")
    : [];
  if (patch.length > 0 && paths.length === 0)
    throw new StagedInputError("STAGED_PATHS_UNREADABLE");
  const rawModes = await executeGit(repositoryRoot, [
    "diff",
    "--cached",
    "--raw",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--",
  ]);
  if (
    rawModes
      .split("\0")
      .some((entry) => /^:(?:160000 \d{6}|\d{6} 160000) /.test(entry))
  )
    throw new StagedInputError("STAGED_SUBMODULE");
  const secondHead = (
    await executeGit(repositoryRoot, ["rev-parse", "HEAD"])
  ).trim();
  const secondHeadRef = (
    await executeGit(repositoryRoot, [
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ])
  ).trim();
  const secondIndex = await executeGit(repositoryRoot, [
    "ls-files",
    "--stage",
    "-z",
  ]);
  if (head !== secondHead || headRef !== secondHeadRef || index !== secondIndex)
    throw new StagedInputError("CHANGED_WHILE_READ");
  return {
    repositoryRoot,
    head,
    headRef,
    index,
    indexDigest: createHash("sha256").update(index).digest("hex"),
    patch,
    paths,
  };
}

async function assertNoMergeHead(repositoryRoot: string): Promise<void> {
  const mergeHead = (
    await executeGit(repositoryRoot, ["rev-parse", "--git-path", "MERGE_HEAD"])
  ).trim();
  try {
    await lstat(resolve(repositoryRoot, mergeHead));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
  throw new StagedInputError("MERGE_IN_PROGRESS");
}
