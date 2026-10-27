/// <reference types="node" />

import { readFile, realpath } from "node:fs/promises";

import { executeGit } from "../git/process.js";
import { resolveRepositoryRoot } from "../runtime/git.js";
import { authorizeInteractiveCommit } from "./commit.js";
import { writeLine, type CommandIO } from "./run.js";

const DEFAULT_BRANCH_SYMBOLIC_REF = "refs/remotes/origin/HEAD";
const MAX_LISTED_IGNORED_ENTRIES = 10;
// Pinned because a repository or global `status.showUntrackedFiles=no` would
// hide untracked files from both this command's dirty check and the one
// `git worktree remove` runs before it agrees to remove a worktree.
const SHOW_UNTRACKED = "status.showUntrackedFiles=normal";

export type CleanGoneRefusal =
  | "CURRENT_BRANCH"
  | "MAIN_WORKTREE"
  | "WORKTREE_IN_PROGRESS"
  | "WORKTREE_MISSING"
  | "WORKTREE_LOCKED"
  | "WORKTREE_UNREADABLE"
  | "WORKTREE_DIRTY"
  | "NOT_ON_DEFAULT"
  | "NOT_MERGED"
  | "CHANGED_SINCE_PREVIEW";

interface Worktree {
  readonly path: string;
  readonly branchRef: string | undefined;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly main: boolean;
  // The branch a rebase or bisect in this worktree will return to. The
  // worktree is detached meanwhile, so `branchRef` does not name it.
  readonly operationRef: string | undefined;
}

interface Candidate {
  readonly name: string;
  readonly tip: string;
  readonly worktreePath: string | undefined;
  readonly ignored: readonly string[];
  readonly refusal: CleanGoneRefusal | undefined;
}

interface Plan {
  readonly defaultRef: string;
  readonly defaultCommit: string;
  readonly candidates: readonly Candidate[];
}

class CleanGoneError extends Error {}

export interface CleanGoneDependencies {
  readonly authorize: (io: CommandIO) => Promise<boolean>;
}

const defaultDependencies: CleanGoneDependencies = {
  authorize: authorizeInteractiveCommit,
};

export async function cleanGoneCommand(
  repositoryInput: string,
  io: CommandIO,
  dependencies: CleanGoneDependencies = defaultDependencies,
): Promise<number> {
  let repositoryRoot: string;
  let preview: Plan;
  try {
    repositoryRoot = await resolveRepositoryRoot(repositoryInput);
    preview = await readPlan(repositoryRoot);
  } catch (error) {
    await writeLine(
      io.stderr,
      error instanceof CleanGoneError
        ? error.message
        : "Unable to read branches and worktrees.",
    );
    return 3;
  }

  if (preview.candidates.length === 0) {
    await writeLine(io.stdout, "No branches with a gone upstream.");
    return 0;
  }
  await writePreview(io, preview);

  if (!(await dependencies.authorize(io))) {
    await writeLine(
      io.stdout,
      "Preview only: nothing was deleted. Run from a terminal to delete.",
    );
    return 0;
  }

  const deletable = preview.candidates.filter(
    (candidate) => candidate.refusal === undefined,
  );
  if (deletable.length === 0) {
    await writeLine(io.stdout, "Nothing to delete.");
    return 0;
  }

  for (const [index, candidate] of deletable.entries()) {
    // The plan is built again before each deletion, so a branch or worktree
    // that changed after the preview is kept rather than deleted on stale
    // facts, including an ignored file the preview never listed.
    let current: Plan;
    try {
      current = await readPlan(repositoryRoot);
    } catch (error) {
      await writeLine(
        io.stderr,
        error instanceof CleanGoneError
          ? error.message
          : "Unable to read branches and worktrees.",
      );
      return 3;
    }
    const fresh = current.candidates.find(
      (entry) => entry.name === candidate.name,
    );
    if (
      fresh === undefined ||
      fresh.refusal !== undefined ||
      fresh.tip !== candidate.tip ||
      fresh.worktreePath !== candidate.worktreePath ||
      fresh.ignored.join("\0") !== candidate.ignored.join("\0") ||
      current.defaultCommit !== preview.defaultCommit
    ) {
      await writeLine(
        io.stdout,
        `Kept ${candidate.name}: CHANGED_SINCE_PREVIEW.`,
      );
      continue;
    }
    const notAttempted = deletable.slice(index + 1).map((entry) => entry.name);
    if (candidate.worktreePath !== undefined) {
      try {
        // Without --force, Git itself refuses a worktree that became dirty.
        await executeGit(repositoryRoot, [
          "-c",
          SHOW_UNTRACKED,
          "worktree",
          "remove",
          candidate.worktreePath,
        ]);
      } catch {
        await writeFailure(
          io,
          `Failed to remove worktree ${candidate.worktreePath} for ${candidate.name}.`,
          notAttempted,
        );
        return 1;
      }
      await writeLine(io.stdout, `Removed worktree ${candidate.worktreePath}.`);
    }
    try {
      await executeGit(repositoryRoot, ["branch", "-d", candidate.name]);
    } catch {
      await writeFailure(
        io,
        `Failed to delete branch ${candidate.name}.`,
        notAttempted,
      );
      return 1;
    }
    await writeLine(
      io.stdout,
      `Deleted branch ${candidate.name} (was ${candidate.tip}).`,
    );
  }
  return 0;
}

