# Specification: Gone-branch cleanup command

Date: 2026-10-27 Status: approved by the operator on 2026-10-27

## Goal

Remove local branches whose upstream was deleted after merge, together with their worktrees, through `andrew-agent clean-gone`.
The command follows the boundary in `docs/specs/2026-10-27-branch-deletion-boundary.md`; this spec does not widen it.

## Input

The command runs in the current Git repository and takes no arguments.
It does not fetch, and it does not invoke Codex, the App Server, or the managed runtime state.

It reads local branches with `git for-each-ref refs/heads` and their `%(upstream)` and `%(upstream:track)` fields.
A branch is a candidate when it has an upstream and its track field is exactly `[gone]`.
It does not parse `git branch -v` or `-vv` output.

It reads worktrees with `git worktree list --porcelain -z` and maps each candidate to the worktree that has it checked out, if any.

It resolves the default branch from `refs/remotes/origin/HEAD`, as `review` and `pr` do.
If that ref cannot be resolved to a commit, the command refuses every deletion and exits `3`.

## Refusals

The command keeps a candidate and reports one reason when any of these holds:

- `CURRENT_BRANCH`: the branch is checked out in the worktree where the command runs.
- `MAIN_WORKTREE`: the branch is checked out in the main worktree, which cannot be removed.
- `WORKTREE_IN_PROGRESS`: a rebase or bisect in some worktree will return to the branch. That worktree is detached meanwhile, so `git worktree list` does not name the branch.
- `WORKTREE_DIRTY`: its worktree has staged, unstaged, or untracked changes. The check pins `--untracked-files=normal`, and the worktree removal pins `status.showUntrackedFiles=normal`, so a repository or global `status.showUntrackedFiles=no` cannot hide untracked files from either.
- `WORKTREE_LOCKED`: its worktree is locked.
- `WORKTREE_MISSING`: its worktree directory does not exist (Git reports it as prunable).
- `WORKTREE_UNREADABLE`: the status of its worktree cannot be read.
- `NOT_ON_DEFAULT`: the branch tip is not reachable from the default branch.
- `NOT_MERGED`: the branch tip is not reachable from HEAD of the worktree where the command runs. For a branch whose upstream is gone, `git branch -d` checks against that HEAD, so it would reject the branch; the command refuses it before removing any worktree.
- `CHANGED_SINCE_PREVIEW`: the branch tip, its worktree, its ignored entries, or its refusal state changed between the preview and the deletion.

A refusal applies to that candidate only; the command still deletes the other candidates.
A refusal is an expected outcome, so it does not change the exit code.

## Ignored files

`git worktree remove` without `--force` refuses a worktree with modified or untracked files, but it deletes ignored files without warning.
This was confirmed on Git 2.54.0 on 2026-10-27: a worktree that held only an ignored `secret.env` was removed with exit `0`.

The preview lists, for each worktree it will remove, the number of ignored entries and the first ten of them.
An entry is what `git status --ignored` prints, so an ignored directory is one entry rather than every file inside it.
Removing the worktree deletes those paths; the operator chose this over refusing such worktrees on 2026-10-27.

## Preview and authorization

The command always prints the preview first.
The preview lists every candidate with its tip commit, its worktree path if any, and either the action (delete the branch, or remove the worktree and then delete the branch) or the refusal reason.
Every branch name and path passes through the terminal escaping that the other commands use.

A direct terminal invocation authorizes the deletion without another prompt, as for `commit`.
Non-interactive input prints the preview, states that nothing was deleted, and exits `0`.

## Deletion

For each candidate that is not refused, in branch-name order, the command:

1. builds the plan again and refuses the candidate with `CHANGED_SINCE_PREVIEW` if its tip, its worktree, its list of ignored entries, or the default branch changed, or it is now refused;
2. removes the worktree with `git worktree remove` without `--force`, so Git refuses a worktree that became dirty after step 1;
3. deletes the branch with `git branch -d`, never `-D`.

A failure in step 2 or 3 stops the run.
The command reports what it already deleted, what failed, and what it did not attempt, and exits `1`.
It never retries with `--force` or `-D`.

## Exit codes

- `0`: the preview completed and every candidate that was not refused was deleted, or there was no candidate, or the invocation was non-interactive.
- `1`: a worktree removal or branch deletion failed, or output could not be written.
- `2`: invalid command usage.
- `3`: the repository or the default branch could not be read.

## Limits and non-goals

The command does not fetch or prune remote-tracking refs, delete remote branches, contact GitHub, or decide "merged" from pull-request state.
In a repository that merges by squash or rebase, the merged branch tips are not reachable from the default branch, so every such branch is refused with `NOT_ON_DEFAULT`.
It does not delete a branch that has no upstream.

## Acceptance criteria

Each criterion is covered by a test against a fixture repository with a local bare remote.

1. A gone branch without a worktree is deleted.
2. A gone branch with a clean worktree has its worktree removed and is then deleted.
3. A gone branch whose worktree has an untracked file is refused with `WORKTREE_DIRTY`, and the file remains.
4. The current branch is refused with `CURRENT_BRANCH`, even when its upstream is gone.
5. A gone branch whose tip is reachable only from another feature branch, run from that feature branch, is refused with `NOT_ON_DEFAULT`.
6. With `origin/HEAD` unresolvable, nothing is deleted and the exit code is `3`.
7. Piped input prints the same preview and deletes nothing.
8. The preview lists the ignored paths of a worktree before it is removed.
9. A branch whose tip moves between the preview and deletion is refused.
10. A worktree that gains an untracked or ignored file between the preview and deletion is kept with its file.
11. An untracked file keeps its worktree even with `status.showUntrackedFiles=no` in the repository configuration.
12. A branch being rebased in a worktree is refused with `WORKTREE_IN_PROGRESS`, and later candidates are still deleted.
13. The CLI grammar, README, scoped tests, `pnpm check`, and `trunk check --all --no-fix` cover the command on macOS.

## Consultation record

Oracle's precedent from the `clean-gone` skill supports refusing the checked-out branch and dirty, locked, or missing worktrees, removing the worktree before the branch, and not parsing `git branch -vv`, whose `[origin/x: gone]` shape once produced a false diagnosis.
The skill decides "merged" from GitHub pull-request state and deletes with `-D`; this command cannot, because `docs/specs/2026-10-27-branch-deletion-boundary.md` keeps it to ancestry and `git branch -d`.
The skill's 2026-10-25 precedent requires the tip to be contained in the updated default branch before deletion, which matches `NOT_ON_DEFAULT`.
The skill also skips a worktree that holds ignored paths, because it removes with `--force`; this command lists ignored paths in the preview and removes them instead, by operator decision recorded at approval.
