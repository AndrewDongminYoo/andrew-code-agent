import assert from "node:assert/strict";
import test from "node:test";

const constants = await import("../../dist/constants.js").catch(() => null);

test("exports the pinned standalone-agent metadata", () => {
  assert.notEqual(constants, null, "the built constants module must be available");
  assert.equal(constants.PRODUCT_NAME, "andrew-code-agent");
  assert.equal(constants.PRODUCT_VERSION, "0.2.0");
  assert.equal(constants.REQUIRED_NODE_VERSION, "24.20.0");
  assert.equal(constants.REQUIRED_PNPM_VERSION, "11.22.0");
  assert.equal(constants.REQUIRED_CODEX_VERSION, "0.152.1");
});
