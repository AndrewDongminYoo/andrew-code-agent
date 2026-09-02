# The managed sandbox boundary, measured

Issue #23 asked for the current boundary to be measured before any policy is
chosen, and said the agent's own prediction about sandbox behaviour is not
evidence. This note holds the measurement. It selects no policy.

Measured 2026-09-02 against the pinned `codex 0.148.0`, bundle source at
`c0b59b5`, product at `b7a3cf7`.

## The fixture, and why it is not in the scratchpad

Three writes, one per boundary, from a script committed in a synthetic target
repository. The script reports a class name rather than a path, so no
transcript of a run carries a personal absolute path.

**Both the target repository and the synthetic cache root have to sit outside
`/tmp`.** The turn runs under `excludeSlashTmp: false` and
`excludeTmpdirEnvVar: false`, so a cache root placed in a session scratchpad
under `/private/tmp` would be writable for being temporary rather than for
being a cache, and the measurement could not tell the two apart. The fixture
therefore lives under `~/.andrew-agent-measure/`, with `target-repo` and
`synthetic-cache` as siblings.

## Step 1: the fixture fails when it should

Run directly, outside any sandbox, with the cache root at mode `000`, the
probe reported `PROBE cache WRITE_DENIED` and the shell printed
`Permission denied`. With the mode restored, all three writes reported
`WRITE_OK`. Both branches of the probe are therefore exercised, and a denial
in a managed run is not the probe reporting a fixed answer.

## Step 2: the unchanged managed policy

| Boundary                        | Result         |
| ------------------------------- | -------------- |
| Inside the target repository    | `WRITE_OK`     |
| `/tmp`                          | `WRITE_OK`     |
| Sibling cache root outside both | `WRITE_DENIED` |

Two independent records carry the denial: the rendered command output, which
is the command's own stdout rather than the agent's account of it, and the
Codex session record for the same turn. The repository write is present on
disk afterwards and the cache directory is empty.

**The denial is `Operation not permitted`, not `Permission denied`.** The
control run in step 1 produced the second, so the two failures are
distinguishable in a transcript: `EPERM` here is the sandbox refusing, and
`EACCES` would be an ordinary filesystem permission. Any future diagnostic can
key on that difference rather than guessing.

## An undocumented consequence: the managed turn has no `TMPDIR`

The probe wrote to `${TMPDIR:-/tmp}` and the file landed in `/tmp`, not in the
per-user directory that `TMPDIR` names in an ordinary shell.
`startAppServer` builds the child environment explicitly from `CODEX_HOME`,
`PATH` and, when the capability is on, `LLM_WIKI_ROOT`, so `TMPDIR` reaches
the child unset.

So `excludeTmpdirEnvVar: false` grants nothing in this product as it stands,
and the only temporary location a managed turn actually has is `/tmp`. A
toolchain that honours `TMPDIR` will fall back to `/tmp` inside a managed run
while using the per-user directory outside one.

## What this does and does not establish

It establishes that a write outside the repository and outside `/tmp` is
refused by the sandbox, with a distinguishable error, and that the refusal is
observable from two records rather than inferred.

It does not establish that any real toolchain needs such a write. No real
cache was touched, by the issue's own contract, so nothing here shows that
Flutter, Cargo, pnpm, Ruby or Pub would fail in a managed run — only what
would happen to the write if one were attempted.
