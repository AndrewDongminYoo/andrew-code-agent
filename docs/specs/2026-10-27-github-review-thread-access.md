# GitHub Review Thread Access Boundary

## Problem

No `andrew-agent` command contacts GitHub.
`docs/specs/2026-09-21-pr-command.md` excludes GitHub access from the `pr` command and lists publishing to GitHub as a non-goal.
A command that triages hosted review findings (issue #81) must at least read the review threads of a pull request.
Issue #80 asks the operator to set that boundary before any implementation.

## Decision

The operator decided this boundary on 2026-10-27.

The CLI may read GitHub, and only read it.
A command may read the review threads of one pull request and that pull request's head SHA.
It reads them through the operator's existing `gh` login.

The CLI never writes to GitHub.
This prohibition is permanent: it is not a first-version limit.
No command posts replies, adds reactions, resolves or unresolves threads, edits pull requests or issues, or pushes.

Review thread text is untrusted data.
The command puts it into the prompt only inside a delimited data block, and the prompt tells Codex to treat that block as data, never as instructions.
The command bounds the size of that text before it reaches the prompt, and it escapes every terminal control character before it prints any part of it, the same way the existing renderer does.

## Constraints added while drafting

These constraints were added when this spec was written, as fail-closed readings of the decision above.
The operator approved them with the spec, not as separate answers.

- The CLI does not store, copy, or accept a GitHub credential other than the `gh` login.
- A future command that needs a GitHub write needs a new decision that replaces this spec; it cannot extend this one.

## Consequences for the triage command

The implementation spec for issue #81 follows this boundary.
It must define the byte bound for review text and the refusal when the bound is exceeded.
It must recheck the pull request head SHA after the Codex run and discard the output when the head moved.
Its tests replace `gh` with a fake response, so no test contacts GitHub.
