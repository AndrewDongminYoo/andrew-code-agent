/// <reference types="node" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executeGit, executeGitBytes } from "../git/process.js";
import {
  readStagedChanges,
  StagedInputError,
  type StagedRefusalReason,
} from "../git/staged.js";
import {
  initializeRuntimeState,
  resolveRuntimePaths,
  RuntimePathError,
} from "../runtime/paths.js";
import {
  CLEANUP_WARNING,
  fetchReviewCommits,
  MAX_PROMPT_PATHS,
  parseNumstat,
  REVIEW_RULES,
  ReviewExecutionError,
  ReviewPreparationError,
  runCodexReview,
  runPreparedReview,
  runtimePreparationMessage,
  type ReviewExecutionResult,
} from "./review.js";
import { writeLine, type CommandIO } from "./run.js";

const REVIEW_REFUSALS: Readonly<Record<StagedRefusalReason, string>> = {
  MERGE_IN_PROGRESS:
    "Complete or abort the merge before reviewing staged changes.",
  UNRESOLVED_CONFLICT:
    "Resolve merge conflicts before reviewing staged changes.",
  STAGED_SUBMODULE: "Staged submodules are unsupported.",
  STAGED_PATHS_UNREADABLE: "Unable to identify staged paths.",
  CHANGED_WHILE_READ:
    "HEAD or staged content changed while it was read; retry.",
};

export interface StagedReviewInput {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly headRef: string;
  readonly index: string;
  readonly patch: string;
  readonly applyPatch: Buffer;
  readonly paths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
  readonly prompt: string;
}

export interface StagedReviewDependencies {
  readonly review: (
    input: StagedReviewInput,
  ) => Promise<string | ReviewExecutionResult>;
}

const defaultDependencies: StagedReviewDependencies = {
  review: reviewStagedWithCodex,
};

export async function stagedReviewCommand(
  repositoryInput: string,
  io: CommandIO,
  dependencies: StagedReviewDependencies = defaultDependencies,
): Promise<number> {
  let snapshot: StagedReviewInput;
  try {
    snapshot = await readStagedReviewInput(repositoryInput);
  } catch (error) {
    await writeLine(
      io.stderr,
      error instanceof StagedInputError
        ? REVIEW_REFUSALS[error.reason]
        : "Unable to prepare staged review.",
    );
    return 3;
  }

  if (snapshot.patch.length === 0) {
    await writeLine(io.stdout, "No staged changes to review.");
    return 0;
  }

  let response: string;
  let cleanupWarning: string | undefined;
  try {
    const result = await dependencies.review(snapshot);
    response = typeof result === "string" ? result : result.response;
    cleanupWarning =
      typeof result === "string" ? undefined : result.cleanupWarning;
    if (response.trim().length === 0)
      throw new Error("Codex returned an empty review.");
  } catch (error) {
    const primaryError =
      error instanceof ReviewExecutionError ? error.primaryError : error;
    if (error instanceof ReviewExecutionError)
      await writeLine(io.stderr, error.cleanupWarning);
    if (primaryError instanceof StagedCheckoutMismatchError) {
      await writeLine(io.stderr, STAGED_MISMATCH_MESSAGE);
      return 3;
    }
    const preparationFailure = runtimePreparationMessage(primaryError);
    if (preparationFailure !== undefined) {
      await writeLine(io.stderr, preparationFailure);
      return 3;
    }
    await writeLine(
      io.stderr,
      "Unable to review changes. Check the managed Codex login and runtime paths.",
    );
    return 1;
  }

  let current: StagedReviewInput;
  try {
    current = await readStagedReviewInput(repositoryInput);
  } catch {
    if (cleanupWarning !== undefined)
      await writeLine(io.stderr, cleanupWarning);
    await writeLine(io.stderr, "Review inputs changed; run review again.");
    return 3;
  }
  if (stagedReviewIdentity(current) !== stagedReviewIdentity(snapshot)) {
    if (cleanupWarning !== undefined)
      await writeLine(io.stderr, cleanupWarning);
    await writeLine(io.stderr, "Review inputs changed; run review again.");
    return 3;
  }

  await writeLine(
    io.stdout,
    `Reviewing staged changes on ${snapshot.headRef} (${snapshot.head}).`,
  );
  for (const line of response.trimEnd().split("\n"))
    await writeLine(io.stdout, line);
  if (cleanupWarning !== undefined) await writeLine(io.stderr, cleanupWarning);
  return 0;
}

