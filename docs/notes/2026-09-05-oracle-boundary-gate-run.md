# Oracle boundary gate run

This note records the live synthetic-vault gate for issue #25.
The run used `codex-cli 0.152.1` and Oracle provider commit `354e7d0853389c15f69af10090e557ddd4caa95b`.
The fixture did not read the operator's wiki pages.

## Command

The operator ran this command with the local placeholders resolved:

```bash
ANDREW_AGENT_REAL_SMOKE=1 \
ANDREW_AGENT_SMOKE_AUTH="<dedicated-smoke-credential>" \
ANDREW_AGENT_SMOKE_CODEX_BIN="<pinned-codex>" \
ANDREW_AGENT_WIKI_SERVER_ROOT="<wiki-provider-root>" \
node --test test/e2e/oracle-boundary.test.mjs
```

The test process exited successfully.
Both real CLI turns returned exit code 0.
The test summary reported 8 passed, 0 failed, and 0 skipped.

## Filtered run

The vault source commit was `04cc0ceb6049b0243be356098691e41d4fe1bf2e`.

- Rollout `search_precedent` count: 3.
- Rollout `read_precedent` count: 3.
- Rollout `PUBLIC_ORACLE_CANARY_7A42` count: 5.
- Rollout `SENSITIVE_ORACLE_CANARY_9C31` count: 0.
- Rollout restricted identity count: 0.
- Tool-result public canary count: 1.
- Tool-result restricted canary count: 0.
- Tool-result restricted identity count: 0.
- Observed `omittedRestrictedCount`: 1.
- Stdout restricted canary count: 0.
- Stdout restricted identity count: 0.

The filtered run therefore established prevention at the tool-result boundary and defense at the terminal boundary.

## Filter-disabled run

The schema-clean twin removed only the top-level `sensitive: true` declaration from the restricted-canary page.
It regenerated the provider-owned facet registry and artifact policy.
The vault source commit was `b1f47d2a07600eeca641dea4e64d85ec0fb9990a`.

- Rollout `search_precedent` count: 3.
- Rollout `read_precedent` count: 3.
- Rollout `PUBLIC_ORACLE_CANARY_7A42` count: 5.
- Rollout `SENSITIVE_ORACLE_CANARY_9C31` count: 5.
- Rollout restricted identity count: 18.
- Tool-result public canary count: 1.
- Tool-result restricted canary count: 1.
- Tool-result restricted identity count: 6.
- Observed `omittedRestrictedCount`: 0.
- Stdout restricted canary count: 1.
- Stdout restricted identity count: 1.

The correlated Oracle tool result and stdout both contained the restricted canary, so each absence assertion is load-bearing.
This result establishes that the filtered success was not vacuous.

## Launcher check

The first live attempt revealed that `pnpm exec` tried to reconcile the symlinked dependency tree from inside the synthetic root.
The acceptance launcher now invokes the installed `tsx` executable directly.
An MCP SDK check connects through that exact launcher and verifies the three expected tools before the live turn starts.
