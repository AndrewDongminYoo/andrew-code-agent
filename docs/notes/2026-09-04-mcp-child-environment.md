# What a Codex 0.152.1 stdio MCP child receives

Issue #25's `[[mcp_servers]]` manifest section depends on one fact this
repository does not control: the environment and working directory the pinned
Codex binary hands an MCP child. This note measures that fact before the
manifest shape is locked. It changes no product code.

Measured 2026-09-04 against the pinned
`~/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex`
(`codex-cli 0.152.1`), product at `9b3d4c7`, the operator's real bundle source
at `2260a82` (read only, never written to).

## Step 1: a recording MCP "server"

`/tmp/mcp-probe/record.sh` (outside the repository, mode `0755`):

```sh
#!/bin/sh
out="/tmp/mcp-probe/child.txt"
{ echo "cwd=$(pwd)"; env | sort; } > "$out"
exec cat
```

## Step 2 and 3: strict-config acceptance of `env_vars`

`/tmp/mcp-probe/home/config.toml`:

```toml
[mcp_servers.probe]
command = "/tmp/mcp-probe/record.sh"
args = []
env = { PROBE_LITERAL = "set-by-config" }
env_vars = ["PROBE_PARENT"]
startup_timeout_sec = 5
```

Command:

```bash
CODEX_HOME=/tmp/mcp-probe/home PROBE_PARENT=from-parent \
  ~/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex \
  app-server --strict-config --stdio < /dev/null; echo "exit=$?"
```

Result: `exit=0`, empty stdout, empty stderr. The App Server accepted the
configuration and exited cleanly once stdin closed. No key was rejected, so
`env_vars` is known to 0.152.1's strict-config validation.

**`MCP_ENV_VARS_KEY_ACCEPTED = true`.**

## Step 4: driving a real thread so the MCP child is spawned

Codex spawns MCP servers when a thread starts, not when the App Server
starts, so a real thread had to run against a candidate that declares
`mcp_servers.probe`.

Two changes from the brief's literal recipe, both discovered empirically and
recorded here because they will recur for anyone repeating this measurement:

- **`test/e2e/acceptance.test.mjs` does not read `ANDREW_AGENT_CODEX_SOURCE`
  from the outer process.** Its "real Codex" test builds its own isolated
  fixture from `test/fixtures/source-codex/clean` and
  `test/fixtures/manifests/acceptance.toml`, and the comment at the top of the
  file says the child must never inherit `process.env` for exactly this
  reason. Pointing the variable at a throwaway source before invoking that
  test has no effect on what the test's CLI child sees. The CLI itself
  (`dist/cli.js run <repository> <prompt>`) was invoked directly instead, with
  an explicit, fully-specified environment built the same way `environmentFor`
  in that test file builds one — this is not a product code change, only a
  different call site for the same public CLI entry point.
- **`TMPDIR=/tmp` fails Doctor's scratch-parent safety check.** `/tmp`
  (`/private/tmp`) is mode `1777`; `createScratchRoot` in
  `src/commands/doctor.ts` refuses any scratch parent whose mode has the
  group- or other-write bits set, which is the correct behavior — the
  fixture's `TMPDIR` default of `/tmp` only ever works there because the whole
  fixture is disposable and the check is about safety, not convenience. A real
  shell's `$TMPDIR` is normally a private per-user directory under
  `/var/folders/...` and would pass; this measurement used an explicit
  owner-only (`0700`) directory instead.

A throwaway clone of the operator's own bundle source
(`git clone --quiet /Users/dongminyu/.codex /tmp/mcp-probe/source`, read-only
against the original) got two commits, neither touching
`/Users/dongminyu/.codex` itself:

1. `config.toml` gained `[mcp_servers.probe]` with `command` and
   `startup_timeout_sec` only (scalar keys, matching the brief's "this proves
   the spawn, not the array keys"), and `agent-bundle.toml`'s `config_keys`
   gained `mcp_servers.probe.command` and
   `mcp_servers.probe.startup_timeout_sec`.
2. `hooks/handoff-first-precompact.sh` had its `MARKER_DIR` value changed from
   `${CODEX_STATE_HOME}/cache/handoff-first` to
   `${CODEX_STATE_HOME}/handoffmarkers`. The original text fails this
   product's own manifest validation (`FORBIDDEN_PATH_SEGMENT`, rule
   `forbidden-path-segment`) because the file's content contains the
   substring `cache/handoff-first`, and `cache` is one of
   `agent-bundle.toml`'s own `forbidden.path_segments`. This is confirmed
   present in the real, currently-committed `~/.codex` HEAD
   (`git -C ~/.codex show HEAD:hooks/handoff-first-precompact.sh`) and is
   unrelated to MCP servers or to this task's edits — it is a pre-existing
   property of the operator's real bundle source that a normal build from it
   would also hit. It is reported here as a finding, not fixed in the real
   repository, and the probe clone's edit exists only to get a candidate
   bundle far enough to spawn the MCP child.

