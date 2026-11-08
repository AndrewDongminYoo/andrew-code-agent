# Implementation plan: Refuse tracked symlinks in fix verification

Date: 2026-11-08
Status: implementation and local verification completed on 2026-11-08; PR delivery is tracked by the parent loop.

## Contract and ownership

Implement [the approved specification](../specs/2026-11-08-verify-fix-symlink-refusal.md) for [issue #141](https://github.com/AndrewDongminYoo/andrew-code-agent/issues/141).
Use the current workspace and proposed branch `fix/141-verify-fix-symlinks`; a separate worktree is unnecessary.
The root agent owns all edits, checks, staging, commits, and PR transitions.

| Path                                                  | Planned change                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/commands/verify-fix.ts`                          | Add a private HEAD-tree symlink preflight check.                              |
| `test/integration/verify-fix.test.mjs`                | Add real Git fixtures and subprocess-observation assertions.                  |
| `README.md`                                           | Describe the refusal in the existing `verify-fix` section.                    |
| `docs/specs/2026-10-29-verify-fix-command.md`         | Reconcile checkout and preparation behavior, and add an acceptance criterion. |
| `docs/specs/2026-11-08-verify-fix-symlink-refusal.md` | Record approval and any agreed contract refinement.                           |
| `docs/plans/2026-11-08-verify-fix-symlink-refusal.md` | Track implementation and validation evidence.                                 |

Keep `src/commands/review.ts`, `src/git/process.ts`, CLI interfaces, generated artifacts, dependency manifests, and Trunk configuration unchanged.
Reuse `executeGit`, `VerifyFixError`, and `preflightMessage` rather than adding a shared abstraction or exported test seam.

## Precedent considered

The personal Oracle returned the symlink incident documented in [the staged-review specification](../specs/2026-10-12-staged-review-command.md#reconciliation-2026-10-12-hosted-review-of-pr-86).
That record says a materialized absolute symlink allowed review to reach source-worktree content and that commit `973686d` introduced `core.symlinks=false` to close the gap.
This confirms the choice to preserve shared checkout isolation and reject unsupported verification inputs instead of enabling symlinks.
Oracle provenance was `dd6c39094cd04fe2af9cebcffff012147e9d9f17`; retrieval was partial because its default result set was truncated, and current-source freshness was unverified.
The cited incident was also read directly in this checkout; it supports the boundary but does not establish the new HEAD-only refusal contract.

## Step 1: Establish failing integration coverage

- [x] Extend the local fixture helper only as needed to commit actual symlinks at the base or HEAD stage.
- [x] Assert fixture tree entries have mode `120000` using Git, and verify the source worktree is clean before calling the command.
- [x] Add a regression fixture where a test imports a fixed module through a tracked relative symlink; run the test directly in the source fixture to establish that the fixed test is valid.
- [x] Add an unchanged nested symlink fixture, a multiple-link fixture, and a path with whitespace and a terminal control character.
- [x] Assert exit `3`, the first escaped symlink path, empty stdout, unchanged source state, and unchanged temporary-checkout inventory.
- [x] Use the existing `sandboxExecutable` dependency to supply a test-owned recording wrapper that records each invocation outside the source fixture and delegates to the real sandbox executable.
      On the same valid comparison without tracked symlinks, assert that the wrapper observes the probe and both runs and that verification succeeds.
      On the symlink comparison, assert that the invocation record remains empty.
      This observer proves the subprocess boundary was never reached; an absent marker from a sandbox-denied test write alone would not prove that the test never ran.
- [x] Exercise at least one refusal through `node dist/cli.js verify-fix -- ...` to confirm the public CLI propagates exit `3` and the diagnostic.
- [x] Run the focused build-first check and record the expected assertion failures before production edits:

```bash
pnpm build && node --test --test-concurrency=1 test/integration/verify-fix.test.mjs
```

The regression should fail because the current implementation starts verification instead of refusing the tracked symlink.
A build error, malformed fixture, unavailable sandbox, or unrelated failure does not count as the intended red result.

## Step 2: Add the command-local preflight

- [x] In the initial `verifyFixCommand` try block, after test/production nonempty checks and before `validateWithPaths`, call a private helper with `input.repositoryRoot` and captured `input.head`.
- [x] Read `git ls-tree -r -z --full-tree --format='%(objectmode)' <captured-head>` through `executeGit`.
      Do not use the moving `HEAD` ref, pathspec filters, filesystem traversal, or diff-only paths.
- [x] Parse NUL-delimited modes and find the first mode `120000`.
      Only when a symlink exists, read a second NUL-delimited `--name-only` listing of the same captured commit through `executeGitBytes` and select the path at that position after validating the entry count.
      Preserve valid UTF-8 text and encode all pathname bytes as `\xHH` escapes when UTF-8 validation fails.
      Reject incomplete or malformed records instead of treating them as safe; retain the existing Git output bound and preparation-error handling.
- [x] Throw `VerifyFixError` with the specified diagnostic on the first symlink.
      Let `preflightMessage` escape terminal controls once and the existing catch return `3`.
- [x] Preserve shared checkout construction, sandbox code, existing refusal precedence, and post-run identity rechecks.
- [x] Rerun the focused check and confirm the new refusal cases and existing command tests pass.

## Step 3: Reconcile current documentation

- [x] Update the README's `verify-fix` paragraph to explain the full HEAD-tree refusal, first path, exit `3`, and absence of test execution.
- [x] Update the original command specification's Checkouts, Verdict, and Acceptance criteria sections without rewriting historical sandbox measurements.
      Retain the explanation of shared plain-file materialization and make the HEAD-only limitation explicit.
- [x] Mark proposal approval only from an actual approval response, then record completed tasks and observed checks.

## Step 4: Verify and review

- [x] Run the focused command and shared-checkout regression tests:

```bash
pnpm build && node --test --test-concurrency=1 test/integration/verify-fix.test.mjs test/integration/review.test.mjs test/integration/staged-review.test.mjs
```

- [x] Run the declared integration script before the aggregate gate, then the complete repository checks:

```bash
pnpm test:integration
pnpm check
trunk check --all --no-fix
git diff --check
```

- [x] Read complete results and distinguish executed tests, skips, failures, and environment blockers.
      These gates exercise compiled implementation and repository regressions; they do not authorize code changes before plan approval.
- [x] Review the actual diff once for full-tree coverage, captured-commit identity, safe path parsing, zero subprocess launches, unchanged sandbox boundaries, and documentation agreement.
      Revalidate affected regressions after any repair.

## Step 5: Resume the authorized PR loop

- [ ] After approval, implementation, and local verification, prepare scoped Conventional Commits, push the task branch, and open a PR that closes #141.
- [ ] Follow the parent `pr-loop` for current-head CI, bounded hosted review, live PR-body correction, verified review assignment, gated merge, and settled follow-through.
- [x] Preserve the plan-approval gate in Git-local state while waiting.
      Implementation was approved and `pr-loop` resumed after the planning-only turn.

## Risks and verification limits

The intentionally conservative refusal also blocks tracked links unrelated to the requested test.
Inspecting only changed paths would miss unchanged links, and splitting tree output on whitespace would damage valid filenames; the fixtures target both mistakes.
HEAD-only detection does not solve merge-base-only symlinks restored into checkout A.
The existing macOS sandbox and APFS prerequisites remain necessary for the positive control and full integration suite.

## Execution evidence

On 2026-11-08, the focused build-first run before production edits passed the existing 24 tests and failed the three new regression tests.
The symlink-import fixture passed directly in the source tree but returned exit `1` from verification after both isolated runs failed.
The unchanged-link fixture reached `--with` validation instead of the symlink refusal, and the CLI fixture incorrectly completed verification.
The positive control observed the sandbox probe and both real test runs before the symlink fixture was introduced.

The focused command and shared-checkout regression run passed all 72 tests after the implementation.
The first full integration run passed 483 tests, skipped the opt-in live-manifest test, and failed the existing missing-sandbox test because its global temporary-directory inventory lost a directory between reads.
The same inventory assertion was reproduced using the original test and implementation from the base commit by creating and then removing a foreign directory between its two reads; the baseline control without that interference passed.
Subsequent full local gates use a dedicated temporary directory to exclude concurrent test inventories without changing the product or unrelated tests.

With the dedicated temporary directory, `pnpm test:integration` passed 484 tests and skipped one opt-in live-manifest test.
`pnpm check` then passed typechecking and all four layers: unit 162 passed; integration 484 passed and 1 skipped; contract 96 passed and 2 skipped; E2E 15 passed and 8 skipped.
The 11 skips require optional live-manifest, pinned-Codex, real-smoke, or Oracle-vault inputs and do not cover this command, which never runs Codex.
`trunk check --all --no-fix` checked 1,241 files with no issues.
One structured local review covered all six changed files and found no blocking findings; the shared checkout, sandbox policy, and public interfaces are unchanged.

Hosted review identified that the default tree format adds one byte per ordinary entry compared with the existing index listing and can exceed the 16 MiB output bound first.
A real clean repository fixture keeps its index listing below that bound while its default tree listing exceeds it; the new regression failed before the correction.
The preflight now requests only modes, then names only when a symlink exists, retaining the output bound without narrowing the existing index reader's supported range.
Separate listings avoid Git's custom `%(path)` format, which quotes control characters even with `-z`; the existing control-character regression caught that behavior during the correction.
The second hosted finding identified replacement characters in diagnostics for non-UTF-8 Git pathnames.
A raw Git-tree fixture reproduced that loss before the byte-preserving correction.
Because APFS cannot materialize the invalid name, this fixture overrides only the worktree-status read while commit, index, and tree reads use real Git data; it verifies diagnostic encoding rather than claiming an end-to-end network-filesystem test.
After both corrections, all 29 focused command tests passed, `pnpm check` passed typechecking and 759 tests with the same 11 opt-in skips, and Trunk reported no issues.
