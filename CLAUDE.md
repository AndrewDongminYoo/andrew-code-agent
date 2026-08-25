# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

`AGENTS.md` owns the repository boundaries and the Trunk verification gate;
read it and do not restate it here.
Markdownlint enforces an 80-column limit on every file except `AGENTS.md`,
so hard-wrap prose here instead of using one line per sentence.

## Commands

All 22 test files import the compiled output (`await import("../../dist/...")`),
and the CLI integration suite additionally asserts that `dist/cli.js` exists.
A bare `node --test` against a stale or missing `dist/` therefore fails in a
way that looks like a product bug.
Always build first.

```bash
pnpm install --frozen-lockfile
pnpm build          # tsc, then copies the generated CommonJS boundary to dist/
pnpm typecheck      # tsc --noEmit
pnpm test:unit      # each layer script runs pnpm build first
pnpm test:integration
pnpm test:contract
pnpm test:e2e
pnpm check          # typecheck plus all four test layers; the aggregate gate
```

Run a single test file or a single case after an explicit build:

```bash
pnpm build
node --test test/integration/cli.test.mjs
node --test \
  --test-name-pattern='regenerates stable artifacts byte-for-byte' \
  test/contract/client.test.mjs
```

`test:integration`, `test:contract`, and `test:e2e` are each wrapped in
`test -d <dir> || exit 0`.
A missing or empty layer directory exits 0, so `pnpm check` can go green over
a layer that contributes no coverage.
Check that the directory holds the files you expect before reading a green
aggregate as evidence.

Three gates are opt-in, so a default green `pnpm check` does not cover them:

- `test/contract/client.test.mjs` verifies the generated trees byte-for-byte
  only when `ANDREW_AGENT_PINNED_CODEX_BIN` points at a `codex` binary whose
  version matches `REQUIRED_CODEX_VERSION`.
  Unset skips with a printed notice; a mismatched version fails.
  This variable steers that one test, not the product runtime.
- `test/integration/live-manifest.test.mjs` skips itself unless
  `ANDREW_AGENT_CODEX_SOURCE` is set; it is the only test that reads a real
  bundle source tree.
- The two live smokes in `test/e2e/acceptance.test.mjs` skip unless
  `ANDREW_AGENT_REAL_SMOKE` is set, and the two-run gate additionally needs
  `ANDREW_AGENT_SMOKE_AUTH`.
  They are the only tests that spawn a real Codex, and the only place a real
  Codex writes back into a managed home between two runs.

Run the pinned form before trusting the generated contract:

```bash
ANDREW_AGENT_PINNED_CODEX_BIN=<path to the pinned codex> pnpm test:contract
```

## Runtime environment

Four environment variables define the whole runtime surface, and the tests use
them to build isolated machine-like environments:

- `ANDREW_AGENT_CODEX_SOURCE` — bundle source root, which must be a clean Git
  worktree root; defaults to `$HOME/.codex`.
- `ANDREW_AGENT_STATE_ROOT` — managed runtime state root; defaults to
  `$HOME/Library/Application Support/andrew-code-agent`.
- `ANDREW_AGENT_CODEX_BIN` — absolute path to the `codex` executable;
  otherwise resolved from `PATH`.
- `HOME` — base for both defaults.

`src/runtime/paths.ts` canonicalizes both roots, rejects any overlap between
them, and derives `codexHome` as `<stateRoot>/codex-home`.
The state root also holds `threads/`, `bundles/`, the single `run.lock`, and
the install bookkeeping `active-install.json`, `install-journal.json`, and
`install-preimages/`.
State directories must be owner-only `0700` ordinary directories, never
symbolic links, and the platform must be macOS.

## Architecture

One `run` invocation crosses every layer, and no single file shows the whole
path:

1. **Git preflight** (`src/runtime/git.ts`, `src/git/process.ts`) resolves the
   repository root and snapshots HEAD plus `status --porcelain=v2`, re-reading
   HEAD afterwards to detect a race.
1. **Runtime state and lock** (`src/runtime/paths.ts`, `src/runtime/lock.ts`)
   create the owner-only state tree and take the single process lock.
1. **Bundle build** (`src/bundle/*`) reads `agent-bundle.toml` from the source
   root, resolves only Git-tracked sources (`source-tree.ts`), renders config
   and hooks with token substitution and `oracle` / `shared-memory` capability
   gating (`render.ts`), scans the rendered bytes for secrets, credentials, and
   leaked runtime identifiers (`validate.ts`), and writes a content-addressed
   artifact with a `bundle-metadata.json` digest inventory (`artifact.ts`).
