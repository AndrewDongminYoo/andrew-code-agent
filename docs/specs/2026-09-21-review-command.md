# Specification: Branch review command

Date: 2026-09-21
Status: approved by the operator's review-command brief

## Goal

Give the operator an evidence-based review of committed changes on the current
branch compared with a base branch through `andrew-agent review [base]`.
Report confirmed defects separately from missing verification and do not modify
the repository.

## Comparison boundary

The command runs in the current Git repository and requires a clean worktree.
It requires a named current branch and an existing HEAD.
With no argument, it resolves the symbolic `refs/remotes/origin/HEAD` reference
as the base.
One positional argument selects an explicit local or remote base ref.

Before review, the command resolves the exact current HEAD, current branch ref,
base commit, and merge base.
It reads `<base>..HEAD` history and three-dot diff metadata from those resolved
commits.
If the three-dot diff contains no changed paths, it reports that there are no
changes and does not invoke Codex.

## Review behavior

The command copies the exact resolved base and HEAD commit objects into a
temporary standalone review repository under the managed state root.
The temporary repository retains no remote that points to the source worktree
and contains only committed checkout content.
Git commands that construct and validate the checkout ignore system and global
configuration, and exact fetches preserve shallow source boundaries.
The command invokes the managed Codex login through `codex exec` in that
isolated checkout with the exact resolved comparison metadata.
Codex runs with an explicit read-only sandbox, ephemeral session storage, and
user configuration disabled.
Repository instructions remain available to the review.
The read-only sandbox is a write boundary rather than a universal filesystem
read restriction; the isolated checkout prevents normal repository inspection
from reading transient source-worktree content.

The review prompt requires every defect to cite a changed path and line and
explain a concrete failure mechanism supported by repository evidence.
It excludes style-only comments, unsupported speculation, and findings outside
the comparison.
It lists missing verification separately because absent validation is not proof
of faulty behavior.
It states when no defects are found and identifies validation that it did not
run.

The command holds the final model response until it rechecks the current HEAD,
branch ref, base commit, and clean worktree.
If any reviewed Git input changed, it discards the response and asks the
operator to rerun the review.
The command prints the resolved comparison identities before the final review
response.
If temporary-checkout cleanup fails, the command emits a redacted warning while
preserving a successful response or the original review failure and exit code.
If the operator interrupts the review, the command terminates the Codex process
group and attempts checkout cleanup before returning a failure.

## Limits and non-goals

The first version reviews committed branch changes only.
It does not include staged, unstaged, or untracked changes and does not fetch a
base branch automatically.
It does not edit files, run repairs, create commits, push, publish comments, or
approve a pull request.
It does not guarantee that Codex ran every relevant test.

## Exit behavior

- Exit `0` means the review completed or the comparison contained no changes.
- Exit `1` means Codex review or terminal output failed.
- Exit `2` means command usage was invalid.
- Exit `3` means repository, comparison, or runtime preparation failed.

## Acceptance criteria

1. The default base and one explicit base ref resolve to exact commits, and the
   command reports the exact comparison identities.
2. Only committed three-dot branch changes reach `codex exec`; a dirty
   worktree is rejected before model invocation.
3. The Codex child receives an explicit read-only, ephemeral,
   user-config-independent invocation in a temporary repository containing the
   exact committed comparison and no source-worktree dirt.
4. Checkout preparation does not run system or global Git hooks and works when
   the exact comparison is available from a shallow source repository.
5. An interrupt terminates the Codex process group and attempts checkout
   cleanup, and a cleanup failure is reported without replacing a successful
   response or the primary review failure.
6. Empty comparisons do not invoke Codex.
7. A changed HEAD, branch ref, base commit, or worktree detected after review
   prevents stale output from being reported.
8. Output instructions distinguish evidence-backed defects from missing
   verification and accept zero findings.
9. CLI grammar, README, focused integration tests, `pnpm check`, and the Trunk
   gate cover the command.

## Consultation record

Oracle's diff precedent requires resolving the base before interpreting a
change, reading branch history, and using three-dot diff metadata.
Its review precedent requires claims to originate from the real diff, findings
to carry concrete evidence, and missing verification to remain distinct from
correctness defects.
Its review-depth precedent accepts zero findings and scales effort with changed
files, changed lines, and core-area impact.
The exact-topic Oracle search returned `[no precedent found]`; the applicable
sources were global rather than project-specific.
