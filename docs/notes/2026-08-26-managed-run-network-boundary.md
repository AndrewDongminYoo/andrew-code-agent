# A managed run has no network, and it declines its own escalation

Date: 2026-08-26

Measured while preparing the v0.2 Oracle acceptance measurement, whose five tasks each name an issue the agent would otherwise have to fetch.
It records what a managed run can actually reach and the decision taken because of it.
The acceptance criteria in `docs/specs/2026-08-25-v0.2-oracle-acceptance.md` are fixed and are not touched by this note.

## What was run

One run against a throwaway Git repository, no capability, stdin from `/dev/null`, with the prompt asking for one command verbatim:

```bash
gh issue view 24 -R AndrewDongminYoo/andrew-code-agent --json title -q .title
```

## What happened

1. The agent ran the command as given. It exited 1 inside the sandbox, and the
   agent reported the cause as a blocked GitHub API connection.
1. The agent re-ran the same command with an escalation request. The approval
   reached the coordinator, and because stdin is not a terminal `safest()` answered `decline` without prompting.
1. The turn ended `completed`, with the agent reporting
   `error connecting to api.github.com` as the command's output.

## What it means

The block is the sandbox's network, not the command's interactivity.
`gh` runs non-interactively perfectly well, and `--json` with `--jq` changes nothing here because the failure happens before any output is formatted.

The execpolicy allowlist in the bundle source's `rules/default.rules` is a separate gate and grants no network.
Its five allowed prefixes include `gh pr view` and `gh pr diff`, so those clear execpolicy, but whether they survive the sandbox's network boundary in a managed run is unmeasured.
Do not read their presence in that file as evidence that they work here.

This is not a defect to fix in the product.
An approval that is declined without a terminal is the documented approval model, and a sandbox that withholds network from an agent running unattended is the point of it.

## The decision it forces

Every acceptance task names an issue, and the agent cannot fetch one.
So the prompt carries the issue text.

- The issue body is pasted into the prompt, identically for the control and the
  treatment run of that task, and the note recording the run says so.
- This does not weaken the specification's prompt rule. That rule forbids the
  prompt from naming the wiki, a page, or a prior decision; the task statement is not precedent.
  Three of the five issues state their own trap already, and the criteria for "demonstrably changed the direction" already refuse to count a treatment that merely restates the issue body.
- Decided before the first run rather than during it, because choosing how a
  task reaches the agent after seeing a run fail is how the instrument gets tuned instead of read.