Command (`HOME`, `ANDREW_AGENT_CODEX_SOURCE`, `ANDREW_AGENT_STATE_ROOT`, and
`ANDREW_AGENT_CODEX_BIN` built the same way `environmentFor` in
`test/e2e/acceptance.test.mjs` builds them; `PATH` differs from that harness,
which inherits the outer process's own `PATH` — this measurement instead
passed a fully explicit, hand-narrowed `PATH` so every input to the run stayed
named rather than ambient):

```bash
env -i \
  HOME=/tmp/mcp-probe/env-home \
  ANDREW_AGENT_CODEX_SOURCE=/tmp/mcp-probe/source \
  ANDREW_AGENT_STATE_ROOT=/tmp/mcp-probe/state \
  ANDREW_AGENT_CODEX_BIN=<pinned codex path> \
  PATH=<node bin dir>:/usr/bin:/bin:/usr/sbin:/sbin \
  TMPDIR=/private/tmp/mcp-probe/scratch-parent \
  node dist/cli.js run /tmp/mcp-probe/target-repo \
  "Reply with the single word ACKNOWLEDGED and change nothing."
```

`/tmp/mcp-probe/target-repo` is a throwaway one-commit Git repository created
solely for this measurement, and `/tmp/mcp-probe/state/codex-home/auth.json`
holds a copy of the dedicated test credentials (`~/.agents/auth.json`, copied
never read or printed).

The turn itself ended `Terminal status: failed` on a transport error
(`Falling back from WebSockets to HTTPS transport. unexpected status 404`),
unrelated to MCP servers or to this measurement — the MCP child had already
been spawned and had already written `/tmp/mcp-probe/child.txt` by the time
the turn's model call failed, which is what Step 4 needed to prove.

The installed `codex-home/config.toml` carried only the two declared scalar
keys, confirming the rendering path did not smuggle in `args`, `env`, or
`env_vars`:

```toml
[mcp_servers.probe]
command = "/tmp/mcp-probe/record.sh"
startup_timeout_sec = 5
```

## What the child actually saw

`/tmp/mcp-probe/child.txt` after the run, values redacted to presence
(`cwd` is not sensitive — it is the throwaway target repository path):

```log
cwd=/private/tmp/mcp-probe/target-repo
PATH=<value present>
PWD=<value present>
SHLVL=<value present>
_=<value present>
__CF_USER_TEXT_ENCODING=<value present>
```

That is the complete sorted `env` output: five keys, nothing else. Of the
five names the brief asked about:

- `PATH` — **present**, but not the literal PATH this measurement passed to
  the CLI: two Codex-managed directories are prepended, and the CLI's own
  `PATH` follows unchanged. Shown literally below (it contains no secret; the
  two segments naming a `/Users/dongminyu` path are each held to a
  placeholder instead, since they are not the fact under measurement):

  Segments joined by `:` in the actual value; one per line here to fit the
  80-column limit:

  ```log
  PATH=
    /private/tmp/mcp-probe/state/codex-home/tmp/arg0/codex-arg0cDGUrM
    <codex release's codex-path dir>
    <node bin dir>
    /usr/bin
    /bin
    /usr/sbin
    /sbin
  ```

  The first segment is a per-run, managed `arg0` wrapper directory under the
  run's own state root. The second is the pinned Codex release's own
  `codex-path` directory. Those two are what Codex prepends. All five
  segments this measurement passed to the CLI as `PATH` — the node bin
  directory, then `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` — follow
  afterward, unchanged and in order. Codex does not pass the parent's `PATH`
  through as-is; it builds a new value that keeps the caller's `PATH`
  entries as a suffix.

