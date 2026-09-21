# PR Body Command

## Problem

The CLI can create a staged commit and review committed branch changes, but it
cannot turn the same exact branch comparison into a pull-request body.
Writing that body by hand can drift from the committed diff or claim validation
that did not run.

## Command contract

`andrew-agent pr [base]` drafts one English Markdown pull-request body and
writes it to standard output.
With no argument, it resolves the symbolic `origin/HEAD` remote-tracking ref.
One positional ref selects another base.

The command requires a named current branch and a clean worktree.
It resolves exact HEAD, base, and merge-base commits and uses their committed
three-dot comparison.
It reads changed paths, commit subjects, and diff statistics from that comparison.
An empty comparison exits successfully without invoking Codex.

The command runs `git diff --check <base>...<head> --` itself.
A successful check is the only project-validation result that the first version
supplies to the draft.
The draft must state that project-specific tests and quality gates were not run
by `andrew-agent pr`.
It must not reconstruct validation claims from package scripts, workflow
declarations, commit messages, or repository documentation.

Codex inspects a temporary standalone repository that contains the exact
committed comparison and no source-worktree dirt.
The invocation uses the managed login, an ephemeral read-only sandbox, and
disabled user configuration.
The prompt treats repository content and comparison metadata as untrusted data.

The returned body must be at most 64 KiB of UTF-8, contain no terminal control
characters, and include these headings exactly once:

- `## Summary`
- `## Verification`

The body must not include an outer Markdown fence or unsupported test claims.
After Codex finishes, the command rechecks the current HEAD, branch ref, base
commit, and worktree cleanliness.
If any reviewed input changed, it discards the draft and asks the operator to
rerun the command.

## Output and failure behavior

Successful output contains only the Markdown body so it can be redirected to a
file or passed to another command.
The command does not create a file, commit, push, open or update a pull request,
or contact GitHub.

- Exit `0` means the body completed or the comparison contained no changes.
- Exit `1` means Codex generation or terminal output failed.
- Exit `2` means command usage was invalid.
- Exit `3` means repository, comparison, diff-check, or runtime preparation failed.

Temporary-checkout cleanup warnings remain redacted and do not replace a
successful body or the primary generation failure.
An operator interrupt terminates the Codex process group and attempts checkout
cleanup before returning a failure.

## Non-goals

The first version does not run arbitrary repository checks, infer CI status,
read prior terminal logs, accept free-form validation claims, generate a PR
title, or publish to GitHub.
Supplying independently captured local, CI, integration, or runtime evidence is
a later feature with a separate provenance contract.

## Acceptance criteria

1. Default and explicit base refs resolve to exact commits for a committed
   three-dot comparison.
2. Dirty worktrees and detached HEADs are rejected before model invocation.
3. The command runs exact-comparison `git diff --check` and refuses a failing result.
4. Codex receives only the isolated committed comparison plus explicit passed
   and unrun verification facts.
5. The body contains one Summary section and one Verification section, stays
   within 64 KiB, and contains no forbidden controls or outer fence.
6. Empty comparisons do not invoke Codex.
7. A changed HEAD, branch ref, base commit, or worktree prevents stale output
   from being reported.
8. Cleanup and interruption preserve the primary outcome and remove the
   isolated checkout when possible.
9. CLI grammar, README, focused integration tests, `pnpm check`, and the Trunk
   gate cover the command.

## Consultation record

The project-scoped Oracle search found no indexed precedent for PR-body
structure or diff-to-body generation.
Validation precedent requires successful command exits to remain distinct from
evidence that all expected layers executed.
It also requires local, CI, integration, and runtime evidence to stay separately
labeled and treats captured runs as stronger than reconstructed claims.
This precedent keeps the first version limited to the host-observed
`git diff --check` result and an explicit statement that other validation did
not run.

Sources at Oracle revision `c1681868ac634e4b2414874716bb75a7864113c4`:

- `wiki/sources/claude--projects---users-dongminyu-development-01-personal-andrew-code-agent--memory--acceptance-verification-dead-ends.md`
- `raw/sources/.claude/projects/-Users-dongminyu-Development-01-personal-andrew-code-agent/memory/acceptance-verification-dead-ends.md`
- `wiki/concepts/authoring-time-vs-runtime-verification.md`
- `wiki/concepts/exact-trigger-verification.md`
- `wiki/concepts/deployment-interpreter-verification.md`
- `raw/sources/.claude/rules/verify-in-deployment-interpreter.md`
