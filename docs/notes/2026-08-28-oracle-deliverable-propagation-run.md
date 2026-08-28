# Note: Oracle deliverable propagation rerun

Date: 2026-08-28

## Outcome

The Oracle deliverable propagation contract passes for GitHub issue #31.
All five treatment runs named at least one relevant Oracle precedent, cited a
source path returned by Oracle, and stated how the precedent changed or
confirmed the final direction.
The five control runs cited no Oracle wiki source in their final directions.

This result does not make the original v0.2 direction-change acceptance gate
pass.
The fixed-spec rerun produced relevant retrieval in 4 of 5 tasks and changed
the recommended direction in 1 of 5 tasks.
Only Task 3 changed direction, so the original threshold of 3 changed
directions remains unmet.

The full final directions and thread identifiers are recorded in the
[transcript](./2026-08-28-oracle-deliverable-propagation-transcripts.md).

## Change under test

The source bundle revision is `9db9d73948614390430dc848bd6fa8cca49bd8c4`.
The change adds only the final-deliverable requirements under
`## Consult the Oracle` in `AGENTS.md`.
The requirements tell the parent agent to identify each relevant precedent,
cite the returned source path, state its effect on the direction, mark
`[no precedent found]` when appropriate, and reject stale or irrelevant
precedent as authority.

The disabled candidate digest is `680ace582aa05cc34e2fb605777e1559a387e80b077183481e2a4a0eabaa57c7`.
Its metadata has no requested or enabled capabilities, and its rendered
`AGENTS.md` omits the Oracle section.

The enabled candidate digest is `6ceb760f4b0c29ff43a5eb220389e4c10106e44d7103fc714d9c69f5e94fa124`.
Its metadata requests and enables `oracle`, and its rendered `AGENTS.md`
retains the propagation contract and the portable `${LLM_WIKI_ROOT}/` token
without a machine-specific wiki root.

Both candidates identify source revision `9db9d73948614390430dc848bd6fa8cca49bd8c4`.
The Oracle wiki revision is `a35ae3feb98690ca30e9809f811a9354feb3af1a`.

## Fixed inputs

The rerun reused the five prompt blocks from
`docs/notes/2026-08-26-v0.2-oracle-acceptance-transcripts.md` byte for byte.
Each control and treatment pair used the same target checkout and prompt hash.

- Task 1 target: `7d9dd4f932357c41b1e0bf228728575e4a6c179d`.
- Task 1 prompt SHA-256: `29d4130e69f8301959bcfa073393a0112dcb822ab7e6bfcc06f8d56389b7f214`.
- Task 2 target: `77d4bebced909b6863d1dfcac6cf9131bba91494`.
- Task 2 prompt SHA-256: `907c3c815f537d42839f44e530f3c09b0b1c31ad5cd45248dbcb189fde60e6c8`.
- Task 3 target: `7d9dd4f932357c41b1e0bf228728575e4a6c179d`.
- Task 3 prompt SHA-256: `675521ee8080e404f0eeff439c6a808eb3c8f6453a3948b51de8fd4619026d77`.
- Task 4 target: `d491d92524d4fbd60067cc5f5f85f432dd75be49`.
- Task 4 prompt SHA-256: `f0f21d4e697ca663ec6187728dc9081fe1ef84089f75570cd935e840223ac4df`.
- Task 5 target: `558bffa539c26104b72f75df6a3ccd5ceba7af56`.
- Task 5 prompt SHA-256: `755dc7c0d322ccb287669acbae4a7ce715142138b365ad05aceea0db6945bbb2`.

All ten valid runs reached a completed terminal state.
The target revisions and worktree status were unchanged after each valid run.

## Contract result

### Task 1: bubble_shooter#43

The treatment cited three Oracle sources for the controller-owned high-score
boundary, detached SharedPreferences verification, and source-backed
evaluation.
It stated that the precedents confirmed controller ownership, restart-level
persistence checks, and the exclusion of widget-owned persistence.
The treatment direction matched the control direction, so the direction-change
score is false.