- `HOME` — **absent**.
- `CODEX_HOME` — **absent**.
- `LLM_WIKI_ROOT` — **absent** (the `oracle` capability was not requested for
  this candidate, so this is expected either way).
- `PROBE_PARENT` — **absent**. This run's manifest declared only
  `mcp_servers.probe.command` and `mcp_servers.probe.startup_timeout_sec`
  (scalar keys, per the brief); `env_vars` was not part of this candidate, so
  its absence here says nothing beyond that — Step 3 already established that
  0.152.1 accepts the key.

`PWD`, `SHLVL`, `_`, and `__CF_USER_TEXT_ENCODING` are not parent-environment
carryover: they are `/bin/sh`'s own startup variables and a macOS-injected
value that every process gets regardless of what its caller passed in.

**`MCP_ENV_INHERITS_PARENT = false`.** The child's environment is not the
Codex process's environment, filtered or otherwise — of everything that would
be present under real inheritance (`HOME`, `ANDREW_AGENT_*`, `TMPDIR`, and so
on, none of which reached the App Server's own child environment either, per
the 2026-09-02 sandbox-boundary note), only a Codex-constructed `PATH`
reaches the MCP child. A manifest section that wants a variable in the MCP
child's environment cannot rely on ambient inheritance; it must route the
value through the server's own `env` or `env_vars` config, which is what Step
3 confirms 0.152.1 accepts.

**`MCP_CWD_DEFAULT`** is the target repository root passed as `run`'s
`<repository>` argument — measured here as `/private/tmp/mcp-probe/target-repo`,
not `codex-home` and not any state or scratch directory.

## Does the child's PATH contain pnpm's directory?

`buildChildPath()` in `src/app-server/client.ts` builds the App Server's own
`PATH` from `dirname(process.execPath)`, then every absolute entry of the CLI
process's own `PATH`, then `/usr/bin` and `/bin` — so in a normal operator
invocation, whatever directory holds `pnpm` on the operator's real `PATH`
would be forwarded. The Step 4 run above cannot answer this: its CLI `PATH`
was hand-narrowed to `<node bin dir>:/usr/bin:/bin:/usr/sbin:/sbin`, which
excludes pnpm's directory by construction, not by measurement.

`command -v pnpm` reports `/opt/homebrew/bin/pnpm`. Checked `uptime` again
(load average 5.15, under the threshold) and re-ran Step 4 once more, adding
only `/opt/homebrew/bin` to the CLI's `PATH`:

```bash
env -i \
  HOME=/tmp/mcp-probe/env-home \
  ANDREW_AGENT_CODEX_SOURCE=/tmp/mcp-probe/source \
  ANDREW_AGENT_STATE_ROOT=/tmp/mcp-probe/state \
  ANDREW_AGENT_CODEX_BIN=<pinned codex path> \
  PATH=<node bin dir>:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  TMPDIR=/private/tmp/mcp-probe/scratch-parent \
  node dist/cli.js run /tmp/mcp-probe/target-repo \
  "Reply with the single word ACKNOWLEDGED and change nothing."
```

`/tmp/mcp-probe/child.txt` afterward, `PATH` shown literally with the same
`/Users/dongminyu` segments held to a placeholder as above (segments joined
by `:` in the actual value; one per line here to fit the 80-column limit):

```log
PATH=
  /private/tmp/mcp-probe/state/codex-home/tmp/arg0/codex-arg0WU0elY
  <codex release's codex-path dir>
  <node bin dir>
  /opt/homebrew/bin
  /usr/bin
  /bin
  /usr/sbin
  /sbin
```

All six segments passed to the CLI reach the child unchanged and in order,
with the same two Codex-managed directories prepended as the first run.
`/opt/homebrew/bin` is present.

**`MCP_PATH_CONTAINS_PNPM_DIR = true`**, whenever that directory is on the
`PATH` of the process that starts the App Server — which `buildChildPath()`
guarantees for a normal operator invocation, since it forwards every absolute
entry of that `PATH` unfiltered.

## What this does not establish

Only the scalar keys `mcp_servers.probe.command` and
`mcp_servers.probe.startup_timeout_sec` were exercised through the real
install-and-spawn path; `args`, `env`, and `env_vars` were exercised only
through Step 3's separate strict-config probe, which checks acceptance, not
runtime effect. Whether `env` and `env_vars` values actually reach the child
process (as opposed to merely being accepted by strict-config) is not
measured here and would need its own run.
