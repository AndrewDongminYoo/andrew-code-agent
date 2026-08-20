import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parse } from "smol-toml";

const execFile = promisify(execFileCallback);
const renderModule = await import("../../dist/bundle/render.js").catch(
  () => null,
);
const sourceFixture = new URL(
  "../fixtures/source-codex/clean/",
  import.meta.url,
);

const manifest = () => ({
  schemaVersion: 1,
  configSource: "config.toml",
  configKeys: [
    "model",
    "model_reasoning_effort",
    "personality",
    "service_tier",
    "agents.max_depth",
    "features.goals",
    "features.hooks",
    "features.multi_agent",
  ],
  configOverrides: {
    analytics_enabled: false,
    approval_policy: "on-request",
    approvals_reviewer: "user",
  },
  allowedTokens: ["CODEX_HOME", "HOME", "LLM_WIKI_ROOT", "WORKSPACE_ROOT"],
  files: [
    {
      source: "AGENTS.md",
      target: "AGENTS.md",
      mode: "0644",
      replacements: [],
    },
    {
      source: "agents/advisor.toml",
      target: "agents/advisor.toml",
      mode: "0644",
      replacements: [],
    },
    {
      source: "agents/oracle.toml",
      target: "agents/oracle.toml",
      mode: "0644",
      capability: "oracle",
      replacements: [],
    },
    {
      source: "hooks/safety.sh",
      target: "hooks/safety.sh",
      mode: "0755",
      replacements: [
        {
          search: "${HOME}/.codex",
          replacement: "${CODEX_HOME}",
          expectedMatches: 1,
        },
      ],
    },
    {
      source: "rules/default.rules",
      target: "rules/default.rules",
      mode: "0644",
      replacements: [],
    },
  ],
  hooks: [
    {
      event: "PreToolUse",
      matcher: "Bash",
      sourceCommand: 'bash "$HOME/.codex/hooks/safety.sh"',
      renderedCommand: 'bash "${CODEX_HOME}/hooks/safety.sh"',
      timeout: 5,
      requiredScript: "hooks/safety.sh",
    },
  ],
  capabilities: [
    {
      name: "oracle",
      requiredTokens: ["LLM_WIKI_ROOT"],
      readOnly: true,
      instructionSections: ["Consult the Oracle"],
    },
  ],
  requirements: [
    { name: "shell", executable: "/bin/sh", arguments: [] },
    {
      name: "oracle-shell",
      executable: "/bin/sh",
      arguments: [],
      capability: "oracle",
    },
  ],
  forbiddenLiterals: ["/Users/dongminyu", "/Volumes/dongminyu"],
  forbiddenPathSegments: [
    ["auth", "json"].join("."),
    "sessions",
    "logs",
    "cache",
    "rollout",
    "hooks.state",
    "desktop",
  ],
  forbiddenPatternIds: [
    "credential-assignment",
    "github-token",
    "openai-api-key",
    "private-key",
  ],
});

async function createSourceRepository() {
  const repository = await mkdtemp(join(tmpdir(), "andrew-code-agent-render-"));
  await cp(sourceFixture, repository, { recursive: true });
  await writeFile(
    join(repository, "AGENTS.md"),
    "# Fixture Instructions\n\n## Core Rules\n\nKeep the base profile portable.\n\n## Consult the Oracle\n\nUse ${LLM_WIKI_ROOT} only for read-only precedent retrieval.\n\n## Closing Rules\n\nKeep working without the optional adapter.\n",
  );
  await writeFile(
    join(repository, "agents", "oracle.toml"),
    'name = "oracle"\nwiki_root = "${LLM_WIKI_ROOT}"\n',
  );
  await writeFile(
    join(repository, "hooks", "safety.sh"),
    '#!/bin/sh\nprintf "%s\\n" "${HOME}/.codex"\n',
  );
  await chmod(join(repository, "hooks", "safety.sh"), 0o755);
  await execFile("git", ["init", "--quiet", repository]);
  await execFile("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFile("git", ["-C", repository, "config", "user.name", "Test User"]);
  await execFile("git", ["-C", repository, "add", "--all"]);
  await execFile("git", [
    "-C",
    repository,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return repository;
}

async function withSourceRepository(run) {
  const repository = await createSourceRepository();
  try {
    await run(repository);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function withWikiRoot(run) {
  const wikiRoot = await mkdtemp(join(tmpdir(), "andrew-code-agent-wiki-"));
  try {
    await run(wikiRoot);
  } finally {
    await rm(wikiRoot, { recursive: true, force: true });
  }
}

function renderBundle(sourceRoot, bundleManifest, capabilities) {
  assert.notEqual(
    renderModule,
    null,
    "the built render module must be available",
  );
  return renderModule.renderBundle(sourceRoot, bundleManifest, capabilities);
}

function renderedText(bundle, targetPath) {
  const file = bundle.files.find((entry) => entry.targetPath === targetPath);
  assert.notEqual(file, undefined, `${targetPath} must be rendered`);
  return new TextDecoder().decode(file.bytes);
}

function assertRenderError(error, code) {
  return error instanceof renderModule.RenderError && error.code === code;
}

test("projects only portable config and manifest-selected hooks without Oracle", async () => {
  await withSourceRepository(async (repository) => {
    const bundle = await renderBundle(repository, manifest(), {});
    const config = renderedText(bundle, "config.toml");
    const hooks = JSON.parse(renderedText(bundle, "hooks.json"));

    assert.deepEqual(bundle.enabledCapabilities, []);
    assert.deepEqual(bundle.disabledCapabilities, {
      oracle: "Oracle input was not provided.",
    });
    assert.deepEqual(
      bundle.files.map((file) => file.targetPath),
      [
        "AGENTS.md",
        "agents/advisor.toml",
        "config.toml",
        "hooks.json",
        "hooks/safety.sh",
        "rules/default.rules",
      ],
    );
    assert.deepEqual(parse(config), {
      analytics_enabled: false,
      approval_policy: "on-request",
      approvals_reviewer: "user",
      model: "gpt-5.6-terra",
      model_reasoning_effort: "high",
      personality: "pragmatic",
      service_tier: "default",
      agents: {
        max_depth: 2,
        advisor: { config_file: "./agents/advisor.toml" },
      },
      features: { goals: true, hooks: true, multi_agent: true },
    });
    assert.doesNotMatch(
      config,
      /(?:desktop|mcp_servers|notify|project_trust|apps)/u,
    );
    assert.deepEqual(hooks, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: 'bash "${CODEX_HOME}/hooks/safety.sh"',
                timeout: 5,
              },
            ],
          },
        ],
      },
    });
    assert.doesNotMatch(
      JSON.stringify(hooks),
      /shared_memory|xcode|statusMessage/u,
    );
    assert.match(renderedText(bundle, "hooks/safety.sh"), /\$\{CODEX_HOME\}/u);
    assert.doesNotMatch(
      renderedText(bundle, "hooks/safety.sh"),
      /\/Users\/dongminyu/u,
    );
    assert.doesNotMatch(
      renderedText(bundle, "AGENTS.md"),
      /## Consult the Oracle/u,
    );
    assert.match(renderedText(bundle, "AGENTS.md"), /## Closing Rules/u);
  });
});

