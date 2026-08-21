import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
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
    return await run(artifactsRoot);
  } finally {
    await rm(artifactsRoot, { recursive: true, force: true });
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

async function withSecondSnapshotCommit(repository, run) {
  const shimDirectory = await mkdtemp(
    join(tmpdir(), "andrew-code-agent-artifact-git-"),
  );
  const firstMarkerPath = join(shimDirectory, "first-snapshot");
  const secondMarkerPath = join(shimDirectory, "second-snapshot");
  const outputPath = join(shimDirectory, "git-output");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  await writeFile(
    shimPath,
    `#!/bin/sh
if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  "$ANDREW_AGENT_TEST_REAL_GIT" "$@" > "$ANDREW_AGENT_TEST_GIT_OUTPUT" || exit $?
  if [ ! -e "$ANDREW_AGENT_TEST_FIRST_MARKER" ]; then
    : > "$ANDREW_AGENT_TEST_FIRST_MARKER"
  elif [ ! -e "$ANDREW_AGENT_TEST_SECOND_MARKER" ]; then
    printf '%s\n' 'changed during manifest read' > "$ANDREW_AGENT_TEST_MUTATE_PATH"
    "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" add -- rules/default.rules || exit $?
    "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" commit --quiet -m 'manifest read canary' || exit $?
    : > "$ANDREW_AGENT_TEST_SECOND_MARKER"
  fi
  cat "$ANDREW_AGENT_TEST_GIT_OUTPUT"
  exit 0
fi
exec "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
`,
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
  process.env.ANDREW_AGENT_TEST_FIRST_MARKER = firstMarkerPath;
  process.env.ANDREW_AGENT_TEST_GIT_OUTPUT = outputPath;
  process.env.ANDREW_AGENT_TEST_MUTATE_PATH = join(
    repository,
    "rules/default.rules",
  );
  process.env.ANDREW_AGENT_TEST_REAL_GIT = gitPath;
  process.env.ANDREW_AGENT_TEST_REPOSITORY = repository;
  process.env.ANDREW_AGENT_TEST_SECOND_MARKER = secondMarkerPath;
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.ANDREW_AGENT_TEST_FIRST_MARKER;
    delete process.env.ANDREW_AGENT_TEST_GIT_OUTPUT;
    delete process.env.ANDREW_AGENT_TEST_MUTATE_PATH;
    delete process.env.ANDREW_AGENT_TEST_REAL_GIT;
    delete process.env.ANDREW_AGENT_TEST_REPOSITORY;
    delete process.env.ANDREW_AGENT_TEST_SECOND_MARKER;
    await rm(shimDirectory, { recursive: true, force: true });
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

async function commitAll(repository, message) {
  await execFile("git", ["-C", repository, "add", "--all"]);
  await execFile("git", [
    "-C",
    repository,
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

async function replaceManifestWithSymlinkChain(sourceRoot, manifest) {
  await rm(join(sourceRoot, "agent-bundle.toml"));
  await mkdir(join(sourceRoot, "manifests"));
  await writeFile(
    join(sourceRoot, "manifests", "agent-bundle.toml"),
    manifest,
  );
  await symlink(
    "manifest-bridge.toml",
    join(sourceRoot, "agent-bundle.toml"),
  );
  await symlink(
    "manifests/agent-bundle.toml",
    join(sourceRoot, "manifest-bridge.toml"),
  );
}

function assertArtifactError(error, code) {
  return error instanceof artifactModule.ArtifactError && error.code === code;
}

function setPublicationHook(hook) {
  assert.equal(
    typeof artifactModule.__setArtifactPublicationTestHookForTests,
    "function",
    "the built artifact module must expose the publication test hook",
  );
  artifactModule.__setArtifactPublicationTestHookForTests(hook);
}

async function expectedMetadata(sourceRoot) {
  return withArtifactsRoot(async (artifactsRoot) =>
    buildBundle(bundleInput(sourceRoot, artifactsRoot)),
  );
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

test("rejects manifest paths outside the tracked source closure", async () => {
  const cases = [
    {
      name: "ignored direct manifest",
      arrange: async (sourceRoot) => {
        await execFile("git", [
          "-C",
          sourceRoot,
          "rm",
          "--cached",
          "--quiet",
          "--",
          "agent-bundle.toml",
        ]);
        await writeFile(join(sourceRoot, ".gitignore"), "agent-bundle.toml\n");
      },
    },
    {
      name: "tracked manifest symlink to ignored canonical target",
      arrange: async (sourceRoot) => {
        await rm(join(sourceRoot, "agent-bundle.toml"));
        await mkdir(join(sourceRoot, "generated"));
        await writeFile(
          join(sourceRoot, "generated", "agent-bundle.toml"),
          fixtureManifest,
        );
        await symlink(
          "generated/agent-bundle.toml",
          join(sourceRoot, "agent-bundle.toml"),
        );
        await writeFile(join(sourceRoot, ".gitignore"), "generated/\n");
      },
    },
    {
      name: "ignored intermediate symlink",
      arrange: async (sourceRoot) => {
        await replaceManifestWithSymlinkChain(sourceRoot, fixtureManifest);
        await writeFile(
          join(sourceRoot, ".gitignore"),
          "manifest-bridge.toml\n",
        );
      },
    },
  ];

  for (const manifestCase of cases) {
    await withSourceRepository(async (sourceRoot) => {
      await manifestCase.arrange(sourceRoot);
      await commitAll(sourceRoot, manifestCase.name);
      await withArtifactsRoot(async (artifactsRoot) => {
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "DIRTY_SOURCE"),
          manifestCase.name,
        );
      });
    });
  }
});

test("reads exact manifest bytes through a fully tracked symlink chain", async () => {
  await withSourceRepository(async (sourceRoot) => {
    const targetManifest = `${fixtureManifest}\n# tracked manifest target\n`;
    await replaceManifestWithSymlinkChain(sourceRoot, targetManifest);
    await commitAll(sourceRoot, "tracked manifest symlink chain");

    await withArtifactsRoot(async (artifactsRoot) => {
      const result = await buildBundle(bundleInput(sourceRoot, artifactsRoot));
      assert.equal(
        result.metadata.manifestDigest,
        createHash("sha256").update(targetManifest).digest("hex"),
      );
    });
  });
});

test("accepts a directly tracked executable manifest", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await chmod(join(sourceRoot, "agent-bundle.toml"), 0o755);
    await commitAll(sourceRoot, "executable manifest");

    await withArtifactsRoot(async (artifactsRoot) => {
      const result = await buildBundle(bundleInput(sourceRoot, artifactsRoot));
      assert.equal(
        result.metadata.manifestDigest,
        createHash("sha256").update(fixtureManifest).digest("hex"),
      );
    });
  });
});

test("maps a commit during tracked manifest reading to a changed build", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      await withSecondSnapshotCommit(sourceRoot, async () => {
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "SOURCE_CHANGED_DURING_BUILD"),
        );
      });
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

test("fails closed without changing pre-existing empty or sentinel digest targets", async () => {
  await withSourceRepository(async (sourceRoot) => {
    const expected = await expectedMetadata(sourceRoot);
    await withArtifactsRoot(async (artifactsRoot) => {
      for (const sentinel of [undefined, "sentinel\n"]) {
        const target = join(artifactsRoot, expected.metadata.bundleDigest);
        await mkdir(target);
        if (sentinel !== undefined) {
          await writeFile(join(target, "sentinel.txt"), sentinel);
        }
        const before = await lstat(target);
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "ARTIFACT_COLLISION"),
        );
        assert.equal((await lstat(target)).ino, before.ino);
        assert.deepEqual(
          await readdir(target),
          sentinel === undefined ? [] : ["sentinel.txt"],
        );
        if (sentinel !== undefined) {
          assert.equal(
            await readFile(join(target, "sentinel.txt"), "utf8"),
            sentinel,
          );
        }
        await rm(target, { recursive: true, force: true });
      }
    });
  });
});

