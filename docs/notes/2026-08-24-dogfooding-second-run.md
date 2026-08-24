# Second dogfooding run on rn-typed-assets

Run on 2026-08-24 against `rn-typed-assets` at `bdf066d` — the same target
revision as the first run — from `main` at `a795927`, to measure whether the
friction the first run recorded actually dropped.
`docs/notes/2026-08-22-dogfooding-rn-typed-assets.md` owns the original
findings and their evidence; this note only reports what moved and what did
not, and adds nothing to the product.

Four fixes had landed since: `#4` reset-before-run for the managed config,
`#5` owner-only config install, `#6` actionable exit-3 diagnostics, and `#7`
the renderer's streaming and truncation pair.

## Mode

Three task-shaped turns, seven deliberate failure probes, four `doctor`
invocations, and one invocation lost to a usage mistake: fifteen in total.
The mode is otherwise the first run's: stdin was not a terminal, the
coordinator's `networkAccess: false` and its `writableRoots` of the repository
root alone still applied — alongside the process temporary directory and
`/tmp`, which both stay writable because the two exclusion flags are false —
and authentication was the copied agent credential rather than an interactive
`codex login`.

The wrapper execs this repository's own `dist/cli.js`, so `pnpm build` ran on
`a795927` before the first turn; without that the run would have measured the
pre-fix product.
`~/andrew-agent-source` was left at `ba13069` rather than pulled, so the
bundle source is whatever it was on 2026-08-22 and is not a variable here.

## What moved

### P0 — a successful run no longer blocks the next

No invocation among the fifteen needed a `config.toml` restore, against nine
of the eleven that followed the first run's first.
`doctor` reported every check `ready` before the first turn and again after the
last, so no turn in this run left the managed state invalid.

The drift itself was reproduced deliberately rather than assumed gone: a
`[projects."<target>"] trust_level = "trusted"` block appended to the managed
`config.toml` by hand, reproduced from the diff the first run recorded rather
than from a live Codex write.
The next `run` completed at exit 0 and converged the file back to the
installed bytes — `diff` against a pre-drift copy is empty and the mode is
still `0600`. That is the direct test of `#4`, and the first run's blocking
finding does not survive it.

`doctor` disagrees with `run` on that state, though. Against the hand-drifted
file it reports `blocker STRICT_CONFIG`, because its strict-config shadow
validates the bytes on disk rather than the installed ones; a `run` issued from
exactly there succeeds. The verdict is not wrong about the file, but an
operator reading `blocker` would conclude the run is going to fail, and it does
not.

### P1 — the streaming renderer no longer reprints prefixes

Every agent message now renders exactly one line while in flight and its whole
text once on completion:

| Turn | Messages | In-flight lines | Log lines | Log bytes |
| ---- | -------- | --------------- | --------- | --------- |
| t01  | 2        | 2               | 31        | 5,791     |
| t02  | 2        | 2               | 45        | 9,096     |
| t03  | 3        | 3               | 47        | 8,677     |

The first run's t01 spent 142 of its 159 lines on two messages reprinted per
delta, at 37 KB.
The line and byte counts above are one sample each and the turn shapes differ,
so the checkable claim is categorical rather than a delta: no rendered line for
an item id is a strict prefix of a later line for the same id.
A script asserting exactly that passes on all three logs and fails on a
two-line fixture in the old shape, so the check can distinguish them.

### P1 — messages longer than the old cap arrive whole

`MAX_TEXT_LENGTH` is gone; the reducer bounds message text at 4,096 and the
renderer splits it into ordinal-tagged lines that each satisfy the same byte
bound as every other line.
The reducer's `bounded` slices on `value.length`, so its limit is UTF-16 code
units, and the figures below are re-derived in that unit from the unescaped
chunks rather than from the rendered bytes.
Both explain-shaped turns wrote a final message past the old 512 cap and
neither was cut:

| Turn | Final message (code units) | Chunks | `[truncated]` on the message |
| ---- | -------------------------- | ------ | ---------------------------- |
| t01  | 848                        | 4      | none                         |
| t02  | 1,074                      | 5      | none                         |

t02 was chosen to be the long-answer shape on purpose — a survey of every
`process.exit` site in `src/cli.js` with a table and a reason per row — because
a run of short turns would have passed this without exercising the fix.
Both answers end on a complete sentence.
Neither reached 4,096, so the new cap itself is still unexercised; t03's three
messages all stayed under 512 and say nothing about either cap.

### P1 — exit 3 now names the failing check

Every failure probe named its check code where the first run printed one
opaque line:

- An untracked file, and separately a modified file, in the target:
  `Repository preflight failed: GIT_WORKTREE_DIRTY.`, exit 3.
- A path that is not a repository:
  `Repository preflight failed: NOT_GIT_REPOSITORY.`, exit 3.
- Codex `0.149.1` against the `0.148.0` pin, exit 3:
  `Candidate readiness failed:` naming `CODEX_VERSION`,
  `SCHEMA_COMPATIBILITY`, and `STRICT_CONFIG`.

## What did not move

- **Newlines still render as literal `\x0A`.** Every multi-line answer arrives
  as one unbroken run per chunk. The escaping is right and the result is still
  not prose an operator reads comfortably. Recorded, not fixed.
- **`Command output:` is still truncated** at the ordinary rendered-value
  bound, which is a different cap from the message one and was not part of
  `#7`.
- **Exit 0 versus a question** was not re-observed: no turn this run asked one,
  so the first run's t04 finding stands untested rather than resolved.

## Residual friction

Two of the fifteen invocations were interventions rather than work, and neither
was the config restore that dominated the first run. Two further diagnostics
cost a second command each:

- **Every file-changing turn blocks the next one.** t03 left `src/output.js`
  modified and the immediately following run exited 3 with
  `GIT_WORKTREE_DIRTY`. The clean-worktree preflight is deliberate, so the
  intervention is a commit, stash, or revert per changing turn, and it is now
  the dominant one.
- **The dirty message names the check but not the file.** `git status` is a
  second command away, and on a large target it is the only way to learn which
  path is at fault.
- **A wrong Codex binary reports three codes where one is the cause.**
  `SCHEMA_COMPATIBILITY` and `STRICT_CONFIG` are consequences of
  `CODEX_VERSION`, and nothing in the line ranks them.
- **Argument order costs a round trip.** `run <repository> <prompt>` rejects a
  two-argument call with `Invalid command usage.` and exit 2, printing no
  usage; `--help` is a separate invocation. One of the fifteen invocations here
  was that mistake.

## One new observation

t01 spent its first shell command entirely inside the managed home, reading
`codex-home/plugins/cache/openai-curated-remote/superpowers/6.3.0/skills/using-superpowers/SKILL.md`,
and its second read more of that same tree before reaching `src/output.js`.
The bundle's own skill material is turn work the operator pays for and can see
in the log; whether that is worth its cost is a bundle-composition question,
not a defect, and this run only notes that it is visible.

## What this suggests

The three P1s the first run named are closed and the P0 with them, so the
product is usable in a way it was not on 2026-08-22.
What remains is P2-shaped and mostly presentational: the escaped newline is the
one that still costs the operator on every turn, and it is the only remaining
finding that touches the same terminal path `#7` already rewrote.