async function writePreview(io: CommandIO, plan: Plan): Promise<void> {
  await writeLine(
    io.stdout,
    `Branches with a gone upstream (default branch ${plan.defaultRef} at ${plan.defaultCommit}):`,
  );
  for (const candidate of plan.candidates) {
    if (candidate.refusal !== undefined) {
      await writeLine(
        io.stdout,
        `- keep ${candidate.name} ${candidate.tip}: ${candidate.refusal}`,
      );
      continue;
    }
    if (candidate.worktreePath === undefined) {
      await writeLine(io.stdout, `- delete ${candidate.name} ${candidate.tip}`);
      continue;
    }
    await writeLine(
      io.stdout,
      `- remove worktree ${candidate.worktreePath}, then delete ${candidate.name} ${candidate.tip}`,
    );
    if (candidate.ignored.length > 0) {
      const listed = candidate.ignored.slice(0, MAX_LISTED_IGNORED_ENTRIES);
      const more = candidate.ignored.length - listed.length;
      await writeLine(
        io.stdout,
        `  Ignored entries (${candidate.ignored.length}) that removal deletes: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
      );
    }
  }
}

async function writeFailure(
  io: CommandIO,
  message: string,
  notAttempted: readonly string[],
): Promise<void> {
  await writeLine(io.stderr, `${message} Stopped.`);
  if (notAttempted.length > 0)
    await writeLine(io.stderr, `Not attempted: ${notAttempted.join(", ")}.`);
}

async function readPlan(repositoryRoot: string): Promise<Plan> {
  const defaultRef = await resolveDefaultBranch(repositoryRoot);
  const defaultCommit = (
    await executeGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${defaultRef}^{commit}`,
    ])
  ).trim();
  const currentBranch = await readCurrentBranch(repositoryRoot);
  const worktrees = await readWorktrees(repositoryRoot);
  const refs = await executeGit(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)",
    "refs/heads",
  ]);
  const candidates: Candidate[] = [];
  for (const line of refs.split("\n")) {
    if (line.length === 0) continue;
    const [refName, tip, upstream, track] = line.split("\0");
    if (
      refName === undefined ||
      tip === undefined ||
      upstream === undefined ||
      upstream.length === 0 ||
      track !== "[gone]"
    )
      continue;
    const name = refName.slice("refs/heads/".length);
    const worktree = worktrees.find((entry) => entry.branchRef === refName);
    candidates.push(
      await classify(repositoryRoot, {
        name,
        refName,
        tip,
        defaultCommit,
        currentBranch,
        worktree,
        inOperation: worktrees.some((entry) => entry.operationRef === refName),
      }),
    );
  }
  candidates.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return { defaultRef, defaultCommit, candidates };
}

