# Security

## Support status

This is an experimental personal project published as a reference implementation.
**There is no support guarantee and no security SLA.**
It targets macOS and one exact Codex version, and it is not intended to be run unattended or against repositories you do not control.

## Reporting

Report suspected vulnerabilities privately through GitHub's [security advisory](https://github.com/AndrewDongminYoo/andrew-code-agent/security/advisories/new) form rather than a public issue.
Expect a best-effort reply; there is no committed response window.

## What this project already refuses to do

These are deliberate boundaries rather than gaps, and a change that removes one widens the product contract.
They are the properties most worth reporting a break in:

- The target repository must be a clean worktree, and the bundle source tree must be clean with every bundled file Git-tracked.
- Submodules and gitlinks are rejected wherever mode `160000` appears.
- Git child processes run with a sanitized environment, and each captured stream is bounded at 16 MiB.
- JSONL protocol lines are bounded at 16 MiB of UTF-8 wire bytes.
- Every rendered and printed string is escaped and byte-bounded before it reaches a terminal, so protocol content cannot forge terminal control sequences.
- Approvals fail closed on any unknown or malformed request, and when stdin is not a terminal.
- An installed file that drifts blocks the run rather than being silently reconciled.
- Rendered bytes are scanned for secrets, credentials, and leaked runtime identifiers before an artifact is written.
- A stale publication lock is not auto-recovered.

## What is out of scope

- The Codex CLI itself and anything it does once running.
  Report those upstream.
- Any behaviour under a modified `agent-bundle.toml` that disables the scans above; the manifest is trusted input supplied by the user.
- Running against a Codex version other than the pinned one.
  The version gate refuses it, and bypassing that gate is unsupported.
