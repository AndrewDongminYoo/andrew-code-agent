import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const validateModule = await import("../../dist/bundle/validate.js").catch(
  () => null,
);

const manifest = () => ({
  schemaVersion: 1,
  configSource: "config.toml",
  configKeys: [],
  configOverrides: {},
  allowedTokens: ["CODEX_HOME", "HOME", "LLM_WIKI_ROOT", "WORKSPACE_ROOT"],
  files: [],
  hooks: [],
  capabilities: [],
  requirements: [],
  forbiddenLiterals: ["/Users/dongminyu", "/Volumes/dongminyu"],
  forbiddenPathSegments: [
    ["auth", "json"].join("."),
    "sessions",
    "logs",
    "rollout",
    "hooks.state",
  ],
  forbiddenPatternIds: [
    "credential-assignment",
    "github-token",
    "openai-api-key",
    "private-key",
  ],
});

const portableFile = (targetPath, text, mode = 0o644) => ({
  sourcePath: `/source/${targetPath}`,
  targetPath,
  mode,
  bytes: new TextEncoder().encode(text),
});

function validate(files, bundleManifest) {
  assert.notEqual(
    validateModule,
    null,
    "the built validate module must be available",
  );
  return validateModule.validatePortableFiles(files, bundleManifest);
}

function assertValidationError(error, code) {
  return error instanceof validateModule.ValidationError && error.code === code;
}

test("accepts clean portable content with bounded identifiers and declared tokens", async () => {
  const cleanText = await readFile(
    new URL(
      "../fixtures/source-codex/clean/agents/advisor.toml",
      import.meta.url,
    ),
    "utf8",
  );
  const codexHome = "$" + "{CODEX_HOME}";

  assert.doesNotThrow(() =>
    validate(
      [
        portableFile(
          "agents/advisor.toml",
          `${cleanText}bundle_id = \"019c6e27-e55b-73d1-87d8-4e01f1f75043\"\ndigest = \"${"a".repeat(64)}\"\npath = \"${codexHome}/hooks/safety.sh\"\n`,
        ),
        portableFile("hooks/safety.sh", "#!/bin/sh\nexit 0\n", 0o755),
      ],
      manifest(),
    ),
  );
});

test("rejects forbidden literal paths and runtime-state path segments without exposing content", () => {
  const sourceHome = "/Users/dongminyu";
  const safeContent = "safe";
  const cases = [
    [
      "FORBIDDEN_LITERAL",
      portableFile(
        "rules/default.rules",
        `source = \"${sourceHome}/.codex\"\n`,
      ),
      sourceHome,
    ],
    [
      "FORBIDDEN_PATH_SEGMENT",
      portableFile("sessions/thread.toml", `${safeContent}\n`),
      safeContent,
    ],
    [
      "FORBIDDEN_PATH_SEGMENT",
      portableFile("hooks.state", `${safeContent}\n`),
      safeContent,
    ],
  ];

  for (const [code, file, hidden] of cases) {
    assert.throws(
      () => validate([file], manifest()),
      (error) => {
        assert.equal(assertValidationError(error, code), true);
        assert.equal(error.message.includes(hidden), false);
        return true;
      },
    );
  }
});

test("rejects trusted-hook hashes and recognized thread or rollout identifiers", () => {
  const cases = [
    [
      "TRUSTED_HOOK_HASH",
      portableFile("config.toml", 'trusted_hook_hash = "0123456789abcdef"\n'),
    ],
    [
      "TRUSTED_HOOK_HASH",
      portableFile("config.json", '{"trustedHookHash":"0123456789abcdef"}\n'),
    ],
    [
      "RUNTIME_IDENTIFIER",
      portableFile(
        "config.toml",
        'thread_id = "019c6e27-e55b-73d1-87d8-4e01f1f75043"\n',
      ),
    ],
    [
      "RUNTIME_IDENTIFIER",
      portableFile(
        "config.json",
        '{"threadId":"019c6e27-e55b-73d1-87d8-4e01f1f75043"}\n',
      ),
    ],
    [
      "RUNTIME_IDENTIFIER",
      portableFile(
        "config.toml",
        'rollout_id = "019c6e27-e55b-73d1-87d8-4e01f1f75043"\n',
      ),
    ],
  ];

  for (const [code, file] of cases) {
    assert.throws(
      () => validate([file], manifest()),
      (error) => assertValidationError(error, code),
    );
  }
});

test("rejects each declared secret rule without echoing the matched secret", () => {
  const privateKey = [
    "-----BEGIN",
    "PRIVATE KEY-----",
    "secret",
    "-----END",
    "PRIVATE KEY-----",
  ].join(" ");
  const githubToken = "ghp_" + "0123456789abcdefghijABCDEFGHIJ";
  const openAiKey = "sk-proj-" + "0123456789abcdefghijABCDEFGHIJ";
  const cases = [
    ["private-key", "PRIVATE_KEY", privateKey],
    [
      "credential-assignment",
      "CREDENTIAL_ASSIGNMENT",
      'password = "correct-horse-battery-staple"\n',
    ],
    ["github-token", "GITHUB_TOKEN", githubToken],
    ["openai-api-key", "OPENAI_API_KEY", openAiKey],
  ];

  for (const [ruleId, code, secret] of cases) {
    assert.throws(
      () => validate([portableFile("rules/canary.txt", secret)], manifest()),
      (error) => {
        assert.equal(assertValidationError(error, code), true);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(ruleId), true);
        return true;
      },
    );
  }
});

test("rejects unresolved token syntax while allowing only manifest-declared tokens", () => {
  const home = "$" + "{HOME}";
  const codexHome = "$" + "{CODEX_HOME}";
  assert.doesNotThrow(() =>
    validate(
      [
        portableFile(
          "rules/tokens.rules",
          `home = \"${home}\"\nmanaged = \"${codexHome}\"\n`,
        ),
      ],
      manifest(),
    ),
  );

  for (const text of [
    `value = \"${"$" + "{UNKNOWN}"}\"\n`,
    `value = \"${"$" + "{HOME"}\"\n`,
  ]) {
    assert.throws(
      () => validate([portableFile("rules/tokens.rules", text)], manifest()),
      (error) => assertValidationError(error, "UNRESOLVED_TOKEN"),
    );
  }
});
