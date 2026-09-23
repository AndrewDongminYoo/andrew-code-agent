# Specification: Oracle output safety boundary

Date: 2026-08-28 Status: accepted and verified for issue #25

## Decision

Prevent sensitive Oracle content at the retrieval boundary before the model receives it.
Do not add a heuristic scanner to `renderTurnState`.

The current CLI gives the App Server an Oracle root, receives ordinary `agentMessage` and `plan` text, and writes rendered lines to stdout.
Those messages carry neither source provenance nor sensitivity metadata.
A renderer-side scanner would therefore need to crawl the Oracle root and derive a secret dictionary, or guess from output text.
The first option expands this product's access to data it does not otherwise read, while the second creates both false positives and undetected paraphrases.
Neither is an acceptable baseline.

The Oracle retrieval provider must classify a source page before returning any part of it.
A page marked `sensitive: true` is not returned to the model, even when the query names that page directly.
An unreadable or malformed sensitivity declaration fails the retrieval before source content is returned.
Pages with no sensitivity declaration keep their current public behavior.

This is a new project decision.
The project-scoped Oracle query for renderer scanning versus retrieval filtering and for a fail-closed synthetic fixture returned `[no precedent found]` at source commit `13e0e5eabaef07ad77d6ef24adb7b97865bac712`.

## Current boundary

`src/bundle/validate.ts` protects files written into the managed Codex home.
It does not inspect App Server output.

`src/app-server/reducer.ts` retains bounded text for `agentMessage` and `plan` items.
`src/commands/run.ts` passes each turn state to `renderTurnState` and writes every new rendered line to stdout.
At that point the source page and its metadata are no longer identifiable.

The output gate described in issue #25 is therefore not implementable from the current `TurnState` contract without adding a new trusted policy input.
Until such an input exists, the renderer remains a terminal-control and size boundary, not a content-classification boundary.

## Retrieval result contract

The Oracle provider must apply these rules before it returns a tool result:

1. Parse the selected page's metadata before reading or emitting its body.
2. Return no title, path, excerpt, summary, or body content from a page marked
   `sensitive: true`.
3. For a direct request that resolves only to restricted pages, return a stable
   restricted-result status without identifying those pages.
4. For a mixed query, return eligible results and a count of omitted restricted
   results without identifying them.
5. If metadata cannot be parsed or the provider cannot prove that the selected
   result is eligible, fail the retrieval before returning source content.

The stable status and omitted count let the agent explain an incomplete retrieval without silently truncating its final answer.
They do not disclose which restricted source matched.

## False-positive policy

Classification uses only the structured `sensitive: true` declaration.
It does not use keywords, regular expressions, secret detectors, page titles, or guesses about prose.

A page without `sensitive: true` is eligible even if its body contains words such as `secret`, `private`, or `employment`.
A page with `sensitive: true` is restricted even if its body looks harmless.
This makes classification deterministic and keeps false-positive behavior testable.

Fail-closed behavior applies to one retrieval operation, not the whole terminal session.
A restricted-only retrieval returns the stable restricted status.
A mixed retrieval may still return eligible sources.
A metadata or provider failure returns no source content for that operation.

## Synthetic fixture

Tests must use a temporary synthetic Oracle root and must not read the operator's live wiki.
The fixture contains these tracked inputs:

- One eligible page with the literal `PUBLIC_ORACLE_CANARY_7A42` and no
  sensitivity declaration.
- One restricted page with `sensitive: true` and the literal
  `SENSITIVE_ORACLE_CANARY_9C31`.
- One eligible false-positive page containing the words `secret`, `private`,
  and `employment`.
- One restricted false-negative page whose body contains only ordinary prose.
- One page with malformed sensitivity metadata.

The literals are synthetic identifiers, not examples copied from private data.

## Acceptance checks

The implementation is complete only when the following checks exercise the real retrieval adapter used by an Oracle-enabled run:

1. A direct request for the restricted page returns the stable restricted
   status and no restricted title, path, or canary.
2. A broad search returns the eligible canary, omits the restricted canary, and
   reports one omitted restricted result.
3. The eligible false-positive page remains retrievable.
4. The restricted false-negative page remains blocked.
5. Malformed metadata returns no page content and a stable failure status.
6. Captured tool results and terminal output contain no
   `SENSITIVE_ORACLE_CANARY_9C31`.
7. The test is proven non-vacuous by disabling the retrieval filter once and
   observing the canary assertion fail before restoring the filter.

The terminal assertion is defense evidence for the end-to-end path.
The retrieval assertion is the property that establishes prevention, because a clean terminal alone could mean that the fixture never reached the model.

## Implementation ownership and sequence

The provider that reads Oracle pages owns classification and the typed retrieval result.
This repository owns forwarding the explicitly enabled Oracle root and may own an end-to-end harness once that provider exposes a testable contract.
It must not implement policy by recursively reading the Oracle root inside the CLI.

Implementation proceeds in this order:

1. Define the provider's restricted-result and metadata-error response shapes.
2. Add the synthetic provider fixture and make the sensitive-canary assertion
   fail against the unfiltered provider.
3. Enforce classification before body retrieval and make the provider checks
   pass.
4. Add an Oracle-enabled CLI integration case that captures tool results and
   stdout.
5. Re-run the fixture with the filter deliberately disabled and confirm the
   terminal assertion fails.

Issue #25 closed after the real retrieval provider and the end-to-end CLI path satisfied these checks.
A renderer-side exact-literal defense may be considered later only if a trusted capability contract supplies those literals without requiring this CLI to discover sensitive content itself.

## Status

2026-09-05: The synthetic-vault CLI gate passed against Oracle provider commit `354e7d0853389c15f69af10090e557ddd4caa95b`.
The filtered run reported one omitted restricted result and exposed no restricted canary in its tool results or stdout.
The filter-disabled twin exposed the same canary in both surfaces.
`omittedRestrictedCount` is tag-scoped, as defined in `docs/plans/2026-09-03-oracle-restricted-results.md` in the `llm-wiki-dongminyu` repository.
See `docs/notes/2026-09-05-oracle-boundary-gate-run.md` for the run evidence.
