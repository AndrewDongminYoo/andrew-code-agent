import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const artifactModule = await import("../../dist/bundle/artifact.js").catch(
  () => null,
);
const sourceFixture = new URL(
  "../fixtures/source-codex/clean/",
  import.meta.url,
);

const fixtureManifest = `allowed_tokens = ["HOME", "CODEX_HOME", "WORKSPACE_ROOT", "LLM_WIKI_ROOT"]
config_keys = ["model", "model_reasoning_effort", "personality", "service_tier", "agents.max_depth", "features.goals", "features.hooks", "features.multi_agent"]
config_source = "config.toml"
schema_version = 1

[[capabilities]]
instruction_sections = ["Consult the Oracle"]
name = "oracle"
read_only = true
required_tokens = ["LLM_WIKI_ROOT"]

[config_overrides]
analytics_enabled = false
approval_policy = "on-request"
approvals_reviewer = "user"

[[files]]
mode = "0644"
source = "AGENTS.md"
target = "AGENTS.md"

[[files]]
mode = "0644"
source = "agents/advisor.toml"
target = "agents/advisor.toml"

[[files]]
capability = "oracle"
mode = "0644"
source = "agents/oracle.toml"
target = "agents/oracle.toml"

[[files]]
mode = "0755"
source = "hooks/safety.sh"
target = "hooks/safety.sh"

[[files]]
mode = "0644"
source = "rules/default.rules"
target = "rules/default.rules"

[forbidden]
literals = ["/Users/dongminyu", "/Volumes/dongminyu"]
path_segments = ["auth\\u002Ejson", "sessions", "logs", "cache", "rollout", "hooks.state", "desktop"]
pattern_ids = ["private-key", "credential-assignment", "github-token", "openai-api-key"]

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
rendered_command = 'bash "\${CODEX_HOME}/hooks/safety.sh"'
required_script = "hooks/safety.sh"
source_command = 'bash "$HOME/.codex/hooks/safety.sh"'
timeout = 5

[[requirements]]
arguments = ["-c", "exit 0"]
executable = "/bin/sh"
name = "shell"
`;

