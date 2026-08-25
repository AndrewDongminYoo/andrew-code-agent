# The writable-root boundary assumes a toolchain that writes only in-repo

Found on 2026-08-25 while running the first v0.2 acceptance task against
`bubble_shooter`. The turn ended `failed` with no deliverable, and the cause is
a support boundary rather than a defect in the target repository.

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
existing tests. `flutter test` refreshes the Flutter SDK cache before running,
that cache is outside the repository, the write was denied, and the turn ended
there:

> Flutter가 작업공간 밖 SDK 캐시를 갱신하려다 샌드박스에서 막혔습니다.

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
lives inside the repository.** Few ecosystems satisfy that. A pre-populated
in-repo dependency tree can hide it, which is exactly what happened for two
runs.

## What is not being claimed

- That the boundary is wrong. Denying writes outside the repository is what
  keeps a turn's blast radius equal to the thing under version control, and
  widening it to `$HOME` would give a turn write access to credentials, shell
  configuration, and every other repository on the machine.
- That any specific ecosystem beyond Flutter fails. Only the Flutter case was
  observed. The table above says which caches exist here, not which commands
  would be denied.

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
