# Architecture

One `run` invocation crosses every layer below, and no single file shows the whole path.
This document exists because reading `src/commands/run.ts` alone will not tell you where a failure came from.

## The shape of a run

```text
git preflight → runtime state + lock → bundle build → install → doctor gate
    → App Server session → bounded state and output → thread record
```

### 1. Git preflight

`src/runtime/git.ts` and `src/git/process.ts` resolve the repository root and snapshot `HEAD` plus `status --porcelain=v2`, then re-read `HEAD` afterwards to detect a race.
Git child processes run with a sanitized environment and each captured stream is bounded.

The worktree must be clean.
That is a support boundary, not an oversight: the agent's changes and pre-existing changes would otherwise be indistinguishable afterwards, and there is no rollback or diff-attribution design here to tell them apart.

### 2. Runtime state and lock

`src/runtime/paths.ts` canonicalizes the bundle source root and the managed state root, rejects any overlap between them, and derives `codexHome` as `<stateRoot>/codex-home`.
State directories must be owner-only `0700` ordinary directories, never symbolic links.

`src/runtime/lock.ts` takes a single process lock.
A stale publication lock is not auto-recovered.

### 3. Bundle build

`src/bundle/*` turns a Codex profile directory into a content-addressed artifact:

- `manifest.ts` parses `agent-bundle.toml`, which declares which files and hooks are bundled, which substitution tokens are allowed, and what is forbidden to appear in the output.
- `source-tree.ts` resolves only Git-tracked sources, so an untracked scratch file cannot enter a bundle.
- `render.ts` renders config and hooks with token substitution, and gates files, hooks, instruction sections, and `[[mcp_servers]]` tables on the enabled capability set.
- `validate.ts` scans the rendered bytes for secrets, credentials, forbidden literals, and leaked runtime identifiers.
- `artifact.ts` writes the artifact with a `bundle-metadata.json` digest inventory.

The digest covers the source revision, the manifest digest, the builder version, the requested and enabled capability sets, and every file's path, mode and bytes.
Two capability sets are therefore two different bundles.

### 4. Install

`src/bundle/install.ts` applies the artifact into `codex-home` through a journal with preimages, so an interrupted install is recoverable on the next run.

Each installed file carries a lifecycle class.
`config.toml` is `reset-before-run`; everything else is `immutable`.
That split exists because Codex rewrites the file it owns between runs, which the journal's preimage check assumes will not happen.
An immutable file that drifts blocks the run; a reset-before-run file is converged, and only if the active install owns it.

### 5. Doctor gate

`src/commands/doctor.ts` classifies findings as `blocker`, `warning`, or `ready`.
Any blocker aborts before the App Server starts.
It also spawns the real Codex against a shadow copy of the installed configuration to check that strict validation passes, which is the one check that cannot be answered from local state alone.
`SCHEMA_COMPATIBILITY` runs the resolved binary's two generator subcommands into a scratch root and compares the digest against `REQUIRED_CODEX_CONTRACT_DIGEST`, so a binary that reports the pinned version but generates a different contract is a blocker.

### 6. App Server session

`src/app-server/*` spawns `codex app-server` and speaks JSON-RPC over stdio:

- `transport.ts` frames newline-delimited JSON with a hard byte bound.
- `client.ts` exposes typed thread and turn calls against the generated contract, and constructs the child's environment explicitly rather than inheriting `process.env`.
- `coordinator.ts` drives the turn.
- `approvals.ts` answers approval requests, failing closed on anything unknown or malformed and whenever stdin is not a terminal.

### 7. Bounded state and output

`reducer.ts` caps item, command, and warning counts.
`renderer.ts` and `terminal.ts` escape every terminal control character before writing and bound each line in escaped bytes, so protocol content cannot forge terminal control sequences or flood the terminal.

### 8. Persistence

`src/runtime/thread-store.ts` writes the thread record that `resume` and `status` read back in a later process.
The record carries the capability set the thread was granted and a digest of the capability's data root, so a resume cannot widen what the original run was allowed to reach.

## Capabilities

A capability is an optional slice of the bundle: files, hooks, and instruction sections that are rendered only when it is enabled, plus external executables whose presence is asserted before it is.

`oracle` is the only capability in this version.
It is off by default, enabled per run with `--capability oracle`, and needs a user-supplied knowledge base whose location comes from the environment rather than the command line.

The capability set flows one way: the CLI parses it, `resolveRuntimePaths` resolves the root only when it was requested, the bundle records it, and the thread record binds it.
`resume` derives its set from the record rather than from a flag, so a flag can only agree.

## The generated contract

`src/generated/codex-app-server/**` and `schemas/codex-app-server/**` are owned by Codex's generators at the pinned version.
Never edit or format them by hand; regenerate instead.
A contract test regenerates both trees and compares them byte for byte.
