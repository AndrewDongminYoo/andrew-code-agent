# Specification: Doctor version-causality diagnostics

Date: 2026-08-30 Status: approved implementation scope for GitHub issue #39

## Goal

Report an unsupported Codex version as the one actionable Doctor blocker.
Keep downstream checks visible without falsely calling them failures.

## Decision

When a safe Codex version probe reports a different normal version, `CODEX_VERSION` remains a blocker.
`SCHEMA_COMPATIBILITY` and `STRICT_CONFIG` remain in their existing report order as warnings.
Their messages state that the checks were not evaluated because the pinned version was unavailable.

The Doctor must not run a schema or strict-config probe under the wrong binary.
The existing strict-config classifier remains unchanged for a supported version.
Malformed, unsafe, or unavailable version probes retain existing fail-closed blockers.

## Behavior

The wrong-version path returns a nonzero Doctor exit because `CODEX_VERSION` is a blocker.
It must not add downstream checks to the blocker set.

The `run` and prompted `resume` readiness diagnostic derives its list from blocker-severity findings.
It therefore reports only `CODEX_VERSION` for this condition.

An independently failing strict-config check under the supported version keeps its existing `STRICT_CONFIG` blocker.

## Acceptance criteria

1. An exact wrong-version fixture produces one blocker: `CODEX_VERSION`.
2. `SCHEMA_COMPATIBILITY` and `STRICT_CONFIG` are warnings with an explicit
   not-evaluated message.
3. The strict-config process does not start in the wrong-version fixture.
4. The CLI readiness diagnostic names only `CODEX_VERSION` for that fixture.
5. A supported-version strict-config failure still blocks with `STRICT_CONFIG`.

## Scope

Modify `src/commands/doctor.ts`, `test/integration/doctor.test.mjs`, and `test/integration/cli.test.mjs`.
Do not change strict-config error classification, timeout policy, schemas, dependencies, generated artifacts, GitHub state, or releases.

## Consultation record

Oracle confirmed that the pinned Codex version is a prerequisite for schema and strict-config evaluation.
It also confirmed that an unobserved property must not be reported as passing or failing.
Advisor required the guard before downstream work is scheduled, not a later filter of already-created blockers.

The existing `warning` severity is the selected nonblocking representation.
No Oracle precedent defines the exact severity label or message wording.
