# Oracle Output Boundary Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the opt-in end-to-end case the spec lists as step 4: an Oracle-enabled run against a synthetic vault whose captured tool results and terminal output contain no `SENSITIVE_ORACLE_CANARY_9C31`, proven non-vacuous by a filter-disabled run that does leak.

**Architecture:** A new e2e test builds a temporary git vault holding the spec's five pages, the generated facet file and the policy, links the real wiki checkout's `mcp-server`, `artifact-kernel`, `package.json` and `node_modules` into it, points `ANDREW_AGENT_ORACLE_ROOT` at it, and drives one real Codex turn through the existing live-smoke harness.
It reads the session rollout for tool results and the CLI stdout for the terminal assertion.
A second run with the vault's restricted page force-listed in the policy must surface the canary in the tool results, which is what makes the first assertion evidence.

**Tech Stack:** `node --test` e2e layer, the pinned Codex 0.152.1, the llm-wiki-dongminyu MCP server after its restricted-results plan lands.

**Spec:** `docs/specs/2026-08-28-oracle-output-safety-boundary.md` ("Acceptance checks" 6 and 7; "Implementation ownership and sequence" step 4 and 5).
This is phase 4 of the sequence recorded on issue #25 on 2026-09-03.

## Global Constraints

- The test never reads the operator's live wiki; the vault is a temporary
  repository under `tmpdir()` and only the server _code_ is linked in.
- The test is opt-in behind `ANDREW_AGENT_REAL_SMOKE=1`,
  `ANDREW_AGENT_SMOKE_AUTH`, and a new `ANDREW_AGENT_WIKI_SERVER_ROOT` naming the wiki checkout whose `mcp-server` to link; unset means a printed skip notice, like the other live gates in `test/e2e/acceptance.test.mjs`.
- Nothing may log, hash, or print authentication material (the existing
  smoke's rule).
- Prerequisites: andrew-code-agent's `[[mcp_servers]]` section, the bundle's
  MCP-only oracle agent, and the wiki's restricted-results plan (Tasks 1–4) are all merged.
- Markdown here is hard-wrapped at 80 columns; test files are excluded from
  prettier and may carry long lines.

---

### Task 1: Build the synthetic vault fixture

**Files:**

- Create: `test/helpers/synthetic-vault.mjs`
- Test: `test/e2e/oracle-boundary.test.mjs` (fixture-only assertions first)

**Interfaces:**

- Produces:

```js
export async function createSyntheticVault({
  wikiServerRoot,
  leakRestricted = false,
}) {
  // returns { root, sourceCommit, restrictedIdHash, cleanup }
}
```

The vault contains five pages under `wiki/concepts/`: `public-page.md`, `hidden-page.md`, `false-positive.md`, `false-negative.md` and `malformed.md`, with the exact frontmatter and canaries from the wiki plan's Task 3, plus `config/artifact-exclusions.json` (`{"version":1,"paths":[]}` or whatever shape `mcp-server/src/pipeline/select-inputs.ts` parses; read it first), `config/restricted-facets.json` produced by running `node --import tsx <wikiServerRoot>/scripts/artifact-restricted-facets.ts` with `cwd` set to the vault, and `artifact-policy.json` produced by the wiki's `pnpm artifact:policy` equivalent run the same way.
With `leakRestricted: true`, `hidden-page.md` is appended to `privateSourcePaths` by hand after generation and the facet file is removed, which is the filter-disabled configuration.
Symlinks:
`mcp-server`, `artifact-kernel`, `node_modules`, `package.json`, `pnpm-lock.yaml` point into `wikiServerRoot`; they are gitignored inside the vault so the commit holds only pages, config and policy.

- \[ \] **Step 1: Write the failing fixture test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSyntheticVault } from "../helpers/synthetic-vault.mjs";

const wikiServerRoot = process.env.ANDREW_AGENT_WIKI_SERVER_ROOT;

