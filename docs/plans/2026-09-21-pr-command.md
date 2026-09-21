# PR Body Command Implementation Plan

## Scope

Implement `andrew-agent pr [base]` as a read-only local PR-body generator for
committed branch changes.
Reuse the exact-comparison and isolated-checkout safety boundaries established
by `review` without weakening either command.

## Files

- Add `src/commands/pr.ts` for comparison validation, prompt construction, body
  validation, race checks, and output.
- Add `test/integration/pr.test.mjs` for the command contract and failure boundaries.
- Update `src/cli.ts` and `test/integration/cli.test.mjs` for the new grammar.
- Update `README.md` with behavior, limits, and exit semantics.
- Keep shared changes to `src/commands/review.ts` or `src/codex/exec.ts` limited
  to reusable safety seams that tests require.

## TDD sequence

1. Add CLI and command integration tests that expect `andrew-agent pr [base]`,
   exact comparison metadata, passed diff-check evidence, and explicit unrun
   project validation.
2. Run the focused tests and record the expected missing-command failures.
3. Implement the smallest command path that produces a validated Markdown body
   from a dependency-injected generator.
4. Add failing tests for empty comparisons, dirty or detached worktrees,
   diff-check failure, stale Git inputs, malformed or oversized bodies, isolated
   checkout contents, cleanup, and interruption.
5. Reuse or extract only the review comparison and checkout mechanisms needed
   to pass those tests.
6. Run the focused command, review, commit, and CLI integration tests.

## Verification

- Focused integration tests:

  ```bash
  pnpm build && node --test --test-concurrency=1 \
    test/integration/pr.test.mjs \
    test/integration/review.test.mjs \
    test/integration/commit.test.mjs \
    test/integration/cli.test.mjs
  ```

- `pnpm check`
- `trunk check --all --no-fix`
- `git diff --check`
- `codex doctor --summary --ascii --no-color`
- Run the built `andrew-agent pr` against this feature branch and compare its
  claims with the exact diff and observed gates.
- Run `andrew-agent review` on the final committed candidate before publication.

## Local review

Review the complete diff against the specification after the first green
aggregate gate.
Check prompt-injection boundaries, unsupported validation claims, output purity,
Git races, cleanup, and interruption.
Apply at most two local repair rounds before publication.

## Delivery

Use concern-based semantic commits, push `feat/pr-command`, and open a PR against
`main`.
Observe current-head CI, CodeRabbit or its explicit skip, hosted Codex review,
and every paginated review thread.
Stop at the operator merge boundary.

Visual approval is not required because the change affects CLI parsing,
Markdown text output, documentation, and automated tests only.
