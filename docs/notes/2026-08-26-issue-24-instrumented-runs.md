# Issue #24: two instrumented runs name the fail-closed call sites

Closed record of the instrumented reproduction on 2026-08-26. Issue #24 asked
which `failClosed()` call site interrupts a real turn and said to record what
the coordinator received rather than infer it. Two runs answered it, and they
answered it twice: the two aborted runs of 2026-08-25/26 had two different
causes, not one.

## Method

A temporary diagnostic sink appended one JSON line per event to the path in
`ANDREW_AGENT_DIAGNOSTIC_LOG`, from every `failClosed()` call site, from
`interruptActiveTurn`, and from every notification (method, `params.threadId`,
`params.turnId`, against the coordinator's own pair). The instrumentation is
not part of the runtime contract and was reverted after the reading.

Both runs targeted `bubble_shooter` at `7d9dd4f` with a clean worktree, from
the bundle source at `ba13069`, on the pinned `codex 0.148.0`.

The prompts were written for this diagnosis and are not a revision of the
acceptance prompt in `docs/specs/2026-08-25-v0.2-oracle-acceptance.md`. That
spec's criteria are untouched.

## D1 — a sub-agent's thread notifications reach the parent's coordinator

Run: `run --capability oracle`, prompt asking for an Oracle precedent lookup.
Interrupted after the Oracle subagent started, as in the 26-second abort.

The App Server multiplexes the sub-agent's thread over the same stdio
connection. Four cross-thread notification kinds arrived on the parent's
connection during that run:

| Method                            | Cross-thread | Outcome                 |
| --------------------------------- | ------------ | ----------------------- |
| `thread/status/changed`           | 2            | unknown method, ignored |
| `mcpServer/startupStatus/updated` | 2            | unknown method, ignored |
| `turn/started`                    | 1            | **rejected**            |
| `item/started`                    | 1            | **rejected**            |

`turn/started` and `item/started` are known methods, so they reach the
`params.threadId !== state.threadId` check (`reducer.ts:849` and
`requireIdentity` at `reducer.ts:311`) and throw `INVALID_SERVER_EVENT`. The
catch in `processNotification` calls `failClosed()` — **call site
`coordinator.ts:484`**, the widest of the eight — which interrupts the parent
turn.

The rejected frame, verbatim from the sink:

```json
{
  "method": "turn/started",
  "params": {
    "threadId": "01a03ad8-b520-7a82-80b2-894a40e568f3",
    "turn": {
      "id": "01a03ad8-b566-7d60-a2bc-a7a0825fbc76",
      "items": [],
      "itemsView": "notLoaded",
      "status": "inProgress"
    }
  }
}
```

The coordinator's own pair was
`01a03ad8-64ef-7cb3-ac28-104161039210` / `01a03ad8-65e7-7561-8325-416280c3403d`.

This is why the Oracle has never returned anything: every Oracle run dies
within milliseconds of the subagent's first notification.

## D2 — the real approval request carries a field the pinned schema does not

Run: no capability, prompt asking for the existing `test/game/` Flutter tests.
The agent re-issued the command with an escalation request, as in the
211-second abort.

`item/commandExecution/requestApproval` arrived with an `availableDecisions`
field. `validCommandParams` in `approvals.ts` closes its parameter set with
`hasOnlyKeys` over the thirteen keys the generated schema declares, so the
extra field makes the whole request `MALFORMED_APPROVAL_REQUEST` and the
coordinator fails closed at **call site `coordinator.ts:520`** before it ever
prompts. The 18 milliseconds between the request and `aborted by user` in the
211-second run of 2026-08-25 is that synchronous rejection: no prompt was ever
written, so the approval timeout and the interrupt latch are both eliminated
as well.

```json
"availableDecisions": [
  "accept",
  {
    "acceptWithExecpolicyAmendment": {
      "execpolicy_amendment": ["flutter", "test"]
    }
  },
  "cancel"
]
```

`schemas/codex-app-server/ServerRequest.json` declares exactly the thirteen
keys the validator allows, so the validator matches its schema and the schema
does not match the binary it is pinned to. Comparing them statically clears
nothing, which is the same shape as the `itemsView` divergence measured on
2026-08-22.

## D3 — an interrupted turn's terminal notification is rejected

Both runs also logged this, on the parent's own thread:

```json
{
  "method": "turn/completed",
  "params": { "turn": { "itemsView": "notLoaded", "status": "interrupted" } }
}
```

`reducer.ts:725` accepts `itemsView` only as `"full"` or `"summary"`, so the
server's terminal report is thrown away and the turn settles on the interrupt
grace timer instead.

This one is not a gap. `test/contract/reducer.test.mjs` carries the case
"still rejects a completion whose items were never loaded", whose message
reads "notLoaded carries no observed inventory and stays fail-closed", so the
rejection was chosen. What the runs add is the consequence: `notLoaded` is
what an **interrupted** turn's `turn/completed` actually carries, so the
choice costs the coordinator the server's own terminal report on every
interrupt, including one the operator asks for.

Both captures reached it with `fatalFailure` already set, where `settle()`
resolves `"failed"` regardless. So D3 changes no reported status until D1 and
D2 are closed; it becomes observable on a genuine interrupt after that.

## What the approval vocabulary adds to D2

`availableDecisions` is not only an unexpected key, it advertises which
decisions the server will accept for that one request, and the captured list
was `accept`, `acceptWithExecpolicyAmendment`, `cancel`. The product's
`choices()` offers `accept`, `acceptForSession`, `decline`,
`applyNetworkPolicyAmendment` and `cancel`, and `safest()` answers `decline`.
Every one of those is in the schema's `CommandExecutionApprovalDecision`
union, so nothing the product sends is invalid in general — but `decline`,
which is what it sends when it declines, was absent from what this request
advertised.

So allowing the key alone may move the failure one step later rather than
close it, to `client.respond` and `coordinator.ts:537`. Whether
`availableDecisions` is advisory or binding is unmeasured `[UNCERTAIN]`, and
it decides how much of D2's fix is needed.

## D1 verified against a real run

`98403bf`, merged to `main` as #26, drops a frame naming another thread at the
top of `reduceServerMessage`. The same Oracle prompt was then re-run with the
notification tally still instrumented.

- `Terminal status: completed`. The Oracle returned precedent for the first
  time, which is what "the adapter is reached" never reached before.
- 1,538 notifications arrived on the parent's connection, and **1,191 of them
  named the sub-agent's thread** across nine methods, `item/agentMessage/delta`
  alone accounting for 1,064. All were dropped and none reached an identity
  check.
- No `failClosed()` call site fired, and `interruptActiveTurn` was never
  entered.

The four cross-thread frames counted in D1 above were not the stream. They
were the first four, because the turn died on the fourth.

D2 stays open: this run's subagent needed no escalated command, so nothing
reached `coordinator.ts:520`. A control run that runs the project's tests
still dies there.

## What this does not say

The three findings name what the coordinator received. None of them is a fix.
All three sit on fail-closed behaviour the repository chose deliberately —
D2 and D3 with a test that states the choice — so each is a product-contract
decision rather than a defect to patch quietly.
