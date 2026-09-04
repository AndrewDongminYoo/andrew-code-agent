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
  assert.deepEqual(manifest.allowedTokens, [
    "CODEX_HOME",
    "HOME",
    "LLM_WIKI_ROOT",
    "WORKSPACE_ROOT",
  ]);
  assert.deepEqual(manifest.requirements, [
    {
      name: "bash",
      executable: "/bin/sh",
      arguments: [],
    },
    {
      name: "zsh",
      executable: "/bin/sh",
      arguments: ["-c"],
      capability: "oracle",
    },
  ]);
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
  assert.deepEqual(manifest.capabilities, [
    {
      name: "oracle",
      requiredTokens: ["CODEX_HOME", "LLM_WIKI_ROOT"],
      readOnly: true,
      instructionSections: ["Capability Requirements", "Consult the Oracle"],
    },
  ]);
  assert.deepEqual(manifest.forbiddenPatternIds, ["github-token", "private-key"]);
  assert.deepEqual(manifest.mcpServers, [
    {
      name: "oracle",
      command: "/bin/sh",
      args: [
        "-c",
        'cd "$LLM_WIKI_ROOT" && exec pnpm exec tsx mcp-server/src/start-local.ts',
      ],
      env: { LLM_WIKI_MCP_MODE: "managed" },
      envVars: ["LLM_WIKI_ROOT"],
      enabledTools: ["search_precedent", "read_precedent", "read_evidence"],
      defaultToolsApprovalMode: "approve",
      startupTimeoutSec: 240,
      toolTimeoutSec: 60,
      capability: "oracle",
    },
  ]);
});

test("rejects unknown keys at decoded table levels", async () => {
  const valid = await fixture("valid");
  const cases = [
    ["unknown root", valid.replace('config_keys = ["model", "features.hooks"]', 'config_keys = ["model", "features.hooks"]\nunexpected = true')],
    ["unknown file", valid.replace('mode = "0644"', 'mode = "0644"\nunexpected = true')],
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
  const collections = ["allowed_tokens", "files", "hooks", "capabilities", "requirements"];
  const base = `schema_version = 1
config_source = "config.toml"
config_keys = ["model"]
allowed_tokens = []
files = []
hooks = []
capabilities = []
requirements = []

[config_overrides]
approval_policy = "on-request"

[forbidden]
literals = []
path_segments = []`;

  for (const collection of collections) {
    assertManifestError(base.replace(`${collection} = []\n`, ""), "MISSING_FIELD");
  }
});

test("requires forbidden pattern IDs", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('pattern_ids = ["private-key", "github-token"]\n', ""), "MISSING_FIELD");
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
  const valid = await fixture("valid");

  assertManifestError(valid.replace('target = "agents/advisor.toml"', 'target = "Agents/plan.toml"').replace('target = "rules/default.rules"', 'target = "agents/plan.toml"'), "DUPLICATE_TARGET");
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

test("rejects unsupported and duplicate allowed tokens", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('allowed_tokens = ["WORKSPACE_ROOT", "HOME", "LLM_WIKI_ROOT", "CODEX_HOME"]', 'allowed_tokens = ["UNKNOWN"]'), "INVALID_ALLOWED_TOKEN");
  assertManifestError(valid.replace('allowed_tokens = ["WORKSPACE_ROOT", "HOME", "LLM_WIKI_ROOT", "CODEX_HOME"]', 'allowed_tokens = ["HOME", "HOME"]'), "DUPLICATE_ALLOWED_TOKEN");
});

test("rejects invalid requirement records", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('arguments = ["-c"]', 'arguments = ["-c"]\nunexpected = true'), "UNKNOWN_KEY");
  assertManifestError(valid.replace('name = "zsh"', 'name = ""'), "INVALID_REQUIREMENT");
  assertManifestError(valid.replace('name = "zsh"', 'name = "bash"'), "DUPLICATE_REQUIREMENT");
  assertManifestError(valid.replace('executable = "/bin/sh"', 'executable = "bin/sh"'), "INVALID_REQUIREMENT");
  assertManifestError(valid.replace('capability = "oracle"', 'capability = "shared-memory"'), "UNDECLARED_CAPABILITY");
});

test("rejects non-canonical executable paths", async () => {
  const valid = await fixture("valid");
  const executables = [
    "/bin/../sh",
    "/bin//sh",
    "/./bin/sh",
    "/",
    "/bin/",
    "/bin/*.sh",
    "/bin/\\u0001sh",
    "/bin/\\u007fsh",
  ];

  for (const executable of executables) {
    assertManifestError(
      valid.replace('executable = "/bin/sh"', `executable = "${executable}"`),
      "INVALID_REQUIREMENT",
    );
  }
});