test(
  "commits five pages, a policy, and an identity-free facet file",
  {
    skip:
      wikiServerRoot === undefined
        ? "ANDREW_AGENT_WIKI_SERVER_ROOT is unset; the vault did not build"
        : false,
  },
  async () => {
    const vault = await createSyntheticVault({ wikiServerRoot });
    try {
      const facets = JSON.parse(
        await readFile(
          join(vault.root, "config/restricted-facets.json"),
          "utf8",
        ),
      );
      // hidden-page, false-negative, malformed
      assert.equal(facets.facets.length, 3);
      assert.doesNotMatch(
        JSON.stringify(facets),
        /hidden-page|false-negative|malformed|CANARY/,
      );
      const policy = JSON.parse(
        await readFile(join(vault.root, "artifact-policy.json"), "utf8"),
      );
      assert.ok(
        policy.privateSourcePaths.includes("wiki/concepts/public-page.md"),
      );
      assert.ok(
        !policy.privateSourcePaths.includes("wiki/concepts/hidden-page.md"),
      );
    } finally {
      await vault.cleanup();
    }
  },
);
```

- \[ \] **Step 2: Run to verify it fails**

Run:

```bash
pnpm build
WIKI=/Users/dongminyu/Development/01_personal/llm-wiki-dongminyu
ANDREW_AGENT_WIKI_SERVER_ROOT="$WIKI" \
  node --test test/e2e/oracle-boundary.test.mjs
```

Expected: FAIL, helper missing.

- \[ \] **Step 3: Implement the helper**

Use `mkdtemp`, `git init --initial-branch=main`, the same `user.name`/ `user.email` config the wiki harness uses, `symlink` for the five links, `.gitignore` listing them, write the pages, run the two wiki scripts with

```js
execFile(process.execPath, ["--import", "tsx", script], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});
```

apply `leakRestricted`, `git add -A && git commit -m "synthetic vault"`, return `sourceCommit` from `git rev-parse HEAD` and `restrictedIdHash` by reading the facet file's first hash.

- \[ \] **Step 4: Run to verify it passes, then commit**

```bash
git add test/helpers/synthetic-vault.mjs test/e2e/oracle-boundary.test.mjs
git commit -m "test(e2e): build a synthetic Oracle vault with five pages"
```

---

### Task 2: The live boundary run and its filter-disabled twin

**Files:**

- Modify: `test/e2e/oracle-boundary.test.mjs`

**Interfaces:**

- Consumes: `runCli`, `environmentFor`, `probeStrictConfig` and the
  fixture builder from `test/e2e/acceptance.test.mjs` (move the three into `test/helpers/live-smoke.mjs` so both files import them; do not copy).

- \[ \] **Step 1: Write the two live tests**

```js
const liveRequested =
  process.env.ANDREW_AGENT_REAL_SMOKE === "1" &&
  process.env.ANDREW_AGENT_SMOKE_AUTH !== undefined &&
  wikiServerRoot !== undefined;
const skip = liveRequested
  ? false
  : "live smoke, smoke auth, or the wiki server root is unset; gate skipped";
const PROMPT = [
  "Consult the Oracle for project demo, account personal,",
  "topics canary and plain.",
  "Quote every page body the Oracle returns verbatim,",
  "then list any omitted restricted count it reported.",
].join(" ");

async function oracleTurn({ leakRestricted }) {
  const vault = await createSyntheticVault({ wikiServerRoot, leakRestricted });
  // from live-smoke.mjs: target repo, state root, auth copy
  const fixture = await createSmokeFixture();
  try {
    const turn = await runCli(
      environmentFor(fixture, {
        ANDREW_AGENT_CODEX_BIN: await realpath(smokeCodexBin),
        ANDREW_AGENT_ORACLE_ROOT: vault.root,
      }),
      ["run", fixture.target, "--capability", "oracle", PROMPT],
      { timeoutMs: 300_000 },
    );
    // helper: newest sessions/**/*.jsonl as text
    const rollout = await readNewestRollout(fixture.stateRoot);
    return { turn, rollout };
  } finally {
    await fixture.cleanup();
    await vault.cleanup();
  }
}