test("fails closed when an existing cooperative lock is present without removing it", async () => {
  await withSourceRepository(async (sourceRoot) => {
    const expected = await expectedMetadata(sourceRoot);
    await withArtifactsRoot(async (artifactsRoot) => {
      const lock = join(
        artifactsRoot,
        `.${expected.metadata.bundleDigest}.lock`,
      );
      await mkdir(lock);
      await writeFile(join(lock, "owner"), "foreign\n");
      const before = await lstat(lock);

      await assert.rejects(
        buildBundle(bundleInput(sourceRoot, artifactsRoot)),
        (error) => assertArtifactError(error, "ARTIFACT_LOCKED"),
      );
      assert.equal((await lstat(lock)).ino, before.ino);
      assert.equal(await readFile(join(lock, "owner"), "utf8"), "foreign\n");
    });
  });
});

test("rejects a digest target injected after the final publication check without changing it", async () => {
  await withSourceRepository(async (sourceRoot) => {
    const expected = await expectedMetadata(sourceRoot);
    await withArtifactsRoot(async (artifactsRoot) => {
      const target = join(artifactsRoot, expected.metadata.bundleDigest);
      let before;
      setPublicationHook(async () => {
        await mkdir(target);
        await writeFile(join(target, "sentinel.txt"), "injected\n");
        before = await lstat(target);
      });
      try {
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "ARTIFACT_COLLISION"),
        );
      } finally {
        setPublicationHook(undefined);
      }
      assert.equal((await lstat(target)).ino, before.ino);
      assert.equal(
        await readFile(join(target, "sentinel.txt"), "utf8"),
        "injected\n",
      );
      assert.deepEqual(await readdir(artifactsRoot), [
        expected.metadata.bundleDigest,
      ]);
    });
  });
});

