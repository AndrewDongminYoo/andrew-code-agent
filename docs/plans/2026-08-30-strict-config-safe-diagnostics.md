# Strict-config safe diagnostics plan

Date: 2026-08-30 Issue: GitHub #38

## Goal

Show the observed duplicate-key location without disclosing raw child output.

## Scope

- Add failing integration coverage for one safe duplicate-key result.
- Add fallback coverage for untrusted output and unsafe child completion.
- Add a local parser next to `classifyStrictConfig`.

Do not broaden the allowlist beyond the observed duplicate-key form.

## Sequence

1. Add a synthetic stderr fixture with the exact duplicate-key line and
   adjacent secret canaries.
   Assert the expected sanitized finding and absence of every canary.
2. Add malformed, unknown, ambiguous, control, and overlong output fixtures.
   Assert the existing generic finding for each.
3. Add safe-looking output to timeout, output-overflow, and descendant cases.
   Assert the existing generic finding.
4. Run the focused build-first command and confirm the detailed expectation is
   red.
5. Add an exact-line parser that returns a bounded structured value only when
   one safe line matches.
6. Use it only after strict child completion passes all existing safety flags.
7. Deliberately invert the canary assertion once, observe its red result, and
   restore it.
8. Run focused tests, then repository gates when host load permits.

## Verification

```sh
pnpm build
node --test --test-concurrency=1 test/integration/doctor.test.mjs
```

```sh
pnpm check
trunk check --all --no-fix
```

## Delivery boundary

Do not stage, commit, push, close the issue, or open a pull request without a separate operator request.
