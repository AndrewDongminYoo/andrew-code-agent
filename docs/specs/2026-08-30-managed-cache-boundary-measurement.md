# Specification: Managed cache-boundary measurement

Date: 2026-08-30
Status: approved test-only scope for GitHub issue #23

## Goal

Measure the real App Server behavior for a synthetic cache root outside the
target repository and process temporary directory.

Do not change the production writable-root policy before the measurement
returns evidence.

## Scope

The opt-in acceptance test installs the portable configuration into a
disposable managed home.

The test starts a real managed turn through the product coordinator.

The test creates only owner-controlled synthetic roots under `/Users/Shared`.

The test writes no real Flutter, Cargo, pnpm, Ruby, or Pub cache.

The test uses `ANDREW_AGENT_CACHE_BOUNDARY_SMOKE=1`,
`ANDREW_AGENT_SMOKE_CODEX_BIN`, and `ANDREW_AGENT_SMOKE_AUTH`.

The test copies the authentication file into the disposable managed home.

The test does not read, hash, log, or persist the authentication file.

## Measurement contract

The helper attempts writes to five named locations.

- `repository` is inside the disposable target repository.
- `temporary` is inside the disposable process temporary fixture.
- `cache` is an explicitly separate synthetic cache root.
- `home` is a separate synthetic home root.
- `sibling` is an undeclared sibling root.

The current policy grants only the target repository as an explicit writable root.

The current-policy run must write `repository` and `temporary`.

The current-policy run must block `cache`, `home`, and `sibling`.

The narrow-candidate run adds only the canonical `cache` root to the turn request.

The narrow-candidate run must write `repository`, `temporary`, and `cache`.

The narrow-candidate run must block `home` and `sibling`.

Both runs keep network access disabled.

## Evidence contract

The helper writes a logical receipt that contains only root role names and
`written` or `blocked` results.

The product coordinator persists the real managed-turn record.

The test requires a completed terminal status, the expected receipt, and
filesystem canaries.

The test fails if the helper does not run.

The test fails if a policy grants an unexpected root.

The test fails if the synthetic absolute root appears in the persisted record
or command output.

## Non-goals

This test does not grant a real toolchain cache.

This test does not add a CLI option, manifest field, environment variable, or
production cache-root allowance.

This test does not select the per-run allowance, pre-warm, or
unsupported-toolchain policy.

This test does not change the README until a real measurement supports a
verified boundary claim.

## Consultation record

Oracle requires the real managed session record and command result as evidence.

Oracle requires a deliberate denied-root control before a passing result can
support a policy decision.

Oracle found `[no precedent found]` for the production cache-root policy choice.

Advisor limited the implementation to one opt-in acceptance test and a
test-only narrow candidate.

Advisor required the production coordinator to keep its current writable-root policy.
