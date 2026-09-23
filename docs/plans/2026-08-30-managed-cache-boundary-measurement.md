# Managed cache-boundary measurement plan

Date: 2026-08-30 Issue: GitHub #23

## Goal

Create an opt-in real App Server measurement that distinguishes the current writable-root policy from one narrow synthetic-cache candidate.

## Scope

- Add one live acceptance test in `test/e2e/acceptance.test.mjs`.
- Use two disposable fixture runs.
- Keep the production coordinator, README, generated schema, and runtime path
  policy unchanged.

## Sequence

1. Add a synthetic helper to the disposable target repository.
2. Create separate synthetic `cache`, `home`, and `sibling` roots under `/Users/Shared`.
3. Run the helper with the unchanged coordinator policy.
4. Confirm the repository and temporary writes succeed.
5. Confirm the cache, home, and sibling writes are blocked.
6. Run the helper with only the synthetic cache root added by the test
   wrapper.
7. Confirm the cache write succeeds.
8. Confirm the synthetic home and sibling writes remain blocked.
9. Confirm the record and captured output contain no synthetic absolute
   root.
10. Record the result before selecting a production policy.

## Verification

Run the skipped-path syntax and build check without credentials.

```sh
node --check test/e2e/acceptance.test.mjs
pnpm build
node --test --test-concurrency=1 \
  --test-name-pattern='synthetic cache roots' \
  test/e2e/acceptance.test.mjs
```

Run the real measurement only with the dedicated opt-in environment.

```sh
ANDREW_AGENT_CACHE_BOUNDARY_SMOKE=1 \
ANDREW_AGENT_SMOKE_CODEX_BIN=/absolute/path/to/codex \
ANDREW_AGENT_SMOKE_AUTH=/absolute/path/to/test-auth.json \
node --test --test-concurrency=1 \
  --test-name-pattern='synthetic cache roots' \
  test/e2e/acceptance.test.mjs
```

Run the full repository gates after the implementation is complete.

```sh
pnpm check
trunk check --all --no-fix
```

## Delivery boundary

Do not select a production cache policy from the skipped test path.

Do not change the README from synthetic-cache assumptions.

Do not close GitHub issue #23 until a real run returns the required evidence and a policy is selected.
