# Second dogfooding run on rn-typed-assets

Run on 2026-08-24 against `rn-typed-assets` at `bdf066d` — the same target revision as the first run — from `main` at `a795927`, to measure whether the friction the first run recorded actually dropped.
`docs/notes/2026-08-22-dogfooding-rn-typed-assets.md` owns the original findings and their evidence; this note only reports what moved and what did not, and adds nothing to the product.

Four fixes had landed since: `#4` reset-before-run for the managed config, `#5` owner-only config install, `#6` actionable exit-3 diagnostics, and `#7` the renderer's streaming and truncation pair.

## Mode

Three task-shaped turns, seven deliberate failure probes, four `doctor` invocations, and one invocation lost to a usage mistake: fifteen in total.
The mode is otherwise the first run's: stdin was not a terminal, the coordinator's `networkAccess: false` and its `writableRoots` of the repository root alone still applied — alongside the process temporary directory and `/tmp`, which both stay writable because the two exclusion flags are false — and authentication was the copied agent credential rather than an interactive `codex login`.

The wrapper execs this repository's own `dist/cli.js`, so `pnpm build` ran on `a795927` before the first turn; without that the run would have measured the pre-fix product.
`~/andrew-agent-source` was left at `ba13069` rather than pulled, so the bundle source is whatever it was on 2026-08-22 and is not a variable here.

## What moved

### P0 — a successful run no longer blocks the next

No invocation among the fifteen needed a `config.toml` restore, against nine of the eleven that followed the first run's first.

The state that blocked the first run is present throughout: after every turn the managed `config.toml` ends with Codex's own `[projects."<target>"] trust_level = "trusted"` block at mode `0600`, and the next run starts from exactly there and succeeds, because `#4` classifies that file `reset-before-run` and converges it before each install.
`doctor` was run against exactly that state at the end — the trust block read off the file first, then every check `ready` — so doctor and `run` agree on it.

A deliberate attempt to reproduce the drift by hand missed the shape and is worth recording for what it did find instead.
Appending a second copy of the trust block produced a duplicate TOML key rather than the first run's drift, and `codex app-server --strict-config` rejects that file with `config.toml:63:11: duplicate key` and a parse error naming the line.
Doctor reduces the whole of that to `blocker STRICT_CONFIG: Strict Codex configuration validation failed.` — the check spawns the real Codex against a shadow copy and reads only its exit code, and `classifyStrictConfig` discards the child's output on purpose (`src/commands/doctor.ts:920`).
So an operator with a genuinely malformed managed config gets no line, no column, and no reason, while the binary underneath printed all three.
`run` from that same file still succeeded at exit 0, since the reset replaced it before the turn started.

### P1 — the streaming renderer no longer reprints prefixes

Every agent message now renders exactly one line while in flight and its whole text once on completion:

| Turn | Messages | In-flight lines | Log lines | Log bytes |
| ---- | -------- | --------------- | --------- | --------- |
| t01  | 2        | 2               | 31        | 5,791     |
| t02  | 2        | 2               | 45        | 9,096     |
| t03  | 3        | 3               | 47        | 8,677     |

The first run's t01 spent 142 of its 159 lines on two messages reprinted per delta, at 37 KB.
The line and byte counts above are one sample each and the turn shapes differ, so the checkable claim is categorical rather than a delta: no rendered line for an item id is a strict prefix of a later line for the same id.
The check below passes on all three logs and fails on a two-line fixture in the old shape, so it can distinguish them:

```js
// Fails if any rendered line for an item id is a strict prefix of a later
// line for the same id: the shape the per-delta reprint produced.
const byId = new Map();
let violations = 0;
for (const line of readFileSync(path, "utf8").split("\n")) {
  const id = line.split(" ")[0];
  if (!/^(msg_|rs_|exec-)/.test(id)) continue;
  const seen = byId.get(id) ?? [];
  for (const earlier of seen)
    if (line !== earlier && line.startsWith(earlier)) {
      console.log(`prefix reprint on ${id}`);
      violations += 1;
    }
  seen.push(line);
  byId.set(id, seen);
}
process.exit(violations === 0 ? 0 : 1);
```

What one turn looks like now, from `t01`:

```log
msg_08c3…4362 agentMessage started: Message updated
msg_08c3…4362 agentMessage completed [1/4]: `--output`은 `text`와 `json` 두 형식만
msg_08c3…4362 agentMessage completed [2/4]: 아니면 `Unsupported output format:
```

The first line is the whole of what the turn printed while that message streamed.

### P1 — messages longer than the old cap arrive whole

`MAX_TEXT_LENGTH` is gone; the reducer bounds message text at 4,096 and the renderer splits it into ordinal-tagged lines that each satisfy the same byte bound as every other line.
The reducer's `bounded` slices on `value.length`, and so did the one that carried `MAX_TEXT_LENGTH` before `#7` (`git show 62421e3^:…/reducer.ts:133`), so both caps are UTF-16 code units and the figures below are re-derived in that unit from the unescaped chunks rather than from the rendered bytes.
Both explain-shaped turns wrote a final message past the old 512 cap and neither was cut:

| Turn | Final message (code units) | Chunks | `[truncated]` on the message |
| ---- | -------------------------- | ------ | ---------------------------- |
| t01  | 848                        | 4      | none                         |
| t02  | 1,074                      | 5      | none                         |

Both figures come from reassembling each id's `agentMessage completed` chunks, undoing the `\xNN` escaping, and taking `.length` — the same unit `bounded` slices on:

```js
const raw = chunks
  .join("")
  .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
console.log(raw.length);
```

t02 was chosen to be the long-answer shape on purpose — a survey of every `process.exit` site in `src/cli.js` with a table and a reason per row — because a run of short turns would have passed this without exercising the fix.
Both answers end on a complete sentence.
Neither reached 4,096, so the new cap itself is still unexercised; t03's three messages all stayed under 512 and say nothing about either cap.

### P1 — exit 3 now names the failing check

Every failure probe named its check code where the first run printed one opaque line:

- An untracked file, and separately a modified file, in the target:
  `Repository preflight failed: GIT_WORKTREE_DIRTY.`, exit 3.
- A path that is not a repository:
  `Repository preflight failed: NOT_GIT_REPOSITORY.`, exit 3.
- Codex `0.149.1` against the `0.148.0` pin, exit 3:
  `Candidate readiness failed:` naming `CODEX_VERSION`, `SCHEMA_COMPATIBILITY`, and `STRICT_CONFIG`.

## What did not move

- **Newlines still render as literal `\x0A`.** Every multi-line answer arrives
  as one unbroken run per chunk.
  The escaping is right and the result is still not prose an operator reads comfortably.
  Recorded, not fixed.
- **`Command output:` is still truncated** at the ordinary rendered-value
  bound, which is a different cap from the message one and was not part of `#7`.
- **Exit 0 versus a question** was not re-observed: no turn this run asked one,
  so the first run's t04 finding stands untested rather than resolved.

## Residual friction

Two of the fifteen invocations were interventions rather than work, and neither was the config restore that dominated the first run.
Two further diagnostics cost a second command each:

- **Every file-changing turn blocks the next one.** t03 left `src/output.js`
  modified and the immediately following run exited 3 with `GIT_WORKTREE_DIRTY`.
  The clean-worktree preflight is deliberate, so the intervention is a commit, stash, or revert per changing turn, and it is now the dominant one.
- **The dirty message names the check but not the file.** `git status` is a
  second command away, and on a large target it is the only way to learn which path is at fault.
- **A wrong Codex binary reports three codes where one is the cause.**
  `SCHEMA_COMPATIBILITY` and `STRICT_CONFIG` are consequences of `CODEX_VERSION`, and nothing in the line ranks them.
- **Argument order costs a round trip.** `run <repository> <prompt>` rejects a
  two-argument call with `Invalid command usage.` and exit 2, printing no usage; `--help` is a separate invocation.
  One of the fifteen invocations here was that mistake.

## One new observation

t01 spent its first shell command entirely inside the managed home, reading `codex-home/plugins/cache/openai-curated-remote/superpowers/6.3.0/skills/using-superpowers/SKILL.md`, and its second read more of that same tree before reaching `src/output.js`.
The bundle's own skill material is turn work the operator pays for and can see in the log; whether that is worth its cost is a bundle-composition question, not a defect, and this run only notes that it is visible.

## What this suggests

The three P1s the first run named are closed and the P0 with them, so the product is usable in a way it was not on 2026-08-22.
What remains is P2-shaped and mostly presentational: the escaped newline is the one that still costs the operator on every turn, and it is the only remaining finding that touches the same terminal path `#7` already rewrote.