async function classify(
  repositoryRoot: string,
  input: {
    readonly name: string;
    readonly refName: string;
    readonly tip: string;
    readonly defaultCommit: string;
    readonly currentBranch: string | undefined;
    readonly worktree: Worktree | undefined;
    readonly inOperation: boolean;
  },
): Promise<Candidate> {
  const { name, refName, tip, worktree } = input;
  const keep = (refusal: CleanGoneRefusal): Candidate => ({
    name,
    tip,
    worktreePath: worktree?.path,
    ignored: [],
    refusal,
  });
  if (refName === input.currentBranch) return keep("CURRENT_BRANCH");
  if (input.inOperation) return keep("WORKTREE_IN_PROGRESS");
  let ignored: readonly string[] = [];
  if (worktree !== undefined) {
    if (worktree.main) return keep("MAIN_WORKTREE");
    if (worktree.prunable) return keep("WORKTREE_MISSING");
    if (worktree.locked) return keep("WORKTREE_LOCKED");
    let status: string;
    let index: string;
    try {
      // `-v` tags assume-unchanged entries in lowercase and skip-worktree
      // entries with `S`; status reports neither entry's edits, and
      // `git worktree remove` would delete them.
      index = await executeGit(worktree.path, [
        "ls-files",
        "--cached",
        "-v",
        "-z",
      ]);
      status = await executeGit(worktree.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignored",
      ]);
    } catch {
      return keep("WORKTREE_UNREADABLE");
    }
    if (
      index
        .split("\0")
        .some((entry) => entry.length > 0 && !entry.startsWith("H "))
    )
      return keep("WORKTREE_DIRTY");
    const entries = status.split("\0").filter((entry) => entry.length > 0);
    // A rename entry carries its source path as a second field with no
    // status prefix; any non-ignored entry already makes the worktree dirty.
    if (entries.some((entry) => !entry.startsWith("!! ")))
      return keep("WORKTREE_DIRTY");
    ignored = entries.map((entry) => entry.slice(3));
  }
  if (!(await isAncestor(repositoryRoot, tip, input.defaultCommit)))
    return keep("NOT_ON_DEFAULT");
  // For a branch whose upstream is gone, `git branch -d` checks against the
  // HEAD of this worktree, so a tip outside it would fail only after the
  // worktree was already removed.
  if (!(await isAncestor(repositoryRoot, tip, "HEAD")))
    return keep("NOT_MERGED");
  return {
    name,
    tip,
    worktreePath: worktree?.path,
    ignored,
    refusal: undefined,
  };
}

async function resolveDefaultBranch(repositoryRoot: string): Promise<string> {
  try {
    const ref = (
      await executeGit(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        DEFAULT_BRANCH_SYMBOLIC_REF,
      ])
    ).trim();
    if (!ref.startsWith("refs/remotes/origin/"))
      throw new Error("unsupported ref");
    await executeGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    return ref;
  } catch {
    throw new CleanGoneError(
      "Unable to resolve origin/HEAD to a commit; nothing was deleted.",
    );
  }
}

async function readCurrentBranch(
  repositoryRoot: string,
): Promise<string | undefined> {
  try {
    return (
      await executeGit(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"])
    ).trim();
  } catch {
    return undefined;
  }
}

async function readWorktrees(repositoryRoot: string): Promise<Worktree[]> {
  const raw = await executeGit(repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const worktrees: Worktree[] = [];
  let fields: string[] = [];
  const flush = async () => {
    if (fields.length === 0) return;
    const path = fields
      .find((field) => field.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (path !== undefined) {
      const canonicalPath = await canonical(path);
      worktrees.push({
        path: canonicalPath,
        operationRef: await readOperationRef(canonicalPath),
        branchRef: fields
          .find((field) => field.startsWith("branch "))
          ?.slice("branch ".length),
        locked: fields.some(
          (field) => field === "locked" || field.startsWith("locked "),
        ),
        prunable: fields.some(
          (field) => field === "prunable" || field.startsWith("prunable "),
        ),
        main: worktrees.length === 0,
      });
    }
    fields = [];
  };
  for (const field of raw.split("\0")) {
    if (field.length === 0) await flush();
    else fields.push(field);
  }
  await flush();
  return worktrees;
}

// Rebase records the full ref it will return to; bisect records the short
// branch name. A worktree whose directory is gone yields undefined.
async function readOperationRef(
  worktreePath: string,
): Promise<string | undefined> {
  for (const [gitPath, short] of [
    ["rebase-merge/head-name", false],
    ["rebase-apply/head-name", false],
    ["BISECT_START", true],
  ] as const) {
    let value: string;
    try {
      const statePath = (
        await executeGit(worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          gitPath,
        ])
      ).trim();
      value = (await readFile(statePath, "utf8")).trim();
    } catch {
      continue;
    }
    if (value.length === 0) continue;
    return short && !value.startsWith("refs/") ? `refs/heads/${value}` : value;
  }
  return undefined;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function isAncestor(
  repositoryRoot: string,
  commit: string,
  descendant: string,
): Promise<boolean> {
  try {
    await executeGit(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      commit,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}
