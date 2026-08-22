# andrew-code-agent

A private, macOS-only command line agent that runs Codex against one Git
repository at a time, through a portable configuration bundle built from your
own Codex profile.

It is deliberately small. It does not run unattended, it refuses to act on a
repository that is not clean, and it declines any action it cannot get an
explicit answer for. The boundaries are listed in full under
[v0.1 limitations](#v01-limitations).

## Requirements

- macOS. The runtime refuses every other platform.
- Node.js 24.19.0 and pnpm 11.22.0.
- Codex `0.148.0` exactly. A different version is a Doctor blocker and fails
  before the App Server starts.
- A Git worktree to act on, and a clean Git worktree to build the bundle from.

## Install

The package is private and is never published. Build it from a checkout:

```bash
git clone https://github.com/AndrewDongminYoo/andrew-code-agent.git
cd andrew-code-agent
pnpm install --frozen-lockfile
pnpm build
```

Then put a wrapper on your PATH. A wrapper keeps working across clean builds,
which a symlink to `dist/cli.js` does not:

```bash
target=~/.local/bin/andrew-agent
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$PWD" > "$target"
chmod +x "$target"
andrew-agent --help
```

## Bundle configuration

Every run builds a portable bundle from a source root and installs it into a
managed Codex home. The source root must be a Git worktree root, must be
clean, and every file the bundle names must be tracked.

The bundle is described by `agent-bundle.toml` at the source root. It names
the config file and the exact config keys to carry over, the files to install
and their modes, the hooks to enable, the optional capabilities, the external
requirements to check, and the literals, path segments, and secret patterns
that must never appear in a rendered file.

Anything not named in that manifest is not carried into the managed home.
Sessions, logs, caches, and authentication material stay where they are.

## First run

```bash
andrew-agent doctor
```

On a machine with nothing installed yet, Doctor reports
`blocker ACTIVE_INSTALL` and exits 1. That is expected: it means the source,
manifest, and Codex version are already fine and no candidate has been
installed. The first `run` installs one.

```bash
andrew-agent run /path/to/repository "describe the change you want"
```

A run prints the thread id, then the turn's activity, then a final record:
starting HEAD, terminal HEAD, turn id, terminal status, and the repository's
final Git status.

## Commands

- `andrew-agent doctor` reports readiness and exits 0 only when nothing is a
  blocker.
- `andrew-agent run <repository> <prompt>` builds, installs, and runs one turn.
- `andrew-agent resume <thread-id> [prompt]` prints a stored thread, or
  continues it.
- `andrew-agent status [thread-id]` prints the stored record, and live status
  when given an id.

`status` with no argument resolves the latest thread for the repository you
are standing in. `resume` with no prompt prints the stored record and starts
no turn.

Exit codes:

- `0` succeeded, or the turn completed.
- `1` the turn failed, the thread was not found, or output could not be
  written.
- `2` invalid command usage.
- `3` preflight or runtime preparation failed, including a failed Doctor
  check.
- `4` the App Server failed.
- `130` the turn was interrupted.

## Approval and safety model

Codex asks for approval before a gated action. This agent answers that
request itself, and the rule is strict:

**An approval is never granted unless stdin is a terminal.** In any
non-interactive context, including a script, a pipeline, or CI, every gated
action is declined immediately without a prompt. This is a boundary, not a
bug: the agent will not decide on your behalf.

On a terminal you get a bounded prompt naming the request, thread, turn, and
item, the relevant context, and a numbered list of choices ending in
`Selection:`. Anything other than a listed choice is treated as the safest
option, which is always a decline. A malformed or unrecognized request is
declined without being executed.

Beyond approvals, the agent refuses to start when the target repository is
not clean, and it re-reads HEAD after the turn to report exactly what changed.

## Runtime locations

Two roots, which must not overlap, and which you can override:

- The bundle source root is `~/.codex`, overridden by
  `ANDREW_AGENT_CODEX_SOURCE`.
- All runtime state lives under
  `~/Library/Application Support/andrew-code-agent`, overridden by
  `ANDREW_AGENT_STATE_ROOT`.

`ANDREW_AGENT_CODEX_BIN` overrides the `codex` binary, which is otherwise
resolved from `PATH`.

Under the state root:

- `codex-home/` is the managed Codex home the App Server runs against.
- `bundles/` holds built candidate artifacts, addressed by content.
- `threads/` holds one record per thread.
- `run.lock` is held for the duration of a command.
- `active-install.json` records what the current install owns.
- `install-journal.json` and `install-preimages/` exist only while an install
  is in flight.

State directories are created owner-only (`0700`) and are rejected if they are
symbolic links or owned by anyone else.

## Recovery

**A command reports `Process lock release failed` or refuses to start.**
Another `andrew-agent` process holds `run.lock`. v0.1 does not reclaim a lock
whose owner is gone; check for a live process, and remove the lock file only
when you are sure none is running.

**Doctor reports `blocker ACTIVE_INSTALL` after a previous run was killed.**
An install did not finish, so `install-journal.json` is still present and the
installation is not considered valid. The next `run` refuses with exit 3 and
changes nothing rather than installing over an unknown state.

**Doctor reports `blocker SOURCE_DIRTY`.** Commit or stash the source root, or
point `ANDREW_AGENT_CODEX_SOURCE` at a clean tree.

**Doctor reports `blocker CODEX_VERSION`.** The resolved `codex` is not the
pinned version. Install the pinned version, or point
`ANDREW_AGENT_CODEX_BIN` at it.

**A run exits 3 with `Repository preflight failed`.** The target is not a Git
worktree, is not clean, or contains a submodule.

## v0.1 limitations

These are support boundaries, chosen deliberately. None of them is hidden
behind a fallback.

- **macOS only.** Every other platform is refused at startup.
- **One repository, one process.** A single lock covers the whole state root.
- **The target worktree must be clean.** There is no partial-authority mode.
- **Submodules and gitlinks are unsupported.** Any `160000` entry, in the
  commit tree or in the index, is rejected.
- **The bundle source root must be clean, and bundled files must be tracked.**
  This is the boundary most likely to block you: measured on 2026-08-22, the
  default source root `~/.codex` carried 100 dirty entries, nearly all of them
  Codex's own writes under `memories/`. If you use Codex normally, that tree
  is almost never clean. Point `ANDREW_AGENT_CODEX_SOURCE` at a dedicated
  clean tree instead.
- **Approvals require a terminal.** Non-interactive contexts decline
  everything gated.
- **Git output is bounded at 16 MiB** per captured stream. A repository whose
  status or diff exceeds that fails rather than truncating silently.
- **Protocol lines are bounded at 16 MiB** of UTF-8 wire bytes.
- **A turn's final item list is not a complete inventory.** `codex-cli
0.148.0` completes every turn with a summary item view, so the terminal
  status is authoritative but the item list that arrives with it is not.
  What the agent reports is what it observed while the turn streamed.
- **A stale lock is not reclaimed automatically.**
- **Piping output to a reader that closes early misreports the outcome.**
  `andrew-agent doctor | head -1` or `| grep -m1 blocker` closes the pipe
  before the command has finished writing, so the write fails and the command
  exits 3 with `Doctor preflight failed.` even though Doctor ran correctly and
  the line you asked for was printed. Read the full output, or redirect to a
  file first, before trusting a nonzero exit from a piped invocation.
- **The Codex version is pinned exactly.** There is no compatibility range.
- **`oracle` and `shared-memory` capabilities are unreachable.** The gating
  exists in the renderer, but the CLI always requests no capabilities.

## Development

```bash
pnpm check                  # typecheck plus every test layer
trunk check --all --no-fix
```

Two gates are opt-in and do not run by default:

```bash
# Verify the generated trees byte-for-byte against a pinned Codex.
ANDREW_AGENT_PINNED_CODEX_BIN=<pinned codex> pnpm test:contract

# Verify the real Codex accepts the configuration this product installs.
ANDREW_AGENT_REAL_SMOKE=1 \
  ANDREW_AGENT_SMOKE_CODEX_BIN=<pinned codex> \
  pnpm test:e2e
```

Both want the pinned release binary. A standalone Codex install keeps its
versioned releases under
`~/.codex/packages/standalone/releases/<version>-<arch>/bin/codex`, which is
outside the tracked source tree and so does not affect source cleanliness.

Unset, each skips with a printed notice; pointed at a version that does not
match the pin, each fails and names the version it found.

## Codex App Server contract

The committed App Server TypeScript and JSON Schema artifacts are generated by
exactly `codex-cli 0.148.0` without experimental fields. Regenerate both trees
from the repository root, using the pinned release binary rather than whatever
`codex` resolves to on your PATH:

```bash
codex=~/.codex/packages/standalone/releases/0.148.0-aarch64-apple-darwin/bin/codex
"$codex" --version
"$codex" app-server generate-ts --out src/generated/codex-app-server
"$codex" app-server generate-json-schema --out schemas/codex-app-server
```

Do not edit or format files under either generated tree by hand. The contract
test regenerates both trees in a temporary directory and compares their
complete relative path, mode, and byte inventories.

The generated TypeScript package uses the CommonJS boundary in
`src/generated/package.json`. The build copies that boundary to
`dist/generated/package.json`; verify they stay identical with
`cmp src/generated/package.json dist/generated/package.json`.
