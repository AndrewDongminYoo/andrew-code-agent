# Managed cache-boundary measurement result

Date: 2026-08-31 Issue: GitHub #23

The measurement contract, the roles, and the non-goals are fixed in `docs/specs/2026-08-30-managed-cache-boundary-measurement.md`; this note owns only what the run returned.
No production policy is selected here.

## What was run

The opt-in acceptance test `live smoke: synthetic cache roots distinguish the current and narrow policies` against the pinned Codex `0.148.0` release binary, on merged `main` `3d8dc5b` plus an unmerged product-version bump touching only `package.json`, `src/constants.ts`, `test/unit/constants.test.mjs`, and `test/integration/doctor.test.mjs`.
No sandbox, coordinator, or path code differed from `3d8dc5b`.

Two disposable fixtures, one real managed turn each, 26.2 s total.
Each turn ran the committed helper once and wrote a receipt naming the five root roles.

## What the runs returned

| Root role  | Current policy | Narrow-cache candidate |
| ---------- | -------------- | ---------------------- |
| repository | written        | written                |
| temporary  | written        | written                |
| cache      | **blocked**    | **written**            |
| home       | blocked        | blocked                |
| sibling    | blocked        | blocked                |

Both turns reported `networkAccess: false`, `excludeTmpdirEnvVar: false`, and `excludeSlashTmp: false`.
The current turn requested one writable root, the candidate turn two, and the candidate's second root was the synthetic cache root and nothing else.
Neither the persisted thread record nor the captured stdout and stderr contained a synthetic absolute root.

## The denied-root control

A green pass on this test asserts a map it also supplies, so the current policy's `cache: blocked` was inverted to `written` and the run repeated.
It failed, and the failure printed the receipt the real turn produced:

```log
actual:   { repository: 'written', temporary: 'written', cache: 'blocked',
            home: 'blocked', sibling: 'blocked' }
expected: { repository: 'written', temporary: 'written', cache: 'written',
            home: 'blocked', sibling: 'blocked' }
```

The expectation was then restored.
The `home` and `sibling` roles are denied controls in both arms and stayed denied in both.

## What this establishes

The current writable-root policy does block a write to a cache root outside the target repository, and that refusal is observed rather than predicted.

Adding one canonical root to `writableRoots` grants exactly that root.
The neighbouring synthetic `home` and `sibling` roots stayed blocked in the candidate arm, so the grant does not widen beyond the path it names.

## What this does not establish

No real toolchain cache was touched, so the run says nothing about whether Flutter, Cargo, pnpm, Ruby, or Pub actually needs the write, nor about how often a warm cache makes the question moot.
The `temporary` role exercised the `/tmp` allowance, not the `$TMPDIR` allowance.

The run therefore measures mechanism, not user impact, and #23's three candidate policies remain equally open on the evidence collected here.

## What remains

Select one policy from #23 before closing it: named per-run allowances, a pre-warm step outside the managed turn, or a documented unsupported-toolchain boundary with a preflight diagnostic.
That choice needs a real toolchain failure or an explicit product decision, neither of which this run supplies.