1. **Install** (`src/bundle/install.ts`) applies the artifact into `codex-home`
   through a journal with preimages, so an interrupted install is recoverable
   by `recoverInterruptedInstall` on the next run.
   Each installed file carries a lifecycle class in `active-install.json` at
   schema 2, and the installer assigns it: `config.toml` is
   `reset-before-run`, everything else is `immutable`.
   A reset-before-run file stays out of the journal and is converged by
   `resetManagedFiles` on every install, because Codex rewrites the file it
   owns between runs and the journal's preimage check assumes the opposite.
   A schema 1 record is migrated in memory rather than rejected, and so is a
   schema 1 install journal, after each is checked against its canonical bytes
   in the shape it was written in.
1. **Doctor gate** (`src/commands/doctor.ts`) classifies findings as
   `blocker`, `warning`, or `ready`; any blocker aborts the run before the App
   Server starts.
1. **App Server session** (`src/app-server/*`) spawns `codex app-server`,
   speaks JSON-RPC over stdio with a bounded framer (`transport.ts`), exposes
   typed thread and turn calls against the generated contract (`client.ts`),
   and drives the turn through the coordinator (`coordinator.ts`).
1. **Bounded state and output** (`reducer.ts`, `renderer.ts`, `terminal.ts`,
   `approvals.ts`) cap item, command, and warning counts, escape every terminal
   control character before writing, and answer approval requests fail-closed.
1. **Persistence** (`src/runtime/thread-store.ts`) writes the thread record
   that `resume` and `status` read back in a later process.

`prepareCandidate` always passes `requestedCapabilities: []`, so the `oracle`
and `shared-memory` gating in `render.ts` is unreachable from the CLI in v0.1;
only `live-manifest.test.mjs` exercises a requested capability.

`resume` and `status` reuse the helpers exported from `run.ts`
(`prepareCandidate`, `coordinatorDependencies`, `appServerInput`,
`terminalExit`, `writeLine`) rather than duplicating the pipeline.
Command handlers take a `CommandDependencies` record whose defaults are the
real implementations, which is how the integration tests substitute fakes
without patching modules.

### Exit codes

`README.md` owns the operator-facing table.
It was verified against the `return` and `outcome =` sites in `src/cli.ts`,
`src/commands/run.ts`, `src/commands/resume.ts`, and `src/commands/status.ts`;
re-derive it there rather than from memory if the mapping changes.

### Fail-closed invariants

These are deliberate v0.1 support boundaries, not gaps to smooth over.
Removing one silently widens the product contract:

- The target repository must be a clean worktree, and the bundle source tree
  must be clean with every bundled file Git-tracked.
- Submodules and gitlinks are rejected wherever mode `160000` appears, in both
  the HEAD tree and the index; an index entry tagged anything other than `H`
  is treated as unclean.
- Git child processes run with a sanitized environment, and each captured
  stream is bounded at 16 MiB.
- JSONL protocol lines are bounded at 16 MiB of UTF-8 wire bytes; this is a
  resource policy, not a generated schema maximum.
- Every rendered and printed string is escaped and byte-bounded before it
  reaches a terminal.
- An immutable installed file that drifts blocks the run; only a
  reset-before-run file is reconciled, and a reset target the active install
  does not own is refused rather than overwritten.
  Doctor's strict-config shadow gives up the digest pin for that one file in
  exchange, so it validates the bytes on disk rather than the bytes installed;
  its mode is still constrained, to `0600` on top of the ordinary two.
- Approvals fail closed on any unknown or malformed request, and the
  coordinator cleans up before releasing the lock.
- A stale publication lock is not auto-recovered.

## Generated contract

`src/generated/codex-app-server/**` and `schemas/codex-app-server/**` are owned
by their generator at the Codex version pinned in `src/constants.ts`.
Never edit or format them by hand; regenerate instead.
`README.md` holds the exact regeneration commands, the byte-for-byte contract
test, and the CommonJS boundary file the build copies into `dist/`.
`.trunk/trunk.yaml` excludes both generated trees and `test/**/*.mjs` from
prettier, which is why test files carry very long single lines; leave that
formatting alone.
Everything else, including this file, is linted by prettier and markdownlint.

## Documentation layout

Plans go to `docs/plans/`, specifications to `docs/specs/`, and working notes
to `docs/notes/`.
Do not create tool-branded documentation directories.
