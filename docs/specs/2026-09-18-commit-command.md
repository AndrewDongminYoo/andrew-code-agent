# Specification: Staged commit command

Date: 2026-09-18
Status: approved by the operator's commit-first brief

## Goal

Give the operator one useful daily task through `andrew-agent commit`.
Keep the existing clean-worktree rule for `run` and `resume` intact.

## Input and proposal

The command runs in the current Git repository and requires staged changes.
It reads the staged patch and paths, committed root `AGENTS.md` when present,
and eight recent commit subjects.
It does not add unstaged or untracked content to the proposal or Git index.

Codex receives that bounded input in an ephemeral, read-only scratch directory
with its shell tool disabled.
The read-only sandbox does not itself restrict every file the Codex process can
read.
It proposes one subject and one short summary.
The prompt asks for a split recommendation when staged changes are unrelated.
The command never splits or stages changes automatically.

## Confirmation and Git boundary

The terminal displays the proposed subject, summary, and staged paths.
Only an exact `yes` from terminal stdin authorizes a commit.
Non-interactive input can preview the proposal but cannot commit.

Immediately after confirmation, the command rechecks HEAD, index entries, and
the staged patch.
If any reviewed Git input changed by that check, it refuses the commit and asks
for another review.
It runs normal Git hooks without `--no-verify`.
After Git reports success, it compares the new commit's parent, patch, and
subject with the reviewed proposal.
A hook or concurrent writer that changes the result is reported rather than
silently accepted.
Another writer can change HEAD or the index after the final check and before
Git starts committing, so a mismatch may be reported after a commit already
exists.
Inspect HEAD before retrying after an uncertain commit result.
The command never pushes.

## Limits and non-goals

The first version refuses a staged patch over 256 KiB.
It requires an existing HEAD and does not support staged submodules or
unresolved index conflicts.
It does not implement `review`, `pr`, automatic commit splitting, or push.

## Acceptance criteria

1. Staged content alone reaches the proposal and commit while unstaged and
   untracked content remains untouched.
2. The proposed subject and summary are shown before an exact terminal
   confirmation; a pipe cannot authorize a commit.
3. A changed HEAD or staged index detected by the final pre-commit check
   prevents the commit.
4. A hook-rewritten subject or patch is reported after commit creation.
5. A manual real Codex run can produce a proposal without committing in a
   non-interactive preview.
6. The CLI grammar, README, scoped tests, and Trunk gate cover the command.

## Consultation record

Oracle's staged-index precedent supports the immediate index recheck.
Its confirmation precedent supports the explicit `yes` boundary.
Its hook precedent supports normal hook execution and post-commit comparison.
