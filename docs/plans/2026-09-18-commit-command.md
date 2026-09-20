# Plan: Staged commit command

Date: 2026-09-18
Status: implementation present; local review and PR delivery pending

## Direction

The operator approved `commit` as the first daily task and asked to wait for ten
real uses before choosing another command.
The approved direction uses a staged-only proposal, direct terminal invocation
as authorization, HEAD and index recheck, normal Git commit, and no push from
this command.

## Steps and checks

1. Add the `commit` CLI route without changing `run` preflight.
   Verify with `pnpm build` and the CLI integration test.
2. Read only the staged Git patch and committed style context for one Codex
   proposal.
   Verify with a fixture containing staged, unstaged, and untracked variants,
   plus a real non-interactive preview.
3. Authorize through direct terminal invocation, recheck HEAD and index, commit
   with normal hooks, and compare the result with the reviewed proposal.
   Verify with interactive-authorization, non-interactive preview, index-race,
   HEAD-race, and hook tests.
4. Review the complete candidate, repair only contract defects, then run scoped
   tests, `pnpm check`, and `trunk check --all --no-fix`.
   Repair a reproduced gate fixture failure separately from the feature.
5. Make scoped semantic commits, push a personal-account branch, open a PR, and
   observe current-head CI and hosted review within the loop budget.

## Owned paths

- `src/cli.ts` and `src/commands/commit.ts`
- `test/integration/cli.test.mjs` and `test/integration/commit.test.mjs`
- `README.md` and these two contract documents
- `test/integration/doctor.test.mjs` for the separately reproduced gate fixture
  failure

## Review focus

Inspect whether Git or Codex can read unstaged content, whether a stale proposal
can authorize a changed index, and whether hooks can change the committed patch
or subject without a visible warning.
Check failure diagnostics and temporary state cleanup.

## Completion boundary

This plan ends at a reviewed PR ready for operator merge.
Merge, branch cleanup, and memory recording require their separate authority.
