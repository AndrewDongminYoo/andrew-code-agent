import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const validateModule = await import("../../dist/bundle/validate.js").catch(
  () => null,
);

const manifest = ({ forbiddenPathSegments } = {}) => ({
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
    "session",
    "sessions",
    "archived_sessions",
    "logs",
    "cache",
    "rollout",
    "imported_sessions",
    ".sqlite",
    "hooks.state",
    ...(forbiddenPathSegments ?? []),
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

const portableBytes = (targetPath, bytes, mode = 0o644) => ({
  sourcePath: `/source/${targetPath}`,
  targetPath,
  mode,
  bytes,
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

test("rejects forbidden runtime path segments only in bounded path-like content", () => {
  const cases = [
    "/tmp/sessions/thread.json",
    "/tmp/archived_sessions/thread.json",
    "state/logs/current.log",
    "state/cache/value.json",
    "state/rollout/item.json",
    "state/imported_sessions/item.json",
    "/tmp/runtime.sqlite",
  ];

  for (const contentPath of cases) {
    assert.throws(
      () =>
        validate(
          [portableFile("rules/canary.txt", `path = \"${contentPath}\"\n`)],
          manifest(),
        ),
      (error) => assertValidationError(error, "FORBIDDEN_PATH_SEGMENT"),
    );
  }

  assert.doesNotThrow(() =>
    validate(
      [
        portableFile(
          "rules/prose.txt",
          "The session logs describe cache behavior without a runtime path.\n",
        ),
      ],
      manifest(),
    ),
  );
});

test("classifies only concrete content paths before applying forbidden segments", () => {
  const cases = [
    ["conceptual prose", "cache/runtime", false],
    ["absolute", "/tmp/cache/runtime", true],
    ["home relative", "~/cache/runtime", true],
    ["dot relative", "./cache/runtime", true],
    ["parent relative", "../cache/runtime", true],
    ["trailing slash", "cache/runtime/", true],
    ["filename extension", "cache/runtime.txt", true],
    ["two separators", "docs/cache/runtime", true],
    ["safe two separators", "docs/runtime/example", false],
    ["safe filename extension", "notes/runtime.txt", false],
    ["safe trailing slash", "runtime/", false],
  ];

  for (const [name, candidate, shouldReject] of cases) {
    const file = portableFile(
      "rules/path-candidate.txt",
      `value = \"${candidate}\"\n`,
    );
    if (shouldReject) {
      assert.throws(
        () => validate([file], manifest()),
        (error) => {
          assert.equal(
            assertValidationError(error, "FORBIDDEN_PATH_SEGMENT"),
            true,
          );
          assert.equal(error.message.includes(candidate), false, name);
          return true;
        },
      );
    } else {
      assert.doesNotThrow(() => validate([file], manifest()), name);
    }
  }
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
    [
      "FORBIDDEN_PATH_SEGMENT",
      portableFile("runtime.sqlite", `${safeContent}\n`),
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
        "config.toml",
        'session_id = "019c6e27-e55b-73d1-87d8-4e01f1f75043"\n',
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

test("rejects each declared secret rule without echoing the matched secret", async () => {
  const fixture = await readFile(
    new URL(
      "../fixtures/source-codex/secret-canary/private-key.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const privateKey = [
    "-----BEGIN",
    "PRIVATE KEY-----",
    "secret",
    "-----END",
    "PRIVATE KEY-----",
  ].join(" ");
  const githubToken = "ghp_" + "0123456789abcdefghijABCDEFGHIJ";
  const githubPat = "github_pat_" + "0123456789abcdefghijABCDEFGHIJ";
  const openAiKey = "sk-proj-" + "0123456789abcdefghijABCDEFGHIJ";
  const cases = [
    ["private-key", "PRIVATE_KEY", privateKey],
    [
      "credential-assignment",
      "CREDENTIAL_ASSIGNMENT",
      'password = "correct-horse-battery-staple"\n',
    ],
    ["github-token", "GITHUB_TOKEN", githubToken],
    ["github-token", "GITHUB_TOKEN", githubPat],
    ["openai-api-key", "OPENAI_API_KEY", openAiKey],
  ];

  for (const [ruleId, code, secret] of cases) {
    assert.throws(
      () =>
        validate(
          [portableFile("rules/canary.txt", `${fixture}\n${secret}`)],
          manifest(),
        ),
      (error) => {
        assert.equal(assertValidationError(error, code), true);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(ruleId), true);
        return true;
      },
    );
  }
});

test("rejects high-confidence credential assignments without rejecting generic keys", () => {
  const credentialCases = [
    'client_secret = "correct-horse-battery-staple"\n',
    'access_token = "correct-horse-battery-staple"\n',
    'auth_token = "correct-horse-battery-staple"\n',
    'github_token = "correct-horse-battery-staple"\n',
    'openai_api_key = "correct-horse-battery-staple"\n',
    'aws_secret_access_key = "correct-horse-battery-staple"\n',
    'database_passwd = "correct-horse-battery-staple"\n',
    'database_pwd = "correct-horse-battery-staple"\n',
  ];

  for (const content of credentialCases) {
    assert.throws(
      () => validate([portableFile("rules/canary.txt", content)], manifest()),
      (error) => assertValidationError(error, "CREDENTIAL_ASSIGNMENT"),
    );
  }

  for (const content of [
    'feature_key = "long-but-not-a-credential"\n',
    'tokenizer = "long-but-not-a-credential"\n',
    'label = "long-but-not-a-credential"\n',
  ]) {
    assert.doesNotThrow(() =>
      validate([portableFile("rules/clean.txt", content)], manifest()),
    );
  }
});

test("rejects invalid UTF-8 without exposing bytes", () => {
  assert.throws(
    () =>
      validate(
        [portableBytes("rules/invalid.txt", new Uint8Array([0xc3, 0x28]))],
        manifest(),
      ),
    (error) => {
      assert.equal(assertValidationError(error, "INVALID_UTF8"), true);
      assert.equal(error.message.includes("0xc3"), false);
      return true;
    },
  );
});

test("preserves shell runtime expansion syntax without installer-token classification", () => {
  const runtimeForms = [
    "$" + "{TMPDIR:-/tmp}",
    "$" + "{target}",
    "$" + "{!argument}",
    "$" + "{UNKNOWN}",
  ];

  assert.doesNotThrow(() =>
    validate(
      [
        portableFile(
          "hooks/runtime.sh",
          runtimeForms.map((form) => `printf '%s\\n' \"${form}\"`).join("\n"),
          0o755,
        ),
        portableFile(
          "hooks/runtime.bash",
          `value=\"${runtimeForms[0]}\"`,
          0o755,
        ),
      ],
      manifest(),
    ),
  );
});

test("preserves complete non-shell runtime and example expansions", () => {
  const runtimeForms = [
    "$" + "{TMPDIR:-/tmp}",
    "$" + "{target}",
    "$" + "{!argument}",
    "$" + "{CODEX_HOME${HOME}}",
  ];

  assert.doesNotThrow(() =>
    validate(
      [
        portableFile(
          "rules/examples.txt",
          runtimeForms.map((form) => `example = \"${form}\"`).join("\n"),
        ),
      ],
      manifest(),
    ),
  );
});

test("rejects unclosed shell token syntax without exposing source text", () => {
  const malformedToken = "$" + "{TMPDIR:-/tmp";

  assert.throws(
    () =>
      validate(
        [portableFile("hooks/runtime.sh", malformedToken, 0o755)],
        manifest(),
      ),
    (error) => {
      assert.equal(assertValidationError(error, "UNRESOLVED_TOKEN"), true);
      assert.equal(error.message.includes(malformedToken), false);
      return true;
    },
  );
});

test("rejects unclosed nested non-shell token syntax without exposing source text", () => {
  const malformedToken = "$" + "{CODEX_HOME${CODEX_HOME}";

  assert.throws(
    () =>
      validate(
        [portableFile("rules/tokens.rules", malformedToken)],
        manifest(),
      ),
    (error) => {
      assert.equal(assertValidationError(error, "UNRESOLVED_TOKEN"), true);
      assert.equal(error.message.includes(malformedToken), false);
      return true;
    },
  );
});

test("rejects simple unknown non-shell placeholders and unclosed syntax", () => {
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

  const unknownToken = `value = \"${"$" + "{UNKNOWN}"}\"\n`;
  for (const text of [unknownToken, `value = \"${"$" + "{HOME"}\"\n`]) {
    assert.throws(
      () => validate([portableFile("rules/tokens.rules", text)], manifest()),
      (error) => assertValidationError(error, "UNRESOLVED_TOKEN"),
    );
  }

  const invalidFile = portableFile("rules/tokens.rules", unknownToken);
  for (const _ of [1, 2]) {
    assert.throws(
      () => validate([invalidFile], manifest()),
      (error) => assertValidationError(error, "UNRESOLVED_TOKEN"),
    );
  }
});

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
          `${cleanText}bundle_id = \"019c6e27-e55b-73d1-87d8-4e01f1f75043\"\ndigest = \"${"a".repeat(64)}\"\npath = \"${codexHome}/hooks/safety.sh\"\nprose = \"A session logs progress without naming a path.\"\n`,
        ),
        portableFile("hooks/safety.sh", "#!/bin/sh\nexit 0\n", 0o755),
      ],
      manifest(),
    ),
  );
});
