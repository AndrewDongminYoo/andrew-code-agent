# The managed sandbox boundary, measured

Issue #23 asked for the current boundary to be measured before any policy is chosen, and said the agent's own prediction about sandbox behaviour is not evidence.
This note holds the measurement.
It selects no policy.

Measured 2026-09-02 against the pinned `codex 0.148.0`, bundle source at `c0b59b5`, product at `b7a3cf7`.

Re-run unchanged later the same day against `codex 0.152.1`, while raising the pin, with the same three results and the same empty cache directory afterwards.
The boundary is therefore not specific to the version it was first measured on.

## The fixture, and why it is not in the scratchpad

Three writes, one per boundary, from a script committed in a synthetic target repository.
The script reports a class name rather than a path, so no transcript of a run carries a personal absolute path.

**Both the target repository and the synthetic cache root have to sit outside `/tmp`.** The turn runs under `excludeSlashTmp: false` and `excludeTmpdirEnvVar: false`, so a cache root placed in a session scratchpad under `/private/tmp` would be writable for being temporary rather than for being a cache, and the measurement could not tell the two apart.
The fixture therefore lives under `~/.andrew-agent-measure/`, with `target-repo` and `synthetic-cache` as siblings.

## Step 1: the fixture fails when it should

Run directly, outside any sandbox, with the cache root at mode `000`, the probe reported `PROBE cache WRITE_DENIED` and the shell printed `Permission denied`.
With the mode restored, all three writes reported `WRITE_OK`.
Both branches of the probe are therefore exercised, and a denial in a managed run is not the probe reporting a fixed answer.

## Step 2: the unchanged managed policy

| Boundary                        | Result         |
| ------------------------------- | -------------- |
| Inside the target repository    | `WRITE_OK`     |
| `/tmp`                          | `WRITE_OK`     |
| Sibling cache root outside both | `WRITE_DENIED` |

Two independent records carry the denial: the rendered command output, which is the command's own stdout rather than the agent's account of it, and the Codex session record for the same turn.
The repository write is present on disk afterwards and the cache directory is empty.

**The denial arrived as `Operation not permitted`, and the step 1 control produced `Permission denied`.** That is what the two runs showed, and it is as far as it goes.
`EPERM` does not identify a sandbox refusal: an ordinary write to a file carrying the `uchg` flag produces the same text with no sandbox anywhere, and so does a write refused on ownership grounds.
So a diagnostic must not key on the error text to decide that the sandbox was the cause.

## An undocumented consequence: the managed turn has no `TMPDIR`

The probe wrote to `${TMPDIR:-/tmp}` and the file landed in `/tmp`, not in the per-user directory that `TMPDIR` names in an ordinary shell.
`startAppServer` builds the child environment explicitly from `CODEX_HOME`, `PATH` and, when the capability is on, `LLM_WIKI_ROOT`, so `TMPDIR` reaches the child unset.

So `excludeTmpdirEnvVar: false` grants nothing in this product as it stands, and the only temporary location a managed turn actually has is `/tmp`.

**That does not make every temporary write safe, and the difference cuts the wrong way.** A tool that reads `TMPDIR` falls back to `/tmp` and stays inside the boundary.
A tool that asks the system instead does not: with `TMPDIR` unset, `getconf DARWIN_USER_TEMP_DIR` still answers `/var/folders/.../T/`, because `confstr` resolves it without the environment.
That path is neither the repository nor `/tmp`, so a macOS-native toolchain that resolves its temporary directory that way is refused while a POSIX-style one succeeds.

## What this does and does not establish

It establishes that a write outside the repository and outside `/tmp` is refused by the sandbox, with a distinguishable error, and that the refusal is observable from two records rather than inferred.

It does not establish that any real toolchain needs such a write.
No real cache was touched, by the issue's own contract, so nothing here shows that Flutter, Cargo, pnpm, Ruby or Pub would fail in a managed run — only what would happen to the write if one were attempted.
