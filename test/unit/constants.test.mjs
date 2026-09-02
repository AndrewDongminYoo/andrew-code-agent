import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolved from this file rather than the process CWD, so the assertion keeps
// reading the committed trees when a runner starts somewhere else.
const repoPath = (relative) =>
  fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const constants = await import("../../dist/constants.js").catch(() => null);

test("exports the pinned standalone-agent metadata", () => {
  assert.notEqual(constants, null, "the built constants module must be available");
  assert.equal(constants.PRODUCT_NAME, "andrew-code-agent");
  assert.equal(constants.PRODUCT_VERSION, "0.2.0");
  assert.equal(constants.REQUIRED_NODE_VERSION, "24.20.0");
  assert.equal(constants.REQUIRED_PNPM_VERSION, "11.22.0");
  assert.equal(constants.REQUIRED_CODEX_VERSION, "0.152.1");
});

// The always-on half of the contract pin: the constant doctor compares against
// must describe the trees this repository actually ships. The other half, that
// the pinned binary regenerates those same trees, is opt-in and lives in
// test/contract/client.test.mjs behind ANDREW_AGENT_PINNED_CODEX_BIN.
test("pins the digest of the committed Codex contract trees", async () => {
  const { codexContractDigest } = await import("../../dist/app-server/contract-digest.js");
  assert.equal(
    await codexContractDigest({
      generated: repoPath("src/generated/codex-app-server"),
      schemas: repoPath("schemas/codex-app-server"),
    }),
    constants.REQUIRED_CODEX_CONTRACT_DIGEST,
  );
});
