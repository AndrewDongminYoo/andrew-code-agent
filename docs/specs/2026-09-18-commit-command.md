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

## Authorization and Git boundary

The terminal displays the proposed subject, summary, and staged paths.
A direct terminal invocation authorizes the commit without another prompt.
Non-interactive input can preview the proposal but cannot commit.

Immediately after authorization, the command rechecks HEAD, index entries, and
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
It requires an existing HEAD.
Staged submodules, unresolved index conflicts, and in-progress merges are not supported.
It does not implement `review`, `pr`, automatic commit splitting, or push.

## Acceptance criteria

1. Staged content alone reaches the proposal and commit while unstaged and
   untracked content remains untouched.
2. The proposed subject and summary are shown before an interactive invocation
   commits; a pipe cannot authorize a commit.
3. A changed HEAD or staged index detected by the final pre-commit check
   prevents the commit.
4. A hook-rewritten subject or patch is reported after commit creation.
5. A manual real Codex run can produce a proposal without committing in a
   non-interactive preview.
6. The CLI grammar, README, scoped tests, and Trunk gate cover the command.

## Consultation record

Oracle's staged-index precedent supports the immediate index recheck.
Oracle's confirmation precedent originally supported the explicit `yes` boundary.
After eight real uses, the operator found the repeated prompt unnecessary and
explicitly made direct terminal invocation the authorization boundary while
retaining preview-only non-interactive behavior.
Its hook precedent supports normal hook execution and post-commit comparison.
