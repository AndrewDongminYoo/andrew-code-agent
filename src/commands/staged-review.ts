/// <reference types="node" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executeGit } from "../git/process.js";
import {
  CLEANUP_WARNING,
  fetchReviewCommits,
  ReviewExecutionError,
} from "./review.js";

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
  readonly applyPatch: string;
}

// The source repository's diff configuration can drop the a/ and b/ prefixes
// or add colour, and `git apply` rejects both, so the output format is pinned.
export async function readApplyPatch(repositoryRoot: string): Promise<string> {
  return await executeGit(repositoryRoot, [
    "diff",
    "--cached",
    "--no-color",
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
    await executeGit(
      checkout,
      ["switch", "--quiet", "--detach", "review-head"],
      isolated,
    );
    const patchPath = join(checkout, ".git", "andrew-agent-staged.patch");
    await writeFile(patchPath, input.applyPatch, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await executeGit(
        checkout,
        ["apply", "--index", "--binary", patchPath],
        isolated,
      );
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