test("rejects unsupported and duplicate forbidden pattern IDs", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('pattern_ids = ["private-key", "github-token"]', 'pattern_ids = ["unknown"]'), "INVALID_PATTERN_ID");
  assertManifestError(valid.replace('pattern_ids = ["private-key", "github-token"]', 'pattern_ids = ["private-key", "private-key"]'), "DUPLICATE_PATTERN_ID");
});

test("rejects invalid capability instruction sections", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = ["# Invalid"]'), "INVALID_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = [""]'), "INVALID_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = ["Line\\nBreak"]'), "INVALID_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = ["Line\\rBreak"]'), "INVALID_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = ["Line\\u0000Break"]'), "INVALID_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]', 'instruction_sections = ["Consult the Oracle", "Consult the Oracle"]'), "DUPLICATE_INSTRUCTION_SECTION");
  assertManifestError(valid.replace('instruction_sections = ["Consult the Oracle", "Capability Requirements"]\n', ""), "MISSING_FIELD");
});

test("rejects capability tokens outside the allowed root set", async () => {
  const valid = await fixture("valid");

  assertManifestError(valid.replace('required_tokens = ["LLM_WIKI_ROOT", "CODEX_HOME"]', 'required_tokens = ["UNDECLARED"]'), "UNDECLARED_TOKEN");
});

test("rejects a duplicate MCP server name", async () => {
  assertManifestError(await fixture("mcp-duplicate"), "DUPLICATE_MCP_SERVER");
});

test("rejects a bad command, name, key, or approval mode", async () => {
  const valid = await fixture("valid");
  assertManifestError(
    valid.replace('command = "/bin/sh"', 'command = "sh"'),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(
    valid.replace(
      'name = "oracle"\ncommand',
      'name = "Oracle Server"\ncommand',
    ),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(
    valid.replace(
      "tool_timeout_sec = 60",
      'tool_timeout_sec = 60\ncwd = "/tmp"',
    ),
    "UNKNOWN_KEY",
  );
  assertManifestError(
    valid.replace(
      'default_tools_approval_mode = "approve"',
      'default_tools_approval_mode = "always"',
    ),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(valid.replace('LLM_WIKI_MCP_MODE = "managed"', 'llm_wiki_mcp_mode = "managed"'), "INVALID_MCP_SERVER");
  assertManifestError(valid.replace('LLM_WIKI_MCP_MODE = "managed"', "LLM_WIKI_MCP_MODE = 1"), "INVALID_MCP_SERVER");
});

test("rejects an MCP server capability that is not declared", async () => {
  const valid = await fixture("valid");
  assertManifestError(
    valid.replace(
      'tool_timeout_sec = 60\ncapability = "oracle"',
      'tool_timeout_sec = 60\ncapability = "shared-memory"',
    ),
    "UNDECLARED_CAPABILITY",
  );
});

test("rejects a non-canonical MCP server command path", async () => {
  const valid = await fixture("valid");
  assertManifestError(
    valid.replace('command = "/bin/sh"', 'command = "/bin/../sh"'),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(
    valid.replace('command = "/bin/sh"', 'command = "/bin/s*"'),
    "INVALID_MCP_SERVER",
  );
});

test("rejects config_keys and config_overrides entries reserved for mcp_servers", async () => {
  const valid = await fixture("valid");
  assertManifestError(
    valid.replace(
      'config_keys = ["model", "features.hooks"]',
      'config_keys = ["model", "mcp_servers.probe.command"]',
    ),
    "RESERVED_CONFIG_KEY",
  );
  assertManifestError(
    valid.replace(
      'approval_policy = "on-request"',
      '"mcp_servers.probe.command" = "/bin/sh"\napproval_policy = "on-request"',
    ),
    "RESERVED_CONFIG_KEY",
  );
});

test("accepts a config_overrides key that merely starts with mcp_servers", async () => {
  const manifest = parse(
    (await fixture("valid")).replace(
      'approval_policy = "on-request"',
      'mcp_servers_extra = true\napproval_policy = "on-request"',
    ),
  );
  assert.equal(manifest.configOverrides.mcp_servers_extra, true);
});

test("a manifest without mcp_servers parses to an empty list", async () => {
  const manifest = parse(
    (await fixture("valid")).replace(
      /\[\[mcp_servers\]\][\s\S]*?capability = "oracle"\n/,
      "",
    ),
  );
  assert.deepEqual(manifest.mcpServers, []);
});
