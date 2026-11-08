# Specification: Refuse tracked symlinks in fix verification

Date: 2026-11-08
Status: approved on 2026-11-08 through the `pr-loop` plan gate.

## Problem and sources

`verify-fix` uses `createReviewCheckout`, which sets `core.symlinks=false` and materializes tracked symlinks as files containing their targets.
A valid test that imports through a symlink can consequently fail in both checkouts, producing an exit `1` verdict for an unsupported tree.
The command should identify this preparation limitation before it starts either test run.

The primary sources are [issue #141](https://github.com/AndrewDongminYoo/andrew-code-agent/issues/141), the [existing command specification](2026-10-29-verify-fix-command.md), and [the command implementation](../../src/commands/verify-fix.ts).
The proposal was prepared against commit `b322fa7ba357105ad7c04785b8d6b7586d00f885`.

## Proposed behavior

After resolving a valid comparison and confirming that both changed test and production paths exist, inspect the complete tree of the captured HEAD commit.
Read the committed tree rather than the source filesystem, index alone, or changed-path list.
An entry with Git mode `120000` is a tracked symlink, regardless of whether its target is internal, external, missing, or a directory.
An unchanged tracked symlink is sufficient to refuse the comparison.

If any such entry exists, exit `3` before validating or copying `--with` paths, constructing either temporary checkout, probing the sandbox, or launching either test run.
Write one diagnostic to stderr and leave stdout empty:

```plaintext
verify-fix does not support tracked symlinks in HEAD: <path>.
```

`<path>` is the repository-relative path of the first symlink in the recursive Git tree listing.
Preserve embedded whitespace during parsing and escape terminal control characters with the existing diagnostic formatter.
If a pathname is not valid UTF-8, represent all its bytes as `\xHH` escapes instead of replacing invalid bytes.
Do not resolve or follow the link target.
A failed or incomplete tree read is a preparation failure with exit `3`; it must never be interpreted as a symlink-free tree.

A HEAD tree without tracked symlinks continues through the existing verification flow.
Existing repository, comparison, and empty-classification refusals retain precedence.
Source refs, index, and worktree remain unchanged.

## Scope and constraints

This change adds one command-local preflight check and integration coverage, and updates the README and existing command specification when implementation is approved.
The shared checkout implementation retains `core.symlinks=false`; `review`, `review --staged`, sandbox restrictions, `--with` behavior, CLI grammar, and public interfaces are unchanged.
No dependency, generated schema, runtime configuration, or publication change is needed.
This proposal adds durable repository documentation for contributors without adding startup instructions.

The HEAD-only baseline deliberately does not inspect symlinks present only in the merge base and restored into checkout A.
Such comparisons can still encounter the existing plain-file limitation; this proposal does not claim complete symlink support or detection across both constructed trees.
Preserving internal symlinks, inspecting link targets, recursively inspecting submodules, and expanding the refusal to merge-base-only links require a separate direction decision.
Untracked or ignored symlinks, including those inside a `--with` dependency directory, do not independently trigger this HEAD-tree refusal and remain subject to existing validation and sandbox rules.

## Acceptance criteria

1. A clean, named branch with a valid test/production comparison and a tracked symlink in HEAD exits `3`, names that path, and emits no verification verdict.
2. An unchanged nested symlink present in both the merge base and HEAD also triggers refusal, proving that the check covers the whole HEAD tree.
3. Multiple symlinks produce the first path in recursive Git listing order, and whitespace or terminal controls in a path do not corrupt parsing or terminal output.
4. Independent subprocess observation proves that neither the sandbox probe nor either test run starts for a refused tree; an equivalent fixture without a tracked symlink proves that the observer detects launches.
5. The refusal leaves the source HEAD, index, worktree, and temporary-checkout inventory unchanged.
6. Existing successful verification, failure verdicts, untracked `--with` symlink handling, and review checkout behavior continue to pass their regression tests.
7. The README and original command specification describe the HEAD-tree refusal, its exit code, its timing, and the diagnostic path.
8. Focused integration tests, `pnpm check`, and `trunk check --all --no-fix` pass after implementation, or any environment blocker is reported without claiming a pass.

## Approval boundary

This document and its [implementation plan](../plans/2026-11-08-verify-fix-symlink-refusal.md) were approved on 2026-11-08 before production code or test changes began.
The change is a CLI preparation refusal and needs no visual-result approval.
