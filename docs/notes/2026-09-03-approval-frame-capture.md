# Capturing an approval request from the pinned binary

Closed record of the capture on 2026-09-03.
It answers one question: what does `codex-cli 0.152.1` actually send on `item/commandExecution/requestApproval`, as opposed to what the generated contract declares.

## Why the hand-written fixture was blind

`test/fixtures/protocol/approval-requests.jsonl` was written by hand at the `0.148.0` pin and never refreshed when the pin moved.
That, not any gap in the schema, is why the deterministic layer saw nothing when `0.152.1` began sending `kind`: `schemas/codex-app-server/CommandExecutionRequestApprovalParams.json` declares `kind` with `"default": "command"`, and `0dc84ea` added that declaration in the same commit that raised the pin.

A first draft of this note claimed the opposite — that a fixture written from the schema cannot carry a field the schema omits.
It is recorded here because it is wrong and would otherwise be cited.
Reading the regenerated types is not a discredited method: the sibling `openaiForm` elicitation mode arrived in the same bump, was found exactly that way, and is handled in `src/app-server/approvals.ts`.

`availableDecisions` is the one field the binary sends that its own schema export does not declare, measured on 2026-08-26 and unchanged at this pin.
So the honest reason to capture rather than synthesize is narrow: a synthesized frame records what the schema says, and for at least one field the schema and the wire disagree.

## Method

`app-server --strict-config --stdio` was spawned directly and the protocol spoken to it, because wrapping the binary in a pipeline adds a process to its group and fails doctor's residual-descendant check.
Raw stdout lines were appended verbatim before any parse, so a field the generated types do not declare survives into the record.

The conversation mirrored the product's own, read from `client.ts` and `coordinator.ts` rather than invented: `initialize` with the product's `clientInfo` and capabilities, `initialized`, then `thread/start` with `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, `sandbox: "workspace-write"`, then `turn/start` with the coordinator's `workspaceWrite` policy — the target repository as the only writable root and `networkAccess: false`.

Environment: the pinned `0.152.1` binary, the operator's already-authenticated managed `codex-home`, and a throwaway git repository holding one file.
Every approval was answered `decline`, and the declined write was confirmed absent afterwards.

## What the binary sent

`test/fixtures/protocol/approval-requests.observed.jsonl` holds the frame verbatim except for `cwd`, which was a session-scoped scratch path and is replaced by `/repo`.
Nothing else was edited.

Seven fields differ from the hand-written frame.
Every one is a difference in values the schema already permits, except `availableDecisions`:

| Field                             | Hand-written        | Observed      |
| --------------------------------- | ------------------- | ------------- |
| `kind`                            | absent              | `"command"`   |
| `availableDecisions`              | absent              | three entries |
| `environmentId`                   | `null`              | `"local"`     |
| `commandActions`                  | `[]`                | one entry     |
| `proposedExecpolicyAmendment`     | `null`              | nine tokens   |
| `proposedNetworkPolicyAmendments` | one entry           | key absent    |
| `id`                              | `"request-command"` | `0`, a number |

`availableDecisions` held `accept`, an `acceptWithExecpolicyAmendment` object, and `cancel`; `commandActions` held one `{ type: "unknown", command }`.

`command` arrives already wrapped in the login shell (`/bin/zsh -lc '...'`) while `commandActions[].command` carries the bare command, and `reason` is written in the operator's language.
Korean is not itself an escaping case — `escapeTerminalControls` matches only `Cc/Cf/Zl/Zp` — so what the frame exercises is that multi-byte text passes through unmangled and that per-code-point byte accounting does not false-trip a bound.

## What the capture revealed that nobody had acted on

The server proposed an execpolicy amendment, supplied its nine-token payload, and advertised `acceptWithExecpolicyAmendment` among the decisions it would accept.
The product offered none of it: `validCommandParams` validated `proposedExecpolicyAmendment` and nothing read it, while `choices()` built extra options only from `proposedNetworkPolicyAmendments`, which this frame does not carry.
The prompt did not render the field either, so the amendment was invisible as well as unreachable.

Filed as issue #53 and closed in the same branch.
`choices()` now offers the amendment when the field is present and non-empty, and the prompt renders the argv it would grant.
`availableDecisions` is still not consulted, because it is undeclared by the schema this build is pinned to and was measured advisory rather than binding.

**The grant is not request-scoped, and a first draft said it was.** The generated params type documents `proposedExecpolicyAmendment` as allowing similar commands _without prompting_, so accepting it changes policy for later commands.
`acceptedForSession: false` does not constrain that: nothing outside `approvals.ts` reads the flag, and the coordinator forwards `response` alone.
The label now states the scope, because the prompt is the only place the operator learns it.

The network amendment beside it has the same undisclosed forward scope — its own doc says "for future requests" — and its label is unchanged here.
Its label already runs to 97 bytes against a 96-byte budget with a 64-byte host, so appending a scope clause would make a long-host request refuse rather than prompt.
Worth fixing, not by appending.

Displaying the argv took two corrections, both of the same shape: the operator would have authorized something other than what was shown.

The first draft sliced the tokens to `MAX_APPROVAL_LIST_ITEMS`, displaying `curl -sS --max-time 20 -D - -o /dev/null` while the response carried that plus `https://example.com`.
`bounded()` marks a byte truncation; a token slice drops the tail in silence.
The second joined the tokens on a space, which erases the argument boundaries: `["bash", "-c", "echo safe"]` and `["bash", "-c", "echo", "safe"]` rendered identically, and `["rm", "", "-rf"]` rendered as `rm  -rf` with the empty argument invisible.
Both were measured, not reasoned about, and the second was caught by review rather than by me.

The line now carries `JSON.stringify` of the argv.
A third correction followed, also caught by review: claiming the byte bound behaved "like the `command` line" was false.
Every other displayed field is gated by `hasCompletePromptContext`, which refuses the whole request when a field would not render whole — a 300-byte `command` declines with no prompt at all — and `proposedExecpolicyAmendment` was not in that gate.
Measured before the fix: a 300-byte argv rendered cut and granted in full.
It is gated now, so an amendment too long to display is refused rather than truncated, which also bounds an array that had no count limit.

The contract test asserts the exact rendered string, that two argvs differing only in token boundaries render differently, and that an over-long argv is declined without a prompt.

That advertised set is advisory rather than binding, measured on 2026-08-26 when the server honoured a `decline` it had not advertised.

## What was not captured, and why

`[PARTIAL]` — one of the four request kinds in the hand-written fixture.

- **`item/fileChange/requestApproval`** did not fire in two attempts. Asking
  for a file outside the writable root produced a second `item/commandExecution/requestApproval` instead: the agent routed the write through a shell redirect, so the command path is what needed approval.
  Two attempts measure those two attempts and nothing more; whether any product turn reaches the file-change path is unmeasured.
- **`item/permissions/requestApproval`** needs an escalation this turn shape
  does not produce.
- **`mcpServer/elicitation/request`** needs an MCP server that elicits.
  `prepareCandidate` passes `requestedCapabilities: []`, so no such server is configured in a v0.1 run.

The hand-written fixture keeps all four and keeps its stable values, because `test/contract/approvals.test.mjs` asserts on them and `writeApprovalScript` replays its first line through the fake server.
The observed frame is an addition, not a replacement.
