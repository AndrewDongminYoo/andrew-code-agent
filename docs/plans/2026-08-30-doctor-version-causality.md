# Doctor version-causality plan

Date: 2026-08-30 Issue: GitHub #39

## Goal

Make the Doctor report a wrong Codex version as one causal blocker.
Keep skipped schema and strict-config checks visible as warnings.

## Scope

- Modify `src/commands/doctor.ts` at the version and strict-config decision
  boundary.
- Add Doctor integration coverage for the causal path.
- Add CLI integration coverage for blocker aggregation.

Do not change #38 strict-config failure classification or test timeout policy.

## Sequence

1. Add a wrong-version fixture whose strict-config command would fail if it ran.
   Assert only `CODEX_VERSION` blocks, downstream findings warn, and strict spawn count stays zero.
2. Add a CLI readiness fixture with those findings.
   Assert the diagnostic contains only the causal blocker.
3. Run the focused build-first command and confirm the new assertions fail.
4. Change the existing decision boundary to return nonblocking not-evaluated
   findings only for a safe normal wrong-version result.
5. Keep the existing supported-version strict-config failure test unchanged.
6. Keep malformed, unsafe, and unavailable version probes fail-closed.
7. Run focused tests, then the repository gates when host load permits.

## Verification

```sh
pnpm build
node --test --test-concurrency=1 test/integration/doctor.test.mjs \
  test/integration/cli.test.mjs
```

```sh
pnpm check
trunk check --all --no-fix
```

## Delivery boundary

Do not stage, commit, push, close the issue, or open a pull request without a separate operator request.
