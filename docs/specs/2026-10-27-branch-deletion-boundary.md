# Branch and Worktree Deletion Boundary

## Problem

`andrew-agent commit` is the only command that writes to Git.
`docs/specs/2026-09-18-commit-command.md` makes a direct terminal invocation its authorization, while non-interactive input can only preview.
Deleting branches and worktrees is a different write: it can drop commits that exist nowhere else and uncommitted work in a worktree.
Issue #84 asks the operator to set that boundary before the gone-branch cleanup command (issue #85) is built.

## Decision

The operator decided this boundary on 2026-10-27.

Authorization follows the `commit` rule.
A direct terminal invocation authorizes the deletion without another prompt.
Non-interactive input can show the preview but cannot delete.
The preview always shows every branch and worktree that the command will delete before it deletes any of them.

The command does not fetch.
It reads the `[gone]` upstream state that already exists in the repository and does not run `git fetch --prune`.
The operator fetches first when fresh remote state is necessary.

The command refuses to delete:

- a branch that has a worktree with uncommitted changes;
- the branch that is checked out in the current worktree;
- a branch that `git branch -d` rejects as not fully merged.

## Constraints added while drafting

These constraints were added when this spec was written, as fail-closed readings of the decision above.
The operator approved the first with the spec, not as a separate answer; the second was added in review of PR #121.

- Untracked files in a worktree count as uncommitted changes, so a worktree that holds untracked files is refused.
- The command also refuses a branch whose tip is not reachable from the default branch, resolved from `refs/remotes/origin/HEAD` as the `review` and `pr` commands resolve it. `git branch -d` alone does not give this guarantee: for a branch whose upstream is gone it checks against `HEAD`, so run from a feature branch that contains the tip, it deletes a branch that the default branch does not contain. If the default branch cannot be resolved, the command refuses every deletion.

## Known limit

In a repository that merges pull requests by squash or rebase, the merged branch commits are not reachable from the default branch.
The default-branch reachability check rejects those branches, so the command refuses them.
This limit is accepted: the command never deletes a branch whose commits it cannot find on the default branch.
