# The writable-root boundary assumes a toolchain that writes only in-repo

Written on 2026-08-25 while running the first v0.2 acceptance task against
`bubble_shooter`, and corrected the next day. The turn ended `failed` with no
deliverable; the boundary described here was blamed for that and did not cause
it. What survives is the boundary itself, read from the code, and a measurement
of which caches sit outside it.

**Superseded in two places, 2026-09-02.** This note counts the process
temporary directory as a writable root alongside `/tmp`; it is not one, because
the App Server child is started without `TMPDIR`. And it says no denied write
has ever been observed, which a synthetic measurement has since disproved. Both
are recorded in `2026-09-02-sandbox-boundary-measurement.md`, and `README.md`
owns the current statement of the boundary. This note is a dated record and is
not edited toward the present; read the two claims below in that light.

## What happens

`src/app-server/coordinator.ts:603` starts every turn under:

```text
sandboxPolicy: workspaceWrite
  writableRoots: [repositoryRoot]
  networkAccess: false
  excludeTmpdirEnvVar: false
  excludeSlashTmp: false
```

So a turn may write inside the target repository, the process temporary
directory, and `/tmp`. Everything else is denied, including everything under
`$HOME` and any shared SDK root.

The agent traced the defect correctly and then tried to confirm it against the
existing tests, reporting that it had been blocked:

> Flutter가 작업공간 밖 SDK 캐시를 갱신하려다 샌드박스에서 막혔습니다.

**That report was taken at face value and it should not have been.** The Codex
session log for that turn records the command's own outcome as
`aborted by user after 0.1s`, and the turn as
`turn_aborted, reason: interrupted`. The "user" there is this product's
coordinator, which interrupted the turn; the agent's message was written before
that and describes what it expected, not what the sandbox returned.

**So it is not established that the sandbox refused anything.** Whether
`flutter test` is denied under this policy is now an open question, and the
cause of the interrupt is tracked separately.

Nothing was written to the target; `Final Git status` was empty and the
worktree stayed clean.

## Why the first two dogfooding runs never saw it

Both ran against `rn-typed-assets`, a TypeScript repository whose
`node_modules` was already installed. `npm test` ran fine inside the sandbox
and the 2026-08-22 note records the agent recovering from a failing `npm test`
without help — jest writes inside the repository, so nothing crossed the
boundary.

That is a property of that repository at that moment, not of Node. A `pnpm
install` in the same repository would have written to the store below.

## This is not Flutter-specific

Measured on this machine, outside any repository:

| Path                                               | Size |
| -------------------------------------------------- | ---- |
| `/Volumes/dongminyu/Development/flutter/bin/cache` | 3.4G |
| `~/.cargo/registry`                                | 1.3G |
| `~/Library/pnpm/store`                             | 387M |
| `~/.rbenv`                                         | 263M |
| `~/.pub-cache`                                     | 4.0K |
| `~/Library/Developer/Xcode/DerivedData`            | 0B   |
| `~/.m2`                                            | 0B   |

`~/.gradle`, `~/.cache/pip` and `~/go/pkg/mod` are absent here, so nothing is
claimed about them.

The general shape: **the policy assumes a toolchain whose entire mutable state
lives inside the repository.** Few ecosystems satisfy that, and a pre-populated
in-repo dependency tree would hide it.

That is a reading of the policy, not an observation. **No toolchain has been
seen failing this way**, including Flutter — the run that looked like one was
interrupted by the coordinator, as the section above records.

## What is not being claimed

- That the boundary is wrong. Denying writes outside the repository is what
  keeps a turn's blast radius equal to the thing under version control, and
  widening it to `$HOME` would give a turn write access to credentials, shell
  configuration, and every other repository on the machine.
- That any ecosystem fails, Flutter included. **No denied write has been
  observed at all.** The table above says which caches exist on one machine,
  not which commands would be refused.

## What this note still supports

The policy quoted above is read from the code and is not in doubt: a turn may
write in the repository, the process temporary directory, and `/tmp`, and
nowhere else. The caches below do sit outside all three.

What is no longer supported is the claim that this was observed stopping a real
turn. That observation was a misreading, and the note keeps the boundary
description while withdrawing the incident.

## Effect on the acceptance measurement

Three of the five tasks in
`docs/specs/2026-08-25-v0.2-oracle-acceptance.md` target Flutter repositories.
The failure would reproduce in both the control and the treatment run, so the
two would differ in where they stopped rather than in what precedent did, and
the comparison would measure nothing.

The measurement therefore constrains its prompts to read-only commands and asks
for a design direction rather than a verified fix. That is a narrower task, and
it is the honest one: what is being measured is whether precedent changes a
decision, not whether the agent can run a test suite.

## Options, none taken here

Recorded so the next session does not re-derive them:

- **A per-run allowance for named paths.** Precise, and it means an operator
  choosing to widen the boundary states which path and why. It also adds a
  surface where a manifest could quietly grant `$HOME`.
- **A pre-warm step outside the turn.** Run the toolchain's cache-populating
  command before the sandbox starts, so the turn finds a warm cache and never
  needs to write outside. Keeps the boundary intact; needs per-ecosystem
  knowledge the product does not have today.
- **Leave it and document the boundary**, which is what happens now.
