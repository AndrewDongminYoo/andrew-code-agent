# Specification: Safe strict-config diagnostics

Date: 2026-08-30
Status: approved implementation scope for GitHub issue #38

## Goal

Preserve the `STRICT_CONFIG` blocker while adding a safe location for one
observed parse failure.

## Decision

Only a bounded nonzero strict-config result may produce a detailed finding.
The parser reads only stderr and accepts exactly one complete line in this
form:

```text
config.toml:<positive line>:<positive column>: duplicate key
```

Line and column use at most six ASCII decimal digits.
The emitted message contains only the fixed basename, parsed coordinates, and
the fixed `duplicate key` class.

All other outcomes retain the existing generic blocker.
This includes unrecognized text, an incorrect basename, invalid or overlong
coordinates, control text, more than one matching line, timeout, output cap,
residual descendants, and process cleanup failure.

The parser never returns child stdout, child stderr, a source line, a
configuration value, an absolute path, or exception text.

## Behavior

For a safe match, Doctor reports `STRICT_CONFIG` as a blocker.
Its message uses the fixed failure prefix, `config.toml:63:11`, and
`(duplicate key)` on one terminal line.

The exit code, severity, code, and remediation stay unchanged.
The wrong-version path from #39 does not invoke this parser.

## Acceptance criteria

1. A synthetic duplicate-key result reports only the safe basename, positive
   line, positive column, and fixed class.
2. Adjacent secret canaries in child output do not reach findings.
3. Malformed, unknown, ambiguous, hostile, and overlong diagnostic fields use
   the generic blocker.
4. Timeout, output-overflow, descendant, and cleanup safety failures use the
   generic blocker even when output contains a matching line.
5. The canary assertion is deliberately made to fail once before its passing
   result is accepted.

## Scope

Modify `src/commands/doctor.ts` and `test/integration/doctor.test.mjs`.
Do not change `runBoundedChild`, the strict-config invocation, output limits,
the CLI renderer, schemas, dependencies, generated artifacts, GitHub state,
or releases.

## Consultation record

Oracle found one observed duplicate-key shape at
`docs/notes/2026-08-24-dogfooding-second-run.md`.
It found no stable producer grammar, stream contract, or additional class
allowlist.
The parser therefore uses only that exact shape and falls back safely for
everything else.

Advisor required a local pure helper beside `classifyStrictConfig`, unsafe
result flags before parsing, and generic fallback for ambiguous matches.
