# Dogfooding v0.1 on rn-typed-assets

First use of `andrew-agent` as a product rather than a test subject, run on
2026-08-22 against `rn-typed-assets` at `bdf066d`, from a machine with no
wrapper, no bundle source clone, and no state root.
Setup followed `README.md` "First run" verbatim; every deviation is recorded
below.

Nine substantive turns plus two preflight probes and three interrupt probes.
Six of seven task-shaped turns produced exactly the requested change, one was
factually wrong in a detail, and one required a `resume` to finish.
The blocking result is not any single task: the product installs correctly and
then refuses to run a second time.

## Mode this record was collected in

- stdin was **not** a terminal, so `answerApproval` would have declined every
  gated request without prompting.
  No approval request was issued in any turn, so this record says nothing
  about the approve path.
- The coordinator hard-codes `sandboxPolicy.networkAccess: false` and
  `writableRoots: [repositoryRoot]`, so no turn could install a package or
  write outside the repository.
- Authentication used a copy of the operator's dedicated agent credentials
  rather than an interactive `codex login`, so the documented first-run login
  path is **not** covered here.
- `ANDREW_AGENT_CODEX_SOURCE` and `ANDREW_AGENT_CODEX_BIN` were exported in
  the shell for every invocation.

## Task record

| ID  | Task                                     | Exit | Time | Verdict |
| --- | ---------------------------------------- | ---- | ---- | ------- |
| t01 | Explain `--output` handling, change none | 0    | 15s  | correct |
| t02 | Add a test for the unsupported format    | 0    | 45s  | correct |
| t03 | JSDoc the three `ts-util.js` exports     | 0    | 46s  | correct |
| t04 | Add a `lint` script to `package.json`    | 0    | 69s  | resumed |
| t05 | Reconcile the two `--output` flag forms  | 0    | 62s  | correct |
| t06 | Survey `process.exit`, document the map  | 0    | 56s  | correct |
| t07 | Is the pinned eslint the latest release  | 0    | 78s  | wrong   |

`resumed` means the turn asked a question and the change landed only after a
`resume`; `wrong` means the answer carried a false detail. Both are unpacked
below.

Every diff was read, and `npx jest` was run after each: 62 tests before, 64
after t05, all passing throughout.

Notable behavior inside those turns:

- **t02 refused the task and was right to.** The requested test already
  existed at `__tests__/output.test.js:13`; the agent said so, declined to
  duplicate it, and ran the suite to prove the coverage. The task premise was
  mine and it was wrong.
- **t02 and t05 recovered from a failing command without help.** `npm test`
  exited 1, and both turns re-ran it with watchman disabled and got exit 0.
  Zero human input. Why the first attempt failed is the agent's diagnosis,
  not an observation: the renderer shows command exit codes and never command
  output, so nothing here confirms it.
- **t05 fixed the root cause rather than the symptom.** The reported defect
  was in `parseOutputArg`, but the fix landed one level down in the shared
  `parseFlagValue`, changing a truthiness test to a bounds check. The final
  message did not mention that five other call sites in `src/cli.js` read
  through that same helper. Re-applying the one-line change and calling
  `parseRootArg(['--root', ''])` returns `''` against `process.cwd()` on the
  unmodified file, so the widening is measured, not inferred. The fix is
  right; the blast radius went unreported.
- **t07 was confidently wrong on a number.** It reported the latest published
  eslint as `10.8.1`; `npm view eslint version` says `10.9.0`. The conclusion
  ("not the latest") held, the figure did not.

## Findings

### P0 — a successful run makes the next run impossible

`andrew-agent run` succeeds exactly once per install. Every later run exits 3
with `Runtime preparation failed.`

Codex appends a trust record to the managed config on its first session in a
repository and rewrites the file owner-only:

```log
58a59,61
>
> [projects."/Volumes/dongminyu/Development/01_personal/rn-typed-assets"]
> trust_level = "trusted"
```

That is the entire difference against the bundle's `config.toml`, along with
mode `0644` changing to `0600`. `verifyManagedState` fingerprints every
installed file, so a recorded file no longer matches and
`inspectInstallState` returns `MANAGED_STATE_DRIFT`. Doctor then reports
`ACTIVE_INSTALL`, `BUNDLE_DIGEST`, and `STRICT_CONFIG` as blockers, which is
indistinguishable from never having installed at all.

Fingerprinting all 57 recorded files by hand after these runs found exactly
one mismatch, and it was `config.toml` every time. That bounds this session
only: one repository, one turn shape, no approval traffic and no requested
capability. `verifyManagedState` throws on its first mismatch, so any file
Codex writes back on a path these runs never exercised would present as the
same single opaque failure.

The deterministic test layer cannot see this. It installs a bundle and
verifies it, but no test lets a real Codex write back into the managed home
between two runs.

Collecting the rest of this record required restoring `config.toml` from the
bundle before each run. That restore fired nine times across the eleven runs
that followed the first, which is the honest intervention count for this
session: without it, every one of those runs exits 3.

**There is no supported recovery.** Four paths were measured against a
drifted install, and only the last one works:

- Running again does not reinstall over the drift. Exit 3.
- Deleting `active-install.json` alone makes it worse. `installBundle` then
  refuses with `OWNERSHIP_CONFLICT: A candidate target is not owned by the
active install`, because the managed home holds files no active record
  claims. Exit 3.
- Deleting `codex-home` alone fails too, and fails differently.
  `installBundle` calls `verifyManagedState` against the surviving active
  record before it reinstalls, so every file the record names is now missing
  and the install throws `MANAGED_STATE_DRIFT`. Exit 3.
- Deleting **both** the active record and `codex-home`, then re-creating the
  directory, works. The next run installs cleanly and completes a turn — and
  then drifts again.

So the only way back is a wipe of both, and the order matters: wiping the
managed home while the record survives destroys `auth.json` without restoring
service. Recovering with authentication intact means copying `auth.json` out
and back by hand. None of this is in `README.md`, whose "Recovery" section
covers the install journal rather than this.

Whatever the fix is, it has to decide who owns `config.toml` after install.
Treating the file as immutable is incompatible with Codex writing project
trust into it.

### P1 — exit 3 explains nothing

Both preflight failures print one line and stop:

- `Runtime preparation failed.` for the drift above.
- `Repository preflight failed.` for a dirty target repository, whether the
  dirt is a modification or a single untracked file.

Neither names the cause, the check, or the file. `doctor` is the only way to
learn more, and even it says "The active installation is missing or invalid"
without naming `MANAGED_STATE_DRIFT` or `config.toml`. Diagnosing the P0
above meant reading `inspectInstallState` and calling it by hand.

The fail-closed behavior itself is correct and the cleanup around it holds:
no `run.lock` and no `install-journal.json` survived any failed or
interrupted run.

### P1 — the streaming renderer reprints the whole message per delta

A fifteen-second turn with one paragraph of answer produced 159 lines and
37 KB. 142 of those lines are two agent messages reprinted from the start on
every token:

```log
msg_… agentMessage started: `src/output.js`의 플래
msg_… agentMessage started: `src/output.js`의 플래그
msg_… agentMessage started: `src/output.js`의 플래그 파
```

Output grows with the square of message length. The deduplication in
`reportTurnState` compares whole rendered lines, so each longer prefix is a
new line and none of them are suppressed.

### P2 — the final message is escaped past readability

Terminal escaping renders every newline as a literal `\x0A`, so a multi-line
answer with a fenced code block arrives as one unbroken line. The escaping is
deliberate and should stay; what it produces still cannot be read.

### P2 — exit 0 does not mean the task was done

t04 answered with a design and the question "이대로 적용할까요?", changed no
file, and exited 0 with terminal status `completed`. `run` is a single turn,
so the question could only be answered through `resume <thread-id>`, which
worked and finished the task. Exit code alone cannot separate "done" from
"asked a question and stopped".

### P2 — exit 130 is nearly unreachable

`README.md` maps 130 to an interrupted turn. Measured against a running turn:

| Signal sent                  | Terminal status | Exit |
| ---------------------------- | --------------- | ---- |
| one `SIGINT`                 | `failed`        | 1    |
| two `SIGINT`, a second apart | `failed`        | 1    |
| three `SIGINT`, back to back | `interrupted`   | 130  |

The first `SIGINT` asks the server to interrupt the turn, and the turn settles
as `failed` before a later signal can settle it as `interrupted`. A person
pressing Ctrl-C once, or twice at human speed, gets an exit code and a status
identical to a genuine turn failure.

### P2 — the safety model does not mention the network

`README.md` "Approval and safety model" covers approvals only. The coordinator
also sets `networkAccess: false`, which is not documented, and that flag
bounds shell commands rather than the turn. t07 answered a registry question
through three `webSearch` items with no approval request and no shell command,
so a turn does reach the network. The rendered `webSearch` lines carry neither
the query nor the result, so the operator cannot see what was fetched.

### P3 — first-run documentation and packaging friction

- The sentence that gives Doctor's pre-install exit code lost it to a
  formatter: `README.md:100` now reads "and exits" followed by a list item
  `1. That is expected …`. The measured exit code is 1.
- `git clone ~/.codex ~/andrew-agent-source` copies 243 MB, of which 238 MB is
  `.git`, for a 5 MB working tree. The bundle only ever reads the checkout.
- The wrapper carries neither environment variable, so both must be exported
  in every shell that runs the agent. Forgetting `ANDREW_AGENT_CODEX_BIN` is a
  guaranteed Doctor blocker on this machine, where `PATH` resolves Codex
  `0.149.0` against a `0.148.0` pin.
- Command lines report the exit code but never the output, so a failing
  command shows that it failed and not why.

## What this suggests for the next change set

The P0 is the only finding that blocks use. It has no workaround an operator
could find without reading `install.ts`, so it is worth landing on its own,
reviewable against a reproduction rather than bundled with cosmetics.

The two P1s are what make the product unpleasant rather than unusable, and
both are small: name the failing check in the exit-3 message, and render
agent message deltas rather than accumulated prefixes.
