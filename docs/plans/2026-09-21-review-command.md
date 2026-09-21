# Plan: Branch review command

Date: 2026-09-21
Status: implemented; PR delivery in progress

## Direction

Add `andrew-agent review [base]` as the second daily task after `commit`.
The default resolves `origin/HEAD`, while an optional positional ref supports
repositories that need another comparison base.
Keep the first version read-only and limited to committed changes in a clean
worktree.

## Steps and checks

1. Add failing CLI and command integration tests for grammar, default and
   explicit base resolution, empty comparisons, read-only invocation, evidence
   instructions, and Git races.
   Verify the red state with
   `pnpm build && node --test test/integration/review.test.mjs test/integration/cli.test.mjs`.
2. Extract the existing bounded Codex JSONL execution into a small shared
   module without changing `commit` behavior.
   Verify the existing commit subprocess tests and the new review
   child-argument assertions.
3. Implement exact Git comparison capture, clean-worktree enforcement, an
   isolated committed-only review checkout, review invocation, post-review
   race checks, and bounded terminal rendering.
   Verify the focused review and CLI integration tests.
4. Document the command, review the complete diff, and repair only contract
   defects.
   Verify `pnpm check`, `trunk check --all --no-fix`, `git diff --check`, and
   the built CLI help.
5. Create semantic commits, push the personal-account branch, open a PR, and
   observe current-head CI and hosted review within the loop budget.

## Owned paths

- `src/cli.ts`
- `src/codex/exec.ts`
- `src/commands/commit.ts`
- `src/commands/review.ts`
- `test/integration/cli.test.mjs`
- `test/integration/commit.test.mjs` only if the shared execution boundary
  needs an assertion update
- `test/integration/review.test.mjs`
- `README.md`
- `docs/specs/2026-09-21-review-command.md`
- `docs/plans/2026-09-21-review-command.md`

## Review focus

Check whether the reported comparison can drift from the reviewed HEAD or base,
whether transient source-worktree content can enter the isolated committed-only
review checkout, whether the Codex child can write or load personal user
configuration, and whether unsupported model claims can be presented as
findings.
Confirm that no-change and zero-finding outcomes remain successful rather than
manufacturing review comments.

## Completion boundary

This plan ends at a reviewed PR ready for operator merge.
Merge, branch cleanup, and memory recording require separate authority.
