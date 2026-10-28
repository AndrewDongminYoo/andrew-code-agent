# Quality Tooling Refresh Plan

## Approved Work

Use the [maintenance contract](../specs/2026-10-28-quality-refresh.md) and the existing main workspace.

## Steps

1. Verify personal ownership, current Git state, repository instructions, and Oracle precedent.
2. Inspect manifests, lockfiles, linter definitions, and relevant knowledge claims before edits.
3. Upgrade supported versions without broad ignore changes or generated-file edits.
4. Run the build-first unit test layer followed by `pnpm check`.
5. Run `trunk check --all --no-fix` and inspect the final diff.
6. Correct implementation-caused documentation drift and validate local links.
7. Commit scoped concerns and prepare visible review evidence.

## Boundary

Do not push or create a pull request before explicit repository-specific approval.
Do not run live service operations or authenticated product smoke tests.