export async function readStagedReviewInput(
  repositoryInput: string,
): Promise<StagedReviewInput> {
  const staged = await readStagedChanges(repositoryInput);
  const base = {
    repositoryRoot: staged.repositoryRoot,
    head: staged.head,
    headRef: staged.headRef,
    index: staged.index,
    patch: staged.patch,
    paths: staged.paths,
  };
  if (staged.patch.length === 0)
    return {
      ...base,
      applyPatch: Buffer.alloc(0),
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      prompt: "",
    };
  const applyPatch = await readApplyPatch(staged.repositoryRoot);
  const { additions, deletions, binaryFiles } = parseNumstat(
    await executeGit(staged.repositoryRoot, [
      "diff",
      "--cached",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ]),
  );
  const finalHead = (
    await executeGit(staged.repositoryRoot, ["rev-parse", "HEAD"])
  ).trim();
  const finalIndex = await executeGit(staged.repositoryRoot, [
    "ls-files",
    "--stage",
    "-z",
  ]);
  if (finalHead !== staged.head || finalIndex !== staged.index)
    throw new StagedInputError("CHANGED_WHILE_READ");
  const metadata = {
    ...base,
    applyPatch,
    additions,
    deletions,
    binaryFiles,
  };
  return { ...metadata, prompt: stagedReviewPrompt(metadata) };
}

function stagedReviewPrompt(input: Omit<StagedReviewInput, "prompt">): string {
  const suppliedPaths = input.paths.slice(0, MAX_PROMPT_PATHS);
  const metadata = {
    head: input.head,
    headRef: input.headRef,
    changedFileCount: input.paths.length,
    additions: input.additions,
    deletions: input.deletions,
    binaryFiles: input.binaryFiles,
    paths: suppliedPaths,
    omittedPathCount: input.paths.length - suppliedPaths.length,
  };
  return [
    "Inspect the repository and review only the staged changes: the index of this checkout compared with the HEAD commit in the supplied metadata, as git diff --cached shows them.",
    ...REVIEW_RULES,
    JSON.stringify(metadata),
  ].join("\n\n");
}

export async function reviewStagedWithCodex(
  input: StagedReviewInput,
): Promise<ReviewExecutionResult> {
  let paths;
  try {
    paths = await resolveRuntimePaths();
    await initializeRuntimeState(paths);
  } catch (error) {
    if (error instanceof RuntimePathError) throw error;
    throw new ReviewPreparationError(error);
  }
  return await runPreparedReview(
    async () => {
      try {
        return await createStagedReviewCheckout(
          input.repositoryRoot,
          paths.stateRoot,
          input,
        );
      } catch (error) {
        const primaryError =
          error instanceof ReviewExecutionError ? error.primaryError : error;
        const preparationError =
          primaryError instanceof StagedCheckoutMismatchError
            ? primaryError
            : new ReviewPreparationError(primaryError);
        if (error instanceof ReviewExecutionError)
          throw new ReviewExecutionError(
            preparationError,
            error.cleanupWarning,
          );
        throw preparationError;
      }
    },
    async (checkout) =>
      await runCodexReview(
        paths.codexBin,
        paths.codexHome,
        checkout,
        input.prompt,
      ),
    async (checkout) => await rm(checkout, { recursive: true, force: true }),
  );
}

export function stagedReviewIdentity(input: StagedReviewInput): string {
  return JSON.stringify({
    head: input.head,
    headRef: input.headRef,
    index: input.index,
    patch: input.patch,
  });
}

