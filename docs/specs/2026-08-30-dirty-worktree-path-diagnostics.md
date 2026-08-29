# Specification: Dirty-worktree path diagnostics

Date: 2026-08-30
Status: approved implementation scope for GitHub issue #40

## Goal

Show a bounded list of affected repository-relative paths when preflight
rejects a dirty worktree.
Keep the clean-worktree requirement and all existing fail-closed Git errors.

## Decision

`readGitSnapshot` runs the following command.

```sh
git status --porcelain=v2 -z --untracked-files=all
```

The runtime parses the complete NUL-delimited result before it exposes a
summary.
It keeps at most eight paths and an exact count of later valid records.

`runCommand` and prompted `resumeCommand` render the summary only for a
validated `GIT_WORKTREE_DIRTY` error.
The renderer escapes terminal controls and bounds each displayed path.

## Parser contract

The parser accepts ordinary tracked, rename or copy, unmerged, and untracked
porcelain version 2 records.
It rejects every other record type, incomplete record, malformed metadata,
empty path, or missing NUL terminator.

A rename or copy record contributes its destination path.
The parser also consumes and validates its original-path record before it
accepts the complete result.

If parsing fails, `readGitSnapshot` throws `GIT_STATUS_FAILED`.
It never exposes a partial summary.

## Path-summary contract

The summary contains at most eight repository-relative paths in Git output
order.
It records an exact `omittedPathCount` when more valid records exist.
The runtime applies the limit before it attaches the summary to
`GitRuntimeError`.

The summary is diagnostic data only.
It does not replace `GitSnapshot.porcelainV2`, grant authority to a dirty
worktree, or change the final status-capture flow.

`assume-unchanged` and `skip-worktree` remain an immediate
`GIT_WORKTREE_DIRTY` refusal without a synthesized path summary.
Unsupported gitlinks remain an `UNSUPPORTED_GIT_SUBMODULE` refusal.

## Terminal diagnostic contract

The existing `Repository preflight failed: GIT_WORKTREE_DIRTY.` message stays
as the leading line.
For a validated summary, the diagnostic adds an `Affected paths:` line.
That line contains the retained paths and a nonzero omitted count.

The diagnostic must not print an absolute repository root, object name, file
mode, original rename or copy path, unvalidated text, or partial parse result.
The command-output limit remains authoritative for the rendered diagnostic.

## Acceptance criteria

1. Tracked, untracked, unmerged, and rename or copy records produce the
   expected repository-relative destination path.
2. A path with terminal controls is escaped before it reaches stderr.
3. A long UTF-8 path stays within the terminal field limit and uses the
   existing truncation marker when needed.
4. More than eight valid paths produce eight displayed paths and an exact
   omitted count.
5. A malformed porcelain record produces `GIT_STATUS_FAILED` with no path
   line.
6. Clean snapshots, index-flag refusals, gitlinks, and raw-status capture keep
   their existing behavior.

## Scope

The implementation changes `src/runtime/git.ts`, `src/commands/run.ts`,
`test/integration/git.test.mjs`, and `test/integration/cli.test.mjs`.
It does not change clean-worktree policy, Git process limits, coordinator
behavior, dependencies, README copy, GitHub state, or releases.

## Consultation record

Oracle confirmed that dirty worktrees remain fail-closed and malformed status
cannot produce a complete path claim.
Oracle found no precedent for the `-z` parser, record allowlist, path limit,
or terminal representation.
This specification records those new choices explicitly.

Advisor required the runtime to enforce the eight-path limit.
This keeps an unbounded list away from future consumers.
