# Plan

Implement issue #31 by changing only the Oracle capability instruction in an
authorized bundle source.
Preserve the default-off bundle boundary and prove the propagation contract
with an unchanged prompt.
Then re-run the fixed v0.2 acceptance measurement without changing its
criteria.

## Scope

- In: Oracle instruction contract, enabled and disabled bundle validation,
  focused real-run proof, fixed acceptance re-run, and a new dated evidence
  record in this repository.
- Out: task prompt changes, acceptance-criteria changes, App Server or renderer
  changes, output scanning from #25, README work from #32, version changes,
  releases, and publication.

## Action items

- [ ] Resolve the authorized clean bundle source and record the exact product
      and bundle-source revisions before work starts.
      Confirm that both worktrees are clean.
      Record the current disk space and machine load before each real-run batch.
- [ ] Read the selected `agent-bundle.toml` and identify the single instruction
      section declared for the Oracle capability.
      Confirm that the current renderer removes this section from a
      capability-disabled candidate and retains it in an enabled candidate.
- [ ] Re-run one unchanged treatment task from
      `docs/specs/2026-08-25-v0.2-oracle-acceptance.md` against the current
      instruction.
      Confirm the known failure: Oracle citations reach the parent context, but
      the final deliverable does not cite them or state their effect.
      Keep the session log as the failing baseline.
- [ ] Update only the Oracle capability instruction in the authorized bundle
      source.
      Require the final deliverable to cite relevant returned precedent and
      state its effect.
      Require the final deliverable to reject irrelevant or stale precedent as
      authority.
      Require `[no precedent found]` when no relevant precedent exists.
      Do not require source quotations when a concise summary and citation are
      sufficient.
- [ ] Build capability-disabled and Oracle-enabled candidates from the updated
      bundle source.
      Verify that the disabled candidate contains no Oracle instruction section
      or Oracle-only token.
      Verify that the enabled candidate contains the contract exactly once and
      carries the same canonical Oracle root that validation approved.
- [ ] Run the focused treatment task again with the same target revision and
      prompt.
      Verify that the parent deliverable includes a resolving Oracle citation
      and states how the cited precedent affected the direction.
      Scan the run log with the existing sensitive-content check, and record its
      actual coverage instead of claiming prevention.
- [ ] Re-run all five control and treatment pairs from the fixed specification.
      Keep each target revision, issue text, prompt, execution order, and
      scoring rule unchanged.
      Run the jobs sequentially in the background so a foreground timeout does
      not leave a stale lock.
      Exclude an arm that does not call the Oracle because of an environment
      failure.
- [ ] Add a new dated note and transcript under `docs/notes/`.
      Record every run outcome, citation check, criterion verdict, deviation,
      environment failure, and sensitive-content scan result.
      Do not revise the 2026-08-26 historical record.
- [ ] Run `pnpm check` and `trunk check --all --no-fix` in this repository after
      the evidence files are final.
      Run the bundle source's own declared gate in its repository.
      Close #31 only when the propagation contract passes and the fixed
      measurement result is recorded, even if a different acceptance criterion
      still does not pass.

## Open questions

- Which clean bundle-source repository and branch is authorized for the
  instruction change?
