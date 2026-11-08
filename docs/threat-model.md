# Threat model

What this project defends against, what it does not, and why each boundary sits where it does.
A change that removes one of these widens the product contract rather than tidying it.

## What is trusted

- **The user.** They choose the target repository, the prompt, and the bundle source.
- **`agent-bundle.toml` and the profile it names.** The manifest declares what is forbidden in rendered output, so a manifest that declares nothing forbids nothing.
  It is user-authored input, not adversarial input.
- **The pinned Codex binary**, once its version is verified.

## What is not trusted

- **Everything the model produces**, including message text, command output, file paths, and diffs.
- **Everything that arrives over the App Server protocol**, including well-formed messages of unbounded size.
- **The state left on disk between runs**, including by the previous run.

## Boundaries

### Terminal output is the primary injection surface

Anything the model emits reaches a terminal, and a terminal interprets control sequences.
A crafted message could otherwise repaint the screen, forge this tool's own diagnostics, hide text with cursor movement, or reverse text direction with bidi overrides.

Every rendered string is escaped before it is written: C0 and C1 controls, format characters, and line and paragraph separators all become visible escapes rather than reaching the terminal.
Each line is bounded in **escaped** bytes, because escaping expands.

The known cost is readability.
A newline currently renders as a visible escape rather than breaking the line.
Fixing that means splitting on newlines structurally before escaping, never exempting `\n` from the escape set, which would reopen the surface for every other control character beside it.

### Protocol framing is bounded before parsing

JSONL lines are bounded at 16 MiB of UTF-8 wire bytes and rejected past it.
This is a resource policy, not a schema maximum: the generated contract has no opinion on line length, and an unbounded reader is a memory exhaustion primitive reachable by anything that can write to the child's stdout.

### Approvals fail closed

An approval request that is unknown, malformed, or arrives when stdin is not a terminal is denied.
There is no timeout-to-approve and no default-yes.
The failure mode of a wrong denial is a stalled turn; the failure mode of a wrong approval is an executed command.

### The child's environment is constructed, not inherited

`codex app-server` is spawned with an explicitly built environment — the managed `CODEX_HOME`, a `PATH`, and a capability's data root when one is enabled — never a copy of `process.env`.
An inherited environment would hand the child every credential and token in the parent's session.

### Bundled content is scanned before it is written

Rendered bytes are checked for secret patterns, credential-shaped assignments, forbidden path segments, unresolved substitution tokens, and forbidden literals — including the capability data root of the run in progress, which the manifest cannot know in advance.

### Installed state is verified, not assumed

An immutable installed file that drifts blocks the run.
Only the one file Codex owns is reconciled, and only when the active install record says this tool installed it.
An install is journaled with preimages so an interruption is recoverable rather than leaving a half-applied tree.

### A resumed thread cannot be widened

The thread record stores the capability set granted and a digest of that capability's data root.
`resume` derives the boundary from the record; a `--capability` flag can only agree with it.
A root that has moved since is refused, and the refusal names neither the old nor the new path.

## Explicit non-goals

- **Sandboxing the model's own actions.** Codex's sandbox and approval policy do that.
  This project chooses the policy and answers the prompts; it does not contain the process.
- **Protecting against a hostile user.** Anyone who can edit the manifest can disable the scans.
- **Multi-tenant isolation.** One user, one machine, one lock.
- **Running against an unpinned Codex.** The version gate refuses it because the generated contract is only known to match one version.
- **Secrecy of the target repository's contents.** The agent reads the repository; that is the point.

## Known residual risks

- The clean-worktree requirement is the only thing separating the agent's changes from pre-existing ones.
  There is no diff attribution.
- The strict-config check spawns the real Codex and reads its exit code alone, so a malformed managed configuration is reported without the line, column, or reason the child printed.
- A capability's external requirements are checked for presence and executability before the capability is enabled, not for behaviour.
  A requirement that exists and misbehaves is not caught here.