export const STAGED_MISMATCH_MESSAGE =
  "Staged checkout does not match the index. Intent-to-add entries from git add -N are one known cause.";

export class StagedCheckoutMismatchError extends Error {
  constructor(cause?: unknown) {
    super(STAGED_MISMATCH_MESSAGE, { cause });
  }
}

export interface StagedCheckoutInput {
  readonly head: string;
  readonly index: string;
  readonly applyPatch: Buffer;
}

// The source repository's diff configuration can drop the a/ and b/ prefixes,
// add colour, or remove context lines, and `git apply` rejects all three, so
// the output format is pinned. Plumbing `diff-index` would ignore that
// configuration, but it also emits intent-to-add entries as empty new files,
// which would turn the intent-to-add refusal into a review of a file the
// commit will not contain. The patch is kept as raw bytes, so content that is
// not UTF-8 (a legacy-encoded text file, or a binary file a diff driver forces
// to a text diff) applies unchanged; quoting keeps such a path as escapes.
export async function readApplyPatch(repositoryRoot: string): Promise<Buffer> {
  return await executeGitBytes(repositoryRoot, [
    "-c",
    "core.quotePath=true",
    "diff",
    "--cached",
    "--no-color",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--",
  ]);
}

// The index listing (mode, blob, path per entry) is the identity check: patch
// text varies with user configuration for identical content, the listing does
// not. An intent-to-add entry is listed but never diffed, so it fails here.
export async function createStagedReviewCheckout(
  sourceRepository: string,
  stateRoot: string,
  input: StagedCheckoutInput,
  removeCheckout: (path: string) => Promise<void> = async (path) =>
    await rm(path, { recursive: true, force: true }),
): Promise<string> {
  const checkout = await mkdtemp(join(stateRoot, "review-"));
  const isolated = { isolateConfig: true } as const;
  try {
    await fetchReviewCommits(sourceRepository, checkout, [
      `${input.head}:refs/heads/review-head`,
    ]);
    // HEAD goes into the index only, and the worktree is written once from
    // the patched index, so an old path never exists on disk. A case-only
    // rename would otherwise collide on a case-insensitive file system.
    await executeGit(
      checkout,
      ["update-ref", "--no-deref", "HEAD", input.head],
      isolated,
    );
    // A tracked symlink is written as a plain file holding its target, so the
    // review cannot follow it out of the checkout into source-worktree dirt.
    await executeGit(checkout, ["config", "core.symlinks", "false"], isolated);
    await executeGit(checkout, ["read-tree", "review-head"], isolated);
    const patchPath = join(checkout, ".git", "andrew-agent-staged.patch");
    await writeFile(patchPath, input.applyPatch, { flag: "wx", mode: 0o600 });
    try {
      await executeGit(
        checkout,
        ["apply", "--cached", "--binary", patchPath],
        isolated,
      );
      await executeGit(checkout, ["checkout-index", "--all"], isolated);
    } catch (error) {
      throw new StagedCheckoutMismatchError(error);
    } finally {
      await rm(patchPath, { force: true });
    }
    const checkoutHead = (
      await executeGit(
        checkout,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        isolated,
      )
    ).trim();
    const listing = await executeGit(
      checkout,
      ["ls-files", "--stage", "-z"],
      isolated,
    );
    const untracked = await executeGit(
      checkout,
      ["ls-files", "--others", "-z"],
      isolated,
    );
    let worktreeMatchesIndex = true;
    try {
      await executeGit(
        checkout,
        ["diff", "--quiet", "--no-ext-diff", "--no-textconv"],
        isolated,
      );
    } catch {
      worktreeMatchesIndex = false;
    }
    if (
      checkoutHead !== input.head ||
      listing !== input.index ||
      untracked !== "" ||
      !worktreeMatchesIndex
    )
      throw new StagedCheckoutMismatchError();
    return checkout;
  } catch (error) {
    try {
      await removeCheckout(checkout);
    } catch {
      throw new ReviewExecutionError(error, CLEANUP_WARNING);
    }
    throw error;
  }
}