test("enables Oracle only when its root and every requirement are available", async () => {
  await withSourceRepository(async (repository) => {
    await withWikiRoot(async (wikiRoot) => {
      const bundle = await renderBundle(repository, manifest(), {
        oracle: { llmWikiRoot: wikiRoot },
      });
      assert.deepEqual(bundle.enabledCapabilities, ["oracle"]);
      assert.deepEqual(bundle.disabledCapabilities, {});
      assert.match(renderedText(bundle, "AGENTS.md"), /## Consult the Oracle/u);
      assert.match(
        renderedText(bundle, "agents/oracle.toml"),
        /\$\{LLM_WIKI_ROOT\}/u,
      );
      assert.deepEqual(
        parse(renderedText(bundle, "config.toml")).agents.oracle,
        { config_file: "./agents/oracle.toml" },
      );
    });
  });
});

test("rejects partial Oracle prerequisites fail-closed", async () => {
  await withSourceRepository(async (repository) => {
    await assert.rejects(
      renderBundle(repository, manifest(), {
        oracle: { llmWikiRoot: "relative/wiki" },
      }),
      (error) => assertRenderError(error, "ORACLE_INPUT_INVALID"),
    );
    const unavailableRequirement = manifest();
    unavailableRequirement.requirements[1].executable = "/missing/oracle-shell";
    await withWikiRoot(async (wikiRoot) => {
      await assert.rejects(
        renderBundle(repository, unavailableRequirement, {
          oracle: { llmWikiRoot: wikiRoot },
        }),
        (error) =>
          assertRenderError(error, "CAPABILITY_REQUIREMENT_UNAVAILABLE"),
      );
    });
  });
});

test("fails when a base dependency or bounded replacement contract is unusable", async () => {
  await withSourceRepository(async (repository) => {
    const missingHook = manifest();
    missingHook.hooks[0].requiredScript = "hooks/missing.sh";
    await assert.rejects(renderBundle(repository, missingHook, {}), (error) =>
      assertRenderError(error, "HOOK_DEPENDENCY_MISSING"),
    );
    const wrongReplacementCount = manifest();
    wrongReplacementCount.files[3].replacements[0].expectedMatches = 2;
    await assert.rejects(
      renderBundle(repository, wrongReplacementCount, {}),
      (error) => assertRenderError(error, "REPLACEMENT_COUNT_MISMATCH"),
    );
    const missingBaseRequirement = manifest();
    missingBaseRequirement.requirements[0].executable = "/missing/base-shell";
    await assert.rejects(
      renderBundle(repository, missingBaseRequirement, {}),
      (error) => assertRenderError(error, "BASE_REQUIREMENT_UNAVAILABLE"),
    );
  });
});

test("rejects a required executable without execute permission", async () => {
  await withSourceRepository(async (repository) => {
    const executableDirectory = await mkdtemp(
      join(tmpdir(), "andrew-code-agent-executable-"),
    );
    const executablePath = join(executableDirectory, "not-executable");
    try {
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
      await chmod(executablePath, 0o644);
      const unavailableRequirement = manifest();
      unavailableRequirement.requirements[0].executable = executablePath;
      await assert.rejects(
        renderBundle(repository, unavailableRequirement, {}),
        (error) => assertRenderError(error, "BASE_REQUIREMENT_UNAVAILABLE"),
      );
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });
});
