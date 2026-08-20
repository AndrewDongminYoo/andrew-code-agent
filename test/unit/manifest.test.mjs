import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = async (name) =>
  readFile(new URL(`../fixtures/manifests/${name}.toml`, import.meta.url), "utf8");

const manifestModule = await import("../../dist/bundle/manifest.js").catch(() => null);

const parse = (source) => {
  assert.notEqual(manifestModule, null, "the built manifest module must be available");
  return manifestModule.parseBundleManifest(source);
};

const assertManifestError = (source, code) => {
  assert.throws(
    () => parse(source),
    (error) => error instanceof manifestModule.ManifestError && error.code === code,
  );
};

test("decodes a valid manifest into a stable sorted file contract", async () => {
  const manifest = parse(await fixture("valid"));

  assert.deepEqual(
    manifest.files.map((file) => file.target),
    ["agents/advisor.toml", "hooks/safety.sh", "rules/default.rules"],
  );
  assert.deepEqual(manifest.files[1].replacements, [
    {
      search: "/Users/dongminyu/.codex",
      replacement: "${CODEX_HOME}",
      expectedMatches: 1,
    },
  ]);
  assert.deepEqual(manifest.configOverrides, {
    approval_policy: "on-request",
    analytics_enabled: false,
    max_depth: 3,
  });
  assert.deepEqual(manifest.hooks, [
    {
      event: "PreToolUse",
      matcher: "Bash",
      sourceCommand: "/Users/dongminyu/.codex/hooks/safety.sh",
      renderedCommand: "${CODEX_HOME}/hooks/safety.sh",
      timeout: 5,
      requiredScript: "hooks/safety.sh",
      capability: "oracle",
    },
  ]);
});

test("rejects unknown keys at decoded table levels", async () => {
  const valid = await fixture("valid");
  const cases = [
    ["unknown root", valid.replace('config_keys = ["model", "features.hooks"]', 'config_keys = ["model", "features.hooks"]\nunexpected = true')],
    ["unknown file", await fixture("unknown-key")],
    ["unknown replacement", valid.replace("expected_matches = 1", "expected_matches = 1\nunexpected = true")],
    ["unknown hook", valid.replace('event = "PreToolUse"', 'event = "PreToolUse"\nunexpected = true')],
    ["unknown capability", valid.replace('[[capabilities]]\nname = "oracle"', '[[capabilities]]\nname = "oracle"\nunexpected = true')],
    ["unknown forbidden key", valid.replace('literals = ["/Users/dongminyu", "/Volumes/dongminyu"]', 'literals = ["/Users/dongminyu", "/Volumes/dongminyu"]\nunexpected = true')],
  ];

  for (const [, source] of cases) {
    assertManifestError(source, "UNKNOWN_KEY");
  }
});

test("rejects malformed manifest structure and unsafe paths", async () => {
  const valid = await fixture("valid");

  assertManifestError("schema_version = 1", "MISSING_FIELD");
  assertManifestError(valid.replace('source = "rules/default.rules"', 'source = "/rules/default.rules"'), "INVALID_PATH");
  assertManifestError(valid.replace('target = "rules/default.rules"', 'target = "agents/../rules/default.rules"'), "INVALID_PATH");
});

test("rejects glob and recursive source selectors", async () => {
  const valid = await fixture("valid");
  const sources = [
    "rules/*.rules",
    "rules/**/default.rules",
    "rules/?.rules",
    "rules/[default].rules",
    "rules/{default,other}.rules",
  ];

  for (const source of sources) {
    assertManifestError(
      valid.replace('source = "rules/default.rules"', `source = "${source}"`),
      "INVALID_PATH",
    );
  }
});

test("requires each root collection", async () => {
  const collections = ["files", "hooks", "capabilities"];
  const base = `schema_version = 1
config_source = "config.toml"
config_keys = ["model"]
files = []
hooks = []
capabilities = []

[config_overrides]
approval_policy = "on-request"

[forbidden]
literals = []
path_segments = []`;

  for (const collection of collections) {
    assertManifestError(base.replace(`${collection} = []\n`, ""), "MISSING_FIELD");
  }
});

test("sorts file targets by NFC-normalized code units", async () => {
  const valid = await fixture("valid");
  const source = valid
    .replace('target = "rules/default.rules"', 'target = "unicode/e\u0301.toml"')
    .replace('target = "hooks/safety.sh"', 'target = "unicode/f.toml"')
    .replace('target = "agents/advisor.toml"', 'target = "unicode/g.toml"')
    .replace('required_script = "hooks/safety.sh"', 'required_script = "unicode/f.toml"');

  assert.deepEqual(
    parse(source).files.map((file) => file.target),
    ["unicode/f.toml", "unicode/g.toml", "unicode/e\u0301.toml"],
  );
});

test("rejects case-folded duplicate targets before filesystem access", async () => {
  assertManifestError(await fixture("duplicate-target"), "DUPLICATE_TARGET");
});

test("rejects undeclared capabilities, unsupported modes, and unbounded replacements", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('name = "oracle"\nrequired_tokens', 'name = "shared-memory"\nrequired_tokens'), "UNDECLARED_CAPABILITY");
  assertManifestError(valid.replace('mode = "0644"', 'mode = "0600"'), "INVALID_MODE");
  assertManifestError(valid.replace("expected_matches = 1\n", ""), "INVALID_REPLACEMENT");
});

test("rejects nested and non-finite config overrides", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace("max_depth = 3", "nested = { enabled = true }"), "INVALID_TYPE");
  assertManifestError(valid.replace("max_depth = 3", "max_depth = nan"), "INVALID_TYPE");
});

test("rejects hooks whose required script is missing or not executable", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('required_script = "hooks/safety.sh"', 'required_script = "hooks/missing.sh"'), "UNDECLARED_REQUIRED_SCRIPT");
  assertManifestError(valid.replace('required_script = "hooks/safety.sh"', 'required_script = "rules/default.rules"'), "UNDECLARED_REQUIRED_SCRIPT");
});
