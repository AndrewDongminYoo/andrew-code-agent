# andrew-code-agent

This repository owns one private, macOS-only TypeScript CLI.
Keep changes small, explicit, and covered by tests written before production code.

## Boundaries

- This product repository is independent from its parent directory and from `/Users/dongminyu/.codex`; do not write outside this repository unless a task explicitly requires it.
- Do not publish this package, create releases, or modify registry configuration.
- Generated schema artifacts are owned by their generator and source schema; update those inputs and regenerate rather than editing generated output by hand.

## Verification

- Run the narrowest applicable build-first test script before the aggregate `pnpm check` gate.
- Keep the Trunk gate clean with `trunk check --all --no-fix`.