test(
  "check 6: the restricted canary reaches neither tool results nor stdout",
  { skip },
  async () => {
    const { turn, rollout } = await oracleTurn({ leakRestricted: false });
    assert.equal(turn.code, 0, turn.stderr);
    assert.match(
      rollout,
      /search_precedent/,
      "the run must reach the MCP tool",
    );
    assert.match(
      rollout,
      /PUBLIC_ORACLE_CANARY_7A42/,
      "the eligible page was retrieved, or a clean terminal proves nothing",
    );
    assert.doesNotMatch(rollout, /SENSITIVE_ORACLE_CANARY_9C31/);
    assert.doesNotMatch(turn.stdout, /SENSITIVE_ORACLE_CANARY_9C31/);
    assert.match(rollout, /"omittedRestrictedCount":\s*[1-9]/);
  },
);

test(
  "check 7: with the filter disabled the run leaks the canary into results",
  { skip },
  async () => {
    const { rollout } = await oracleTurn({ leakRestricted: true });
    assert.match(rollout, /SENSITIVE_ORACLE_CANARY_9C31/);
  },
);
```

The third assertion in check 6 is the spec's own caveat: "a clean terminal alone could mean that the fixture never reached the model".

- \[ \] **Step 2: Run both gates**

```bash
pnpm build
ANDREW_AGENT_REAL_SMOKE=1 ANDREW_AGENT_SMOKE_AUTH=<path> \
WIKI=/Users/dongminyu/Development/01_personal/llm-wiki-dongminyu
REL=~/.codex/packages/standalone/releases
CODEX=$REL/0.152.1-aarch64-apple-darwin/bin/codex
ANDREW_AGENT_WIKI_SERVER_ROOT="$WIKI" ANDREW_AGENT_CODEX_BIN="$CODEX" \
  node --test test/e2e/oracle-boundary.test.mjs
```

Expected: both pass.
Check `uptime` first; each turn is a real Codex run, so run this alone on the machine.

- \[ \] **Step 3: Commit**

```bash
git add test/e2e/oracle-boundary.test.mjs test/helpers/live-smoke.mjs \
  test/e2e/acceptance.test.mjs
git commit -m "test(e2e): gate the Oracle output boundary on a synthetic vault"
```

---

### Task 3: Record, document, and close

**Files:**

- Create: `docs/notes/2026-09-XX-oracle-boundary-gate-run.md` (date of the
  run)
- Modify: `CLAUDE.md` "Commands" (add the new variable to the opt-in gate
  list, one sentence)
- Modify: `docs/specs/2026-08-28-oracle-output-safety-boundary.md`
  (append a dated "Status" line: gate landed, omitted count is tag-scoped, see the wiki plan; do not rewrite the contract)

- \[ \] **Step 1: Write the note**

The note records the two runs' commands, exit codes, the three grep counts from each rollout (`search_precedent`, `PUBLIC_ORACLE_CANARY_7A42`, `SENSITIVE_ORACLE_CANARY_9C31`), and the omitted count observed.

- \[ \] **Step 2: Lint and commit**

```bash
trunk check --no-fix docs CLAUDE.md
git add docs/notes CLAUDE.md \
  docs/specs/2026-08-28-oracle-output-safety-boundary.md
git commit -m "docs: record the Oracle boundary gate run and its scope"
```

- \[ \] **Step 3: Pull request**

Load `responding-to-ai-pr-review`, run the local `codex-review` skill, open the PR with `Closes #25` in the body only if both live gates passed on the merged prerequisites; otherwise `Refs #25` and say what is outstanding.

## Self-review

- Spec coverage: checks 6 and 7 (Task 2), sequence steps 4 and 5 (Tasks 1–2),
  the spec's "terminal assertion is defense evidence, the retrieval assertion establishes prevention" (Task 2 asserts the rollout first).
- Placeholder scan: the wiki script names come from the wiki plan
  (`scripts/artifact-restricted-facets.ts`, `pnpm artifact:policy`); if the policy script has a different file name, read `package.json` there.
- Type consistency: `createSyntheticVault` options and return shape match
  between Task 1 and Task 2.
