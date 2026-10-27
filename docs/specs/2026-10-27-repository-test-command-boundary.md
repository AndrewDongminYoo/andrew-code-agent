# Repository Test Command Boundary

## Problem

No `andrew-agent` command runs a command that belongs to the target repository.
`docs/specs/2026-09-21-pr-command.md` lists running arbitrary repository checks as a non-goal.
A fix-verification command (issue #83) must run at least one test command twice: once without the production change and once with it.
Issue #82 asks the operator to set that boundary before any implementation.

## Decision

The operator decided this boundary on 2026-10-27.

The operator names the test command as a command argument.
Codex never chooses, infers, or changes the test command.
The command does not read a test command from the repository, from `agent-bundle.toml`, or from any other configuration file.

The test command runs only in an isolated temporary checkout.
It never runs in the source worktree, and the source worktree stays unchanged.
The test command runs with the network blocked.

Each run of the test command has a time limit and an output limit.

## Constraints added while drafting

These constraints were added when this spec was written, as fail-closed readings of the decision above.
The operator approved them with the spec, not as separate answers.

- When a run exceeds the time limit, the command stops the whole process group and reports the run as timed out, not as a pass or a failure of the test.
- When a run exceeds the output limit, the command stops the run and reports that the limit was exceeded.
- If the network block cannot be applied, the command refuses to run; it does not run the test command with network access.

## Consequences for the verification command

The implementation spec for issue #83 follows this boundary.
It sets the exact time and output limits.
It must state how the network block is applied on macOS and include a test that proves a network call from the test command fails.