### Task 2: llm-wiki-dongminyu#9

The treatment cited `source-verified-output` and
`evidence-basis-discipline` for rejecting unchecked capability fallback and
requiring a negative verification.
It marked the environment example in `home-git-root-hazard` as stale instead
of using the example as authority.
The treatment direction matched the control direction, so the direction-change
score is false.

### Task 3: bubble_shooter#38

The treatment cited the UMP-owned conditional ATT precedent and the
injected-package seam precedent.
It also marked the UMP 9.0 completion-order detail as only partially verified
for the target's 9.1 dependency.
The control proposed a custom `MethodChannel` that owned ATT and disabled
UMP's IDFA flow, while the treatment kept ATT under the UMP flow and rejected
a new channel and package.
This is the only task whose recommendation changed.

### Task 4: andrew-code-agent#10

The treatment cited the project entity and the v0.2 acceptance memory, then
used them to keep readability changes separate from terminal escaping.
The sources support the observed symptoms and open issues, but they do not
directly establish that the existing escaping policy is correct.
The relevant-retrieval score is therefore false under the conservative
fixed-spec rule.
The treatment direction still matched the control direction: split structural
newlines and retain a 512-character command preview.

### Task 5: flutter_receipt_scanner#3

The treatment cited the evidence-basis rule and the recorded
Flutter-versus-React-Native port boundary.
It used those precedents to inspect the Dart merger directly and to require
Dart regressions before changing the seam contract.
It marked the exact false-positive versus false-negative seam asymmetry as
`[no precedent found]` and based that new decision on the target repository's
specification and tests.
The treatment direction matched the control direction, so the direction-change
score is false.

## Stale precedent check

The Oracle source states that each platform package owns a
`pigeons/messages.dart` file.
The fixed Task 5 checkout contains only the repository-root
`pigeons/messages.dart` file.
Its root `pubspec.yaml` runs Pigeon from that path and describes the output as
the shared Pigeon message contract.
The treatment identified the port detail as stale and did not use it as
authority for the recommendation.

## Sensitive-output boundary

The fixed Oracle wiki checkout and the live wiki root contain no file marked
`sensitive: true` in the checked tracked and working-tree content.
The leak-scan sample is therefore `[PARTIAL] 0/0`.
A fail-first leak test could not be demonstrated from this fixture, so this is
a boundary rather than a pass for output redaction.
GitHub issue #25 remains outside this change.

## Invalid Task 5 attempt

The first Task 5 runner extracted the prompt at the first closing fence instead
of the final fence before the control heading.
That truncated the prompt from 5,189 characters to 1,132 characters and
omitted its read-only instruction.
The control agent then modified 12 files in the isolated temporary target.

That attempt is excluded from the measurement.
The extraction rule was corrected to use the last closing fence, and Task 5
was rerun from a separate clean checkout at the same revision and prompt hash.
The original target repository was not modified.
The invalid temporary target remains preserved for diagnosis.

## Verification

- `trunk check` for the two new note files passed.
- `pnpm check` passed type checking and all four test layers.
- Unit tests passed 127 of 127.
- Integration tests passed 277 with 1 skip.
- Contract tests passed 90 with 1 skip.
- End-to-end tests passed 12 with 2 live-smoke skips.
- `trunk check --all --no-fix` passed all 1,034 checked product files.
- `trunk check AGENTS.md --no-fix` passed in the bundle source.
- `git diff --check HEAD^ HEAD -- AGENTS.md` passed in the bundle source.

The bundle source's full `trunk check --all --no-fix` did not pass.
It reported 21 low-severity ShellCheck findings in six existing scripts.
The bundle commit changes only `AGENTS.md`, and none of the reported scripts
differs from its parent revision.
Those findings are pre-existing gate debt and were not changed in this work.