test("allows only one cooperating builder to publish while holding the digest lock", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      assert.deepEqual(await readdir(artifactsRoot), []);
      let releaseFirst;
      const firstPaused = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      let releasePause;
      const firstReady = new Promise((resolve) => {
        releasePause = resolve;
      });
      let calls = 0;
      artifactModule.__setArtifactTestHookForTests(async () => {
        calls += 1;
        if (calls === 1) {
          releasePause();
          await firstPaused;
        }
      });
      try {
        const first = buildBundle(bundleInput(sourceRoot, artifactsRoot));
        await firstReady;
        await assert.rejects(
          buildBundle(bundleInput(sourceRoot, artifactsRoot)),
          (error) => assertArtifactError(error, "ARTIFACT_LOCKED"),
        );
        releaseFirst();
        const result = await first;
        assert.equal(
          await readFile(
            join(result.artifactRoot, "bundle-metadata.json"),
            "utf8",
          ),
          `${JSON.stringify(result.metadata, null, 2)}\n`,
        );
        assert.deepEqual(await readdir(artifactsRoot), [
          result.metadata.bundleDigest,
        ]);
      } finally {
        artifactModule.__setArtifactTestHookForTests(undefined);
      }
    });
  });
});

test("rejects inherited and unrequested Oracle capability inputs", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      const inherited = Object.create({ oracle: { llmWikiRoot: "/tmp" } });
      await assert.rejects(
        buildBundle(
          bundleInput(sourceRoot, artifactsRoot, {
            requestedCapabilities: [],
            capabilityInputs: inherited,
          }),
        ),
        (error) => assertArtifactError(error, "UNREQUESTED_CAPABILITY_INPUT"),
      );
      await assert.rejects(
        buildBundle(
          bundleInput(sourceRoot, artifactsRoot, {
            capabilityInputs: inherited,
          }),
        ),
        (error) => assertArtifactError(error, "INVALID_INPUT"),
      );
      await assert.rejects(
        buildBundle(
          bundleInput(sourceRoot, artifactsRoot, {
            requestedCapabilities: [],
            capabilityInputs: { oracle: { llmWikiRoot: "/tmp" } },
          }),
        ),
        (error) => assertArtifactError(error, "UNREQUESTED_CAPABILITY_INPUT"),
      );
    });
  });
});

test("rejects symbol and extra capability input keys while accepting null-prototype Oracle input", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withArtifactsRoot(async (artifactsRoot) => {
      const symbolInput = { [Symbol("oracle")]: { llmWikiRoot: "/tmp" } };
      for (const capabilityInputs of [symbolInput, { extra: true }]) {
        await assert.rejects(
          buildBundle(
            bundleInput(sourceRoot, artifactsRoot, { capabilityInputs }),
          ),
          (error) => assertArtifactError(error, "INVALID_INPUT"),
        );
      }
      await withWikiRoot(async (llmWikiRoot) => {
        const capabilityInputs = Object.assign(Object.create(null), {
          oracle: { llmWikiRoot },
        });
        const result = await buildBundle(
          bundleInput(sourceRoot, artifactsRoot, { capabilityInputs }),
        );
        assert.deepEqual(result.metadata.enabledCapabilities, ["oracle"]);
        assert.equal(
          result.metadata.files.some(
            (file) => file.path === "agents/oracle.toml",
          ),
          true,
        );
      });
    });
  });
});
