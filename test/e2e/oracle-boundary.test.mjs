import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createSmokeFixture,
  environmentFor,
  runCli,
} from "../helpers/live-smoke.mjs";
import {
  createSyntheticVault,
  listSyntheticVaultTools,
} from "../helpers/synthetic-vault.mjs";

const wikiServerRoot = process.env.ANDREW_AGENT_WIKI_SERVER_ROOT;
const fixtureSkip =
  wikiServerRoot === undefined
    ? "ANDREW_AGENT_WIKI_SERVER_ROOT is unset; the vault did not build"
    : false;

test(
  "commits five pages, a policy, and an identity-free facet file",
  { skip: fixtureSkip },
  async () => {
    const vault = await createSyntheticVault({ wikiServerRoot });
    try {
      const facets = JSON.parse(
        await readFile(
          join(vault.root, "config", "restricted-facets.json"),
          "utf8",
        ),
      );
      assert.equal(facets.facets.length, 2);
      assert.ok(
        facets.facets.some(
          (facet) => facet.idHash === vault.restrictedIdHash,
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(facets),
        /hidden-page|false-negative|malformed|CANARY/,
      );

      const policy = JSON.parse(
        await readFile(join(vault.root, "artifact-policy.json"), "utf8"),
      );
      assert.deepEqual(policy.privateSourcePaths, [
        "config/restricted-facets.json",
        "wiki/concepts/false-positive.md",
        "wiki/concepts/public-page.md",
      ]);
      assert.match(vault.sourceCommit, /^[0-9a-f]{40}$/);
      assert.match(vault.providerSourceCommit, /^[0-9a-f]{40}$/);
    } finally {
      await vault.cleanup();
    }
  },
);

test(
  "the synthetic vault launcher exposes the three Oracle tools",
  { skip: fixtureSkip },
  async () => {
    const vault = await createSyntheticVault({ wikiServerRoot });
    try {
      assert.deepEqual(
        await listSyntheticVaultTools({
          wikiServerRoot,
          vaultRoot: vault.root,
        }),
        ["read_evidence", "read_precedent", "search_precedent"],
      );
    } finally {
      await vault.cleanup();
    }
  },
);

const liveRequested =
  process.env.ANDREW_AGENT_REAL_SMOKE === "1" &&
  process.env.ANDREW_AGENT_SMOKE_AUTH !== undefined &&
  process.env.ANDREW_AGENT_SMOKE_CODEX_BIN !== undefined &&
  wikiServerRoot !== undefined;
const liveSkip = liveRequested
  ? false
  : "live smoke, smoke auth, smoke Codex, or wiki server root is unset; gate skipped";
const restrictedCanary = "SENSITIVE_ORACLE_CANARY_9C31";
const restrictedIdentities = ["concepts/hidden-page", "Hidden Page"];
const prompt = [
  "Use the Oracle MCP search_precedent tool directly for project demo,",
  "account personal, and the single topic canary.",
  "For every returned item, use the Oracle MCP read_precedent tool directly.",
  "Quote every read text verbatim,",
  "then report omittedRestrictedCount.",
].join(" ");

test("cleans earlier resources when a later constructor fails", async () => {
  let cleanupCount = 0;
  await assert.rejects(
    () =>
      withResources(
        [
          async () => ({
            cleanup: async () => {
              cleanupCount += 1;
            },
          }),
          async () => {
            throw new Error("fixture construction failed");
          },
        ],
        async () => {},
      ),
    /fixture construction failed/,
  );
  assert.equal(cleanupCount, 1);
});

test("checks rollout and stdout canaries independently", () => {
  assert.throws(
    () => assertRestrictedCanaryAbsentFromToolOutput(restrictedCanary),
    /restricted canary reached an Oracle tool result/,
  );
  assert.throws(
    () => assertRestrictedCanaryAbsentFromRollout(restrictedCanary),
    /restricted canary reached the session rollout/,
  );
  assert.throws(
    () => assertRestrictedCanaryAbsentFromStdout(restrictedCanary),
    /restricted canary reached stdout/,
  );
  assert.throws(
    () => assertRestrictedIdentityAbsentFromRollout("concepts/hidden-page"),
    /restricted identity reached the session rollout/,
  );
  assert.throws(
    () => assertRestrictedIdentityAbsentFromStdout("Hidden Page"),
    /restricted identity reached stdout/,
  );
});

test("isolates Oracle tool outputs from other rollout messages", () => {
  const searchCallId = "oracle-search";
  const readCallId = "oracle-read";
  const searchOutput = `{"structuredContent":{"items":[{"id":"concepts/public-page"}],"omittedRestrictedCount":1}}`;
  const readOutput = `{"structuredContent":{"text":"PUBLIC_ORACLE_CANARY_7A42"}}`;
  const rollout = [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: searchCallId,
        input: "await tools.mcp__oracle__search_precedent({})",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: searchCallId,
        output: [{ type: "input_text", text: searchOutput }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: readCallId,
        input: "await tools.mcp__oracle__read_precedent({})",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: readCallId,
        output: [{ type: "input_text", text: readOutput }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        content: [
          {
            type: "output_text",
            text: `${restrictedCanary} concepts/hidden-page`,
          },
        ],
      },
    },
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");

  assert.deepEqual(extractOracleToolOutputs(rollout, "search_precedent"), [
    searchOutput,
  ]);
  assert.deepEqual(extractOracleToolOutputs(rollout, "read_precedent"), [
    readOutput,
  ]);
  assert.match(rollout, /SENSITIVE_ORACLE_CANARY_9C31/);
  assert.doesNotMatch(
    [searchOutput, readOutput].join("\n"),
    /SENSITIVE_ORACLE_CANARY_9C31/,
  );
  assert.deepEqual(summarizeEvidence({ rollout, turn: { stdout: "" } }), {
    rolloutSearchPrecedentCount: 1,
    rolloutReadPrecedentCount: 1,
    rolloutPublicCanaryCount: 1,
    rolloutRestrictedCanaryCount: 1,
    rolloutRestrictedIdentityCount: 1,
    toolResultPublicCanaryCount: 1,
    toolResultRestrictedCanaryCount: 0,
    toolResultRestrictedIdentityCount: 0,
    omittedRestrictedCounts: [1],
    stdoutRestrictedCanaryCount: 0,
    stdoutRestrictedIdentityCount: 0,
  });
});

async function withResources(factories, callback) {
  const resources = [];
  try {
    for (const factory of factories) resources.push(await factory());
    return await callback(...resources);
  } finally {
    await Promise.all(
      [...resources].reverse().map((resource) => resource.cleanup()),
    );
  }
}

function responseItems(rollout) {
  return rollout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === "response_item")
    .map((record) => record.payload);
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).join("\n");
  if (value === null || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return Object.values(value).map(outputText).join("\n");
}

function extractOracleToolOutputs(rollout, toolName) {
  const items = responseItems(rollout);
  const qualifiedName = `mcp__oracle__${toolName}`;
  const callIds = new Set(
    items
      .filter(
        (item) =>
          typeof item.call_id === "string" &&
          (item.name === qualifiedName ||
            item.tool === toolName ||
            (typeof item.input === "string" &&
              item.input.includes(qualifiedName))),
      )
      .map((item) => item.call_id),
  );
  return items
    .filter(
      (item) =>
        typeof item.type === "string" &&
        item.type.endsWith("_output") &&
        callIds.has(item.call_id),
    )
    .map((item) => outputText(item.output));
}

function countOccurrences(text, needle) {
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function countRestrictedIdentities(text) {
  return restrictedIdentities.reduce(
    (count, identity) => count + countOccurrences(text, identity),
    0,
  );
}

function summarizeEvidence({ turn, rollout }) {
  const searchOutput = extractOracleToolOutputs(
    rollout,
    "search_precedent",
  ).join("\n");
  const readOutput = extractOracleToolOutputs(
    rollout,
    "read_precedent",
  ).join("\n");
  const toolOutput = `${searchOutput}\n${readOutput}`;
  const omittedRestrictedCounts = Array.from(
    searchOutput.matchAll(
      /omittedRestrictedCount[^0-9]{0,32}([0-9]+)/g,
    ),
    (match) => Number(match[1]),
  );
  return {
    rolloutSearchPrecedentCount: countOccurrences(
      rollout,
      "mcp__oracle__search_precedent",
    ),
    rolloutReadPrecedentCount: countOccurrences(
      rollout,
      "mcp__oracle__read_precedent",
    ),
    rolloutPublicCanaryCount: countOccurrences(
      rollout,
      "PUBLIC_ORACLE_CANARY_7A42",
    ),
    rolloutRestrictedCanaryCount: countOccurrences(
      rollout,
      restrictedCanary,
    ),
    rolloutRestrictedIdentityCount: countRestrictedIdentities(rollout),
    toolResultPublicCanaryCount: countOccurrences(
      toolOutput,
      "PUBLIC_ORACLE_CANARY_7A42",
    ),
    toolResultRestrictedCanaryCount: countOccurrences(
      toolOutput,
      restrictedCanary,
    ),
    toolResultRestrictedIdentityCount:
      countRestrictedIdentities(toolOutput),
    omittedRestrictedCounts,
    stdoutRestrictedCanaryCount: countOccurrences(
      turn.stdout,
      restrictedCanary,
    ),
    stdoutRestrictedIdentityCount: countRestrictedIdentities(turn.stdout),
  };
}

async function collectRollouts(directory) {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectRollouts(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      collected.push(await readFile(entryPath, "utf8"));
    }
  }
  return collected;
}

async function oracleTurn({ leakRestricted }) {
  return withResources(
    [
      () => createSyntheticVault({ wikiServerRoot, leakRestricted }),
      () => createSmokeFixture(),
    ],
    async (vault, fixture) => {
      const managedAuth = join(
        fixture.stateRoot,
        "codex-home",
        ["auth", ".json"].join(""),
      );
      await copyFile(process.env.ANDREW_AGENT_SMOKE_AUTH, managedAuth);
      await chmod(managedAuth, 0o600);
      const smokeCodexBin = await realpath(
        process.env.ANDREW_AGENT_SMOKE_CODEX_BIN,
      );
      const turn = await runCli(
        environmentFor(fixture, {
          ANDREW_AGENT_CODEX_BIN: smokeCodexBin,
          ANDREW_AGENT_ORACLE_ROOT: vault.root,
        }),
        ["run", fixture.target, "--capability", "oracle", prompt],
        { timeoutMs: 300_000 },
      );
      const rollouts = await collectRollouts(
        join(fixture.stateRoot, "codex-home", "sessions"),
      );
      return {
        turn,
        rollout: rollouts.join("\n"),
        providerSourceCommit: vault.providerSourceCommit,
        vaultSourceCommit: vault.sourceCommit,
      };
    },
  );
}

function assertRestrictedCanaryAbsentFromRollout(rollout) {
  if (rollout.includes(restrictedCanary)) {
    throw new Error("restricted canary reached the session rollout");
  }
}

function assertRestrictedCanaryAbsentFromToolOutput(toolOutput) {
  if (toolOutput.includes(restrictedCanary)) {
    throw new Error("restricted canary reached an Oracle tool result");
  }
}

function assertRestrictedCanaryAbsentFromStdout(stdout) {
  if (stdout.includes(restrictedCanary)) {
    throw new Error("restricted canary reached stdout");
  }
}

function assertRestrictedIdentityAbsentFromRollout(rollout) {
  if (restrictedIdentities.some((identity) => rollout.includes(identity))) {
    throw new Error("restricted identity reached the session rollout");
  }
}

function assertRestrictedIdentityAbsentFromStdout(stdout) {
  if (restrictedIdentities.some((identity) => stdout.includes(identity))) {
    throw new Error("restricted identity reached stdout");
  }
}

function assertRestrictedCanaryAbsent({ turn, rollout }) {
  assertRestrictedCanaryAbsentFromRollout(rollout);
  assertRestrictedCanaryAbsentFromStdout(turn.stdout);
  assertRestrictedIdentityAbsentFromRollout(rollout);
  assertRestrictedIdentityAbsentFromStdout(turn.stdout);
}

test(
  "check 6: the restricted canary reaches neither tool results nor stdout",
  { skip: liveSkip, timeout: 600_000 },
  async () => {
    const result = await oracleTurn({ leakRestricted: false });
    const searchOutput = extractOracleToolOutputs(
      result.rollout,
      "search_precedent",
    ).join("\n");
    const readOutput = extractOracleToolOutputs(
      result.rollout,
      "read_precedent",
    ).join("\n");
    const toolOutput = `${searchOutput}\n${readOutput}`;
    assert.equal(result.turn.code, 0, result.turn.stderr);
    assert.match(searchOutput, /concepts\/public-page/);
    assert.match(readOutput, /PUBLIC_ORACLE_CANARY_7A42/);
    assert.doesNotMatch(
      toolOutput,
      /SENSITIVE_ORACLE_CANARY_9C31|concepts\/hidden-page|Hidden Page/,
    );
    assertRestrictedCanaryAbsentFromToolOutput(toolOutput);
    assert.match(
      searchOutput,
      /omittedRestrictedCount[^0-9]{0,32}[1-9]/,
    );
    assert.match(result.turn.stdout, /PUBLIC_ORACLE_CANARY_7A42/);
    assertRestrictedCanaryAbsent(result);
    console.log(
      `oracle-boundary evidence filtered ${JSON.stringify({
        providerSourceCommit: result.providerSourceCommit,
        vaultSourceCommit: result.vaultSourceCommit,
        ...summarizeEvidence(result),
      })}`,
    );
  },
);

test(
  "check 7: disabling classification makes the same canary assertion fail",
  { skip: liveSkip, timeout: 600_000 },
  async () => {
    const result = await oracleTurn({ leakRestricted: true });
    const searchOutput = extractOracleToolOutputs(
      result.rollout,
      "search_precedent",
    ).join("\n");
    const readOutput = extractOracleToolOutputs(
      result.rollout,
      "read_precedent",
    ).join("\n");
    assert.equal(result.turn.code, 0, result.turn.stderr);
    assert.match(searchOutput, /concepts\/public-page/);
    assert.match(searchOutput, /concepts\/hidden-page/);
    assert.match(
      searchOutput,
      /omittedRestrictedCount[^0-9]{0,32}0/,
    );
    assert.match(readOutput, /PUBLIC_ORACLE_CANARY_7A42/);
    assert.match(readOutput, /SENSITIVE_ORACLE_CANARY_9C31/);
    assert.match(result.turn.stdout, /PUBLIC_ORACLE_CANARY_7A42/);
    assert.match(result.turn.stdout, /SENSITIVE_ORACLE_CANARY_9C31/);
    assert.throws(
      () => assertRestrictedCanaryAbsentFromToolOutput(readOutput),
      /restricted canary reached an Oracle tool result/,
    );
    assert.throws(
      () => assertRestrictedCanaryAbsentFromRollout(result.rollout),
      /restricted canary reached the session rollout/,
    );
    assert.throws(
      () => assertRestrictedCanaryAbsentFromStdout(result.turn.stdout),
      /restricted canary reached stdout/,
    );
    console.log(
      `oracle-boundary evidence filter-disabled ${JSON.stringify({
        providerSourceCommit: result.providerSourceCommit,
        vaultSourceCommit: result.vaultSourceCommit,
        ...summarizeEvidence(result),
      })}`,
    );
  },
);

test(
  "the filter-disabled vault changes only the sensitive declaration and regenerates policy",
  { skip: fixtureSkip },
  async () => {
    await withResources(
      [
        () => createSyntheticVault({ wikiServerRoot }),
        () =>
          createSyntheticVault({ wikiServerRoot, leakRestricted: true }),
      ],
      async (normal, disabled) => {
        const relativePath = join("wiki", "concepts", "hidden-page.md");
        const normalPage = await readFile(
          join(normal.root, relativePath),
          "utf8",
        );
        const disabledPage = await readFile(
          join(disabled.root, relativePath),
          "utf8",
        );
        assert.equal(
          normalPage.replace("sensitive: true\n", ""),
          disabledPage,
        );
        assert.match(disabledPage, /SENSITIVE_ORACLE_CANARY_9C31/);

        const facets = JSON.parse(
          await readFile(
            join(disabled.root, "config", "restricted-facets.json"),
            "utf8",
          ),
        );
        assert.equal(facets.facets.length, 1);
        assert.ok(
          facets.facets.every(
            (facet) => facet.idHash !== disabled.restrictedIdHash,
          ),
        );

        const policy = JSON.parse(
          await readFile(
            join(disabled.root, "artifact-policy.json"),
            "utf8",
          ),
        );
        assert.ok(
          policy.privateSourcePaths.includes(
            "wiki/concepts/hidden-page.md",
          ),
        );
      },
    );
  },
);