async function createSourceRepository() {
  const repository = await mkdtemp(
    join(tmpdir(), "andrew-code-agent-artifact-"),
  );
  await cp(sourceFixture, repository, { recursive: true });
  await writeFile(
    join(repository, "AGENTS.md"),
    "# Fixture Instructions\n\n## Core Rules\n\nKeep the base profile portable.\n\n## Consult the Oracle\n\nUse \${LLM_WIKI_ROOT} only for read-only precedent retrieval.\n\n## Closing Rules\n\nKeep working without the optional adapter.\n",
  );
  await writeFile(
    join(repository, "agents", "oracle.toml"),
    'name = "oracle"\nwiki_root = "\${LLM_WIKI_ROOT}"\n',
  );
  await writeFile(
    join(repository, "hooks", "safety.sh"),
    '#!/bin/sh\nprintf "%s\\n" "\${HOME}/.codex"\n',
  );
  await chmod(join(repository, "hooks", "safety.sh"), 0o755);
  await writeFile(join(repository, "agent-bundle.toml"), fixtureManifest);
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

async function withArtifactsRoot(run) {
  const artifactsRoot = await mkdtemp(
    join(tmpdir(), "andrew-code-agent-artifacts-"),
  );
  try {
    await run(artifactsRoot);
  } finally {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
}

function buildBundle(input) {
  assert.notEqual(
    artifactModule,
    null,
    "the built artifact module must be available",
  );
  return artifactModule.buildBundle(input);
}

function bundleInput(sourceRoot, artifactsRoot, overrides = {}) {
  return {
    sourceRoot,
    artifactsRoot,
    requestedCapabilities: ["oracle"],
    capabilityInputs: {},
    builderVersion: "0.1.0-test",
    ...overrides,
  };
}

async function readArtifactTree(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        const metadata = await lstat(path);
        files.push({
          path: relative(root, path),
          mode: metadata.mode & 0o777,
          bytes: await readFile(path),
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function commitChange(repository, path, contents) {
  await writeFile(join(repository, path), contents);
  await execFile("git", ["-C", repository, "add", "--", path]);
  await execFile("git", [
    "-C",
    repository,
    "commit",
    "--quiet",
    "-m",
    "fixture change",
  ]);
}

function assertArtifactError(error, code) {
  return error instanceof artifactModule.ArtifactError && error.code === code;
}

test("builds byte-identical immutable artifacts from the same committed source", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (firstArtifactsRoot) => {
      await withArtifactsRoot(async (secondArtifactsRoot) => {
        const first = await buildBundle(
          bundleInput(sourceRoot, firstArtifactsRoot),
        );
        const second = await buildBundle(
          bundleInput(sourceRoot, secondArtifactsRoot),
        );

        assert.equal(first.metadata.bundleDigest, second.metadata.bundleDigest);
        assert.deepEqual(first.metadata, second.metadata);
        assert.deepEqual(
          await readArtifactTree(first.artifactRoot),
          await readArtifactTree(second.artifactRoot),
        );
        assert.deepEqual(first.metadata.requestedCapabilities, ["oracle"]);
        assert.deepEqual(first.metadata.enabledCapabilities, []);
        assert.equal(
          first.metadata.files.some(
            (file) => file.path === "bundle-metadata.json",
          ),
          false,
        );
        assert.equal(
          await readFile(
            join(first.artifactRoot, "bundle-metadata.json"),
            "utf8",
          ),
          `${JSON.stringify(first.metadata, null, 2)}\n`,
        );
        assert.deepEqual(
          (await readArtifactTree(first.artifactRoot)).map((file) => [
            file.path,
            file.mode,
          ]),
          [
            ["AGENTS.md", 0o644],
            ["agents/advisor.toml", 0o644],
            ["bundle-metadata.json", 0o644],
            ["config.toml", 0o644],
            ["hooks.json", 0o644],
            ["hooks/safety.sh", 0o755],
            ["rules/default.rules", 0o644],
          ],
        );
      });
    });
  });
});

test("binds source bytes, modes, revisions, manifests, builder versions, and requested capabilities into identity", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      const base = await buildBundle(bundleInput(sourceRoot, artifactsRoot));

      const builderVersion = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot, {
          builderVersion: "0.1.1-test",
        }),
      );
      assert.notEqual(
        builderVersion.metadata.bundleDigest,
        base.metadata.bundleDigest,
      );

      const noRequestedCapability = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot, { requestedCapabilities: [] }),
      );
      assert.notEqual(
        noRequestedCapability.metadata.bundleDigest,
        base.metadata.bundleDigest,
      );

      await execFile("git", [
        "-C",
        sourceRoot,
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "revision only",
      ]);
      const revisionOnly = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot),
      );
      assert.notEqual(
        revisionOnly.metadata.sourceRevision,
        base.metadata.sourceRevision,
      );
      assert.notEqual(
        revisionOnly.metadata.bundleDigest,
        base.metadata.bundleDigest,
      );

      const rulesPath = join(sourceRoot, "rules", "default.rules");
      await commitChange(
        sourceRoot,
        "rules/default.rules",
        `${await readFile(rulesPath, "utf8")}changed = true\n`,
      );
      const byteChanged = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot),
      );
      assert.notEqual(
        byteChanged.metadata.bundleDigest,
        revisionOnly.metadata.bundleDigest,
      );

      await commitChange(
        sourceRoot,
        "agent-bundle.toml",
        `${fixtureManifest}\n# manifest byte change\n`,
      );
      const manifestChanged = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot),
      );
      assert.notEqual(
        manifestChanged.metadata.manifestDigest,
        byteChanged.metadata.manifestDigest,
      );
      assert.notEqual(
        manifestChanged.metadata.bundleDigest,
        byteChanged.metadata.bundleDigest,
      );

      await chmod(rulesPath, 0o755);
      const executableManifest = `${fixtureManifest.replace('mode = "0644"\nsource = "rules/default.rules"', 'mode = "0755"\nsource = "rules/default.rules"')}`;
      await commitChange(sourceRoot, "agent-bundle.toml", executableManifest);
      await execFile("git", [
        "-C",
        sourceRoot,
        "add",
        "--",
        "rules/default.rules",
      ]);
      await execFile("git", [
        "-C",
        sourceRoot,
        "commit",
        "--quiet",
        "-m",
        "make rule executable",
      ]);
      const modeChanged = await buildBundle(
        bundleInput(sourceRoot, artifactsRoot),
      );
      assert.equal(
        modeChanged.metadata.files.find(
          (file) => file.path === "rules/default.rules",
        )?.mode,
        "0755",
      );
      assert.notEqual(
        modeChanged.metadata.bundleDigest,
        manifestChanged.metadata.bundleDigest,
      );
    });
  });
});

test("rejects an undeclared output before publication and cleans its staging directory", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      assert.notEqual(
        artifactModule,
        null,
        "the built artifact module must be available",
      );
      artifactModule.__setArtifactTestHookForTests(async (stagingRoot) => {
        const leakDirectory = join(stagingRoot, "sessions");
        await mkdir(leakDirectory);
        await writeFile(join(leakDirectory, "leak.json"), "{}\n");
      });
      try {
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "UNDECLARED_OUTPUT"),
        );
      } finally {
        artifactModule.__setArtifactTestHookForTests(undefined);
      }
      assert.deepEqual(await readdir(artifactsRoot), []);

      const clean = await buildBundle(bundleInput(sourceRoot, artifactsRoot));
      assert.equal(clean.metadata.bundleDigest.length, 64);
    });
  });
});

test("rechecks that the source is still clean immediately before publication", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      assert.notEqual(
        artifactModule,
        null,
        "the built artifact module must be available",
      );
      artifactModule.__setArtifactTestHookForTests(() =>
        writeFile(
          join(sourceRoot, "rules", "default.rules"),
          "changed after render\n",
        ),
      );
      try {
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "DIRTY_SOURCE"),
        );
      } finally {
        artifactModule.__setArtifactTestHookForTests(undefined);
      }
      assert.deepEqual(await readdir(artifactsRoot), []);
    });
  });
});
