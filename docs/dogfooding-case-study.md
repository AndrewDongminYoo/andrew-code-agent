# Case study: two dogfooding runs

The agent was used to do real work on a real repository twice, on the same target revision, with the fixes from the first run landed in between.
Both runs used the real Codex rather than a fixture.
The numbers below are from those runs; the target repository and the operating environment are not described here on purpose.

## First run

Fifteen invocations in the mode the tool is actually used in: a non-interactive terminal, network access off, the target repository as the only writable root beyond the process temporary directory.

Four defects, ranked by what they cost:

**P0 — a successful run blocked the next one.** Codex rewrites the configuration file it owns during a turn.
The installer treated every installed file as immutable, so the next run's drift check refused to proceed against state the previous run had legitimately produced.
Nine of the eleven invocations after the first needed a manual restore before they could start.

**P1 — streaming output grew quadratically.** The renderer emitted the whole accumulated message on every delta, so one turn spent 142 of its 159 lines reprinting two messages, at 37 KB.

**P1 — long messages were truncated.** A fixed cap cut answers mid-sentence.

**P1 — preflight failures were one opaque line.** Exit 3 with no indication of which check had failed or what to do about it.

## What changed

- Installed files gained a lifecycle class.
  The single file Codex owns is classified `reset-before-run` and converged before each install; everything else stays immutable and still blocks on drift.
  The distinction is what makes both properties hold at once.
- The renderer emits one line per item while in flight and the whole text once on completion, split into ordinal-tagged chunks that each satisfy the same byte bound as every other line.
- The message cap was replaced by a chunked path, so a long answer arrives whole rather than cut.
- Preflight and readiness failures now name their check code.

## Second run

Fifteen invocations again, same target revision: three task-shaped turns, seven deliberate failure probes, four diagnostic invocations, and one lost to a usage mistake.

- **No invocation needed a configuration restore**, against nine of eleven before.
  The state that had blocked the first run was present throughout and was converged automatically.
- **No rendered line for an item was a strict prefix of a later line for the same item** — a categorical check that passes on all three turn logs and fails on a two-line fixture in the old shape, so it can tell them apart.
- **Two answers exceeded the old cap and neither was cut**, at 848 and 1,074 code units.
- **Every failure probe named its check**: a dirty worktree, a path that is not a repository, and a Codex version that does not match the pin.

## What the second run did not fix

Recorded rather than closed, because they cost readability and diagnosis rather than correctness:

- Newlines still render as a visible escape, so multi-line answers arrive as one unbroken run per chunk.
- Command output takes a different, smaller cap than message text.
- A malformed managed configuration is reported without the line, column, or reason the underlying binary printed.
- A wrong Codex version reports three check codes where one is the cause.

## What the exercise was worth

The P0 is the one that justifies the method.
It is invisible to a single run and invisible to a test suite that builds its own state each time; it only appears when a real run's output becomes the next real run's input.
Every fix above was then covered by a deterministic gate, and the two properties that need a real Codex — that it accepts the installed configuration, and that a second run survives the rewrite the first one caused — are covered by opt-in live gates that skip with a printed notice when their environment is absent.
