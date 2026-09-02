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
- Node.js 24.20.0 and pnpm 11.22.0.
- Codex `0.152.1` exactly. A different version is a Doctor blocker and fails
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
mkdir -p ~/.local/bin
target=~/.local/bin/andrew-agent
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$PWD" > "$target"
chmod +x "$target"
"$target" --help
```

`~/.local/bin` is not on a stock macOS `PATH`, so `andrew-agent` resolves only
after you add it — in your shell profile if you want it to persist:

```bash
export PATH="$HOME/.local/bin:$PATH"
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

Select a bundle source first. The source root must be a Git worktree root
whose tree is clean. `~/.codex` is already a Git worktree root, but it will
rarely be clean — Codex writes to it on every session — so clone it into a
dedicated tree and point the agent at the clone:

```bash
git clone ~/.codex ~/andrew-agent-source
export ANDREW_AGENT_CODEX_SOURCE=~/andrew-agent-source
```

The clone must contain `agent-bundle.toml` and every file that manifest names,
all committed. Re-clone or pull when you want the agent to pick up profile
changes; nothing else keeps the two trees in step.

Then authenticate the managed Codex home. The agent never copies your
existing credentials into it, and `codex login` does not create the directory
— it fails outright when `CODEX_HOME` does not exist. Both the state root and
the managed home must be owner-only, or a run refuses with exit 3.

```bash
managed="$HOME/Library/Application Support/andrew-code-agent/codex-home"
mkdir -p "$managed"
chmod 700 "$(dirname "$managed")" "$managed"
CODEX_HOME="$managed" codex login
```

Skipping this is the most likely first failure: Doctor reports
`blocker AUTH_CONFIGURATION`, and `run` exits 3 with
`Candidate readiness failed: AUTH_CONFIGURATION.` before it reaches the App
Server.

```bash
andrew-agent doctor
```

With authentication in place but nothing installed yet, Doctor still reports
`ACTIVE_INSTALL`, `BUNDLE_DIGEST`, and `STRICT_CONFIG` as blockers and exits

1. That is expected — all three describe an installation that does not exist
   yet, and the first `run` creates it.

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

## Optional Oracle capability

Oracle is disabled for normal runs and is enabled only when `run` requests the
`oracle` capability.
Set `ANDREW_AGENT_ORACLE_ROOT` to an existing absolute wiki root, then request
the capability explicitly:

```bash
export ANDREW_AGENT_ORACLE_ROOT=/absolute/path/to/wiki
andrew-agent run --capability oracle /path/to/repository \
  "describe the change you want"
```

The bundle manifest must declare the optional `oracle` capability.
The Oracle root must not overlap the bundle source or runtime state root.
If the flag is present but `ANDREW_AGENT_ORACLE_ROOT` is unset, the command
exits 3 with `Capability preparation failed: ORACLE_ROOT_UNSET.`
A missing, unreadable, overlapping, or otherwise invalid root also makes the
requested run exit 3 during runtime preparation.
The command never continues as a non-Oracle run after either failure.

Each new thread records its capability grant and a digest of the canonical
Oracle root.
To continue an Oracle thread with a new prompt, provide the same capability and
root:

```bash
export ANDREW_AGENT_ORACLE_ROOT=/absolute/path/to/the-same-wiki
andrew-agent resume --capability oracle <thread-id> "follow-up prompt"
```

A prompted resume refuses a different capability set or Oracle root.
`andrew-agent resume <thread-id>` without a prompt only reads the stored record,
so it does not require the flag or an available Oracle root.

`andrew-agent doctor` does not take a capability flag.
When `ANDREW_AGENT_ORACLE_ROOT` is set, Doctor evaluates the optional Oracle
input and reports `OPTIONAL_ORACLE` as ready or as a nonblocking warning.
When the variable is unset, Doctor reports that Oracle was not requested.

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

### The turn may only write inside the repository

Every turn runs under a `workspaceWrite` sandbox whose writable roots are the
target repository and `/tmp`. Network access is off. Everything else is denied,
including everything under `$HOME` and any shared SDK root.

The policy also names the process temporary directory, but that grants nothing
here: the App Server child is started with an environment built from
`CODEX_HOME`, `PATH` and, with the capability on, `LLM_WIKI_ROOT`, so `TMPDIR`
reaches it unset. A tool that reads `TMPDIR` therefore falls back to `/tmp` and
stays inside the boundary. **A tool that resolves the Darwin per-user temporary
directory does not**: `confstr` answers from the system rather than the
environment, so it still returns a path under `/var/folders`, which is outside
both writable roots and is refused like any other outside path.

