# Dirty-worktree path diagnostics plan

Date: 2026-08-30
Issue: GitHub #40

## Goal

Show up to eight safe repository-relative paths after dirty-worktree
preflight rejects a command.
Keep the existing fail-closed authority boundary.

## Scope

- Modify `src/runtime/git.ts` to request NUL-delimited porcelain version 2
  status, validate it, and retain a bounded path summary.
- Modify `src/commands/run.ts` to render that validated summary after the
  existing preflight diagnostic.
- Add focused integration tests for Git records, malformed input, path
  limits, terminal escaping, and phase-independent diagnostics.

Do not modify the clean-worktree policy, Git process limits, coordinator
behavior, dependencies, GitHub state, or release state.

## Sequence

1. Add integration tests for ordinary, rename or copy, unmerged, and untracked
   porcelain records.
   Also add malformed, long UTF-8, terminal-control, and nine-path cases.
2. Run the focused build-first test command and confirm the new tests fail on
   the old behavior.
3. Add `-z` and one internal parser in `src/runtime/git.ts`.
   Reject incomplete or malformed input as `GIT_STATUS_FAILED`.
   Attach only the first eight destination paths and an exact omitted count.
4. Carry that summary through `GitRuntimeError` only for a valid dirty
   snapshot.
   Keep index-flag and gitlink refusals unchanged.
5. Format each retained path in `src/commands/run.ts`.
   Escape terminal controls and use the existing field and write limits.
   Select this diagnostic before generic phase fallback.
6. Run focused tests, the complete `pnpm check` gate, and Trunk.

## Verification

Run the focused regression suite first.

```sh
pnpm build
node --test --test-concurrency=1 test/integration/git.test.mjs \
  test/integration/cli.test.mjs
```

Then run the full repository gates.

```sh
pnpm check
trunk check --all --no-fix
```

Inspect the changed paths and whitespace before delivery.

```sh
git diff --check
git status --short
```

## Delivery boundary

Do not stage, commit, push, close the issue, or open a pull request without a
separate operator request.