That keeps a turn's blast radius equal to the thing under version control. It
also means **a command that populates a cache outside the repository has
nowhere to write**, so a toolchain whose mutable state lives outside the
workspace may not work inside a turn. A repository whose dependency tree is
already installed can hide that entirely.

This boundary is measured rather than inferred.
`docs/notes/2026-09-02-sandbox-boundary-measurement.md` records a managed run in
which a write inside the repository and a write to `/tmp` both succeeded while a
write to a sibling directory outside both was refused, corroborated by the Codex
session record as well as the command's own output. `doctor` states the boundary
before a turn starts, as the `SANDBOX_BOUNDARY` finding.

No specific toolchain is named here because none has been observed failing this
way, and the measurement deliberately touched no real cache. It shows what
happens to such a write, not that any toolchain needs one.
`docs/notes/2026-08-25-writable-root-boundary.md` records which caches on one
machine sit outside the boundary, and why an earlier claim that this stopped a
real run was withdrawn.

## Runtime locations

The two base roots must not overlap, and an Oracle run adds a third root that
must not overlap either base root:

- The bundle source root is `~/.codex`, overridden by
  `ANDREW_AGENT_CODEX_SOURCE`.
- All runtime state lives under
  `~/Library/Application Support/andrew-code-agent`, overridden by
  `ANDREW_AGENT_STATE_ROOT`.
- The optional Oracle root is read from `ANDREW_AGENT_ORACLE_ROOT` only when
  the `oracle` capability is requested.
  It must resolve from an absolute path to an existing readable directory.

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
installation is not yet considered valid. Run the command again: a well-formed
journal is rolled back automatically before the new candidate is installed, so
this usually resolves itself. Do not delete the journal or the preimages —
they are the material that rollback consumes. Only recovery state the program
cannot account for, such as a malformed or orphaned journal, makes `run` refuse
with exit 3 rather than install over an unknown state.

**Doctor reports `blocker STRICT_CONFIG` after a candidate is installed.**
The real Codex rejected the configuration the bundle rendered, so `run` stops
with exit 3 and `Candidate readiness failed: STRICT_CONFIG.` before the App
Server starts.
This almost always means the manifest names a key this Codex version does not
know. Ask Codex directly which one:

```bash
managed="$HOME/Library/Application Support/andrew-code-agent/codex-home"
CODEX_HOME="$managed" codex app-server --strict-config --listen stdio:// < /dev/null
```

It names the offending field and line. Remove that key from the manifest's
`config_overrides` or `config_keys` and run again.

**Doctor reports `blocker SOURCE_DIRTY`.** Commit or stash the source root, or
point `ANDREW_AGENT_CODEX_SOURCE` at a clean tree.

**Doctor reports `blocker CODEX_VERSION`.** The resolved `codex` is not the
pinned version. Install the pinned version, or point
`ANDREW_AGENT_CODEX_BIN` at it.

**A run exits 3 with `Repository preflight failed`.** The target is not a Git
worktree, is not clean, or contains a submodule. The line names which:
`NOT_GIT_REPOSITORY`, `GIT_WORKTREE_DIRTY`, `GIT_HEAD_UNAVAILABLE`,
`GIT_STATUS_FAILED`, or `GIT_SNAPSHOT_RACE`. A submodule is reported by its
own sentence rather than a code.
`Runtime preparation failed` and `Candidate readiness failed` name their cause
the same way — the first with the failing installer or path check, the second
with every Doctor blocker that stopped the run. Those blocker codes are the
ones `andrew-agent doctor` prints, so both commands answer in one vocabulary.

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
0.152.1` completes a turn with an item view that is not the full inventory,
  so the terminal status is authoritative but the item list that arrives with
  it is not. Which view arrives depends on how the turn ended: a completed
  turn was measured as `summary` and an interrupted one as `notLoaded`, both
  against 0.148.0, and the reducer accepts either.
  What the agent reports is what it observed while the turn streamed.
- **A stale lock is not reclaimed automatically.**
- **Piping output to a reader that closes early misreports the outcome.**
  `andrew-agent doctor | head -1` or `| grep -m1 blocker` closes the pipe
  before the command has finished writing, so the write fails and the command
  exits 3 with `Doctor preflight failed.` even though Doctor ran correctly and
  the line you asked for was printed. Read the full output, or redirect to a
  file first, before trusting a nonzero exit from a piped invocation.
- **The Codex version is pinned exactly.** There is no compatibility range.
- **The `shared-memory` capability is unreachable.** Oracle is supported
  separately as the opt-in capability described above.

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
exactly `codex-cli 0.152.1` without experimental fields. Regenerate both trees
from the repository root, using the pinned release binary rather than whatever
`codex` resolves to on your PATH:

```bash
codex=~/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex
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
