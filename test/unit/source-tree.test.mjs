import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const sourceTreeModule = await import("../../dist/bundle/source-tree.js").catch(
  () => null,
);

const baseManifest = (files) => ({
  schemaVersion: 1,
  configSource: "config.toml",
  configKeys: [],
  configOverrides: {},
  allowedTokens: ["CODEX_HOME", "HOME", "LLM_WIKI_ROOT", "WORKSPACE_ROOT"],
  files,
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

const cleanFiles = () => [
  {
    source: "rules/default.rules",
    target: "rules/default.rules",
    mode: "0644",
    replacements: [],
  },
  {
    source: "hooks/safety.sh",
    target: "hooks/safety.sh",
    mode: "0755",
    replacements: [],
    capability: "oracle",
  },
  {
    source: "agents/advisor.toml",
    target: "agents/advisor.toml",
    mode: "0644",
    replacements: [],
  },
];

const sourceFixture = new URL(
  "../fixtures/source-codex/clean/",
  import.meta.url,
);

async function createSourceRepository() {
  const repository = await mkdtemp(join(tmpdir(), "andrew-code-agent-source-"));
  await cp(sourceFixture, repository, { recursive: true });
  await chmod(join(repository, "hooks/safety.sh"), 0o755);
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

function resolveSourceFiles(sourceRoot, manifest) {
  assert.notEqual(
    sourceTreeModule,
    null,
    "the built source-tree module must be available",
  );
  return sourceTreeModule.resolveSourceFiles(sourceRoot, manifest);
}

function assertSourceTreeError(error, code) {
  return (
    error instanceof sourceTreeModule.SourceTreeError && error.code === code
  );
}

test("resolves only declared regular files in stable target order", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(
      join(repository, "unlisted.txt"),
      "committed but unlisted\n",
    );
    await execFile("git", ["-C", repository, "add", "unlisted.txt"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "unlisted",
    ]);

    const files = await resolveSourceFiles(
      repository,
      baseManifest(cleanFiles()),
    );

    assert.deepEqual(
      files.map((file) => [file.targetPath, file.mode, file.capability]),
      [
        ["agents/advisor.toml", 0o644, undefined],
        ["hooks/safety.sh", 0o755, "oracle"],
        ["rules/default.rules", 0o644, undefined],
      ],
    );
    assert.deepEqual(
      files.map((file) => new TextDecoder().decode(file.bytes)),
      [
        'name = "advisor"\nmodel = "gpt-5"\n',
        "#!/bin/sh\nexit 0\n",
        "Always preserve the source boundary.\n",
      ],
    );
  });
});

test("rejects an exact manifest source that escapes through a symlink", async () => {
  await withSourceRepository(async (repository) => {
    const outside = await mkdtemp(join(tmpdir(), "andrew-code-agent-outside-"));
    try {
      await writeFile(join(outside, "secret.rules"), "outside\n");
      await mkdir(join(repository, "rules"), { recursive: true });
      await symlink(
        join(outside, "secret.rules"),
        join(repository, "rules", "escaped.rules"),
      );
      await execFile("git", ["-C", repository, "add", "--all"]);
      await execFile("git", [
        "-C",
        repository,
        "commit",
        "--quiet",
        "-m",
        "symlink canary",
      ]);

      await assert.rejects(
        resolveSourceFiles(
          repository,
          baseManifest([
            {
              source: "rules/escaped.rules",
              target: "rules/escaped.rules",
              mode: "0644",
              replacements: [],
            },
          ]),
        ),
        (error) => assertSourceTreeError(error, "SOURCE_PATH_ESCAPE"),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects output escapes, case collisions, and duplicate targets even for constructed manifests", async () => {
  await withSourceRepository(async (repository) => {
    const cases = [
      [
        "OUTPUT_PATH_ESCAPE",
        [
          {
            source: "rules/default.rules",
            target: "../escape",
            mode: "0644",
            replacements: [],
          },
        ],
      ],
      [
        "CASE_COLLIDING_TARGET",
        [
          {
            source: "rules/default.rules",
            target: "Rules/default.rules",
            mode: "0644",
            replacements: [],
          },
          {
            source: "agents/advisor.toml",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ],
      ],
      [
        "DUPLICATE_TARGET",
        [
          {
            source: "rules/default.rules",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
          {
            source: "agents/advisor.toml",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ],
      ],
    ];

    for (const [code, files] of cases) {
      await assert.rejects(
        resolveSourceFiles(repository, baseManifest(files)),
        (error) => assertSourceTreeError(error, code),
      );
    }
  });
});

test("rejects FIFO sources and source modes that do not exactly match the manifest", async () => {
  await withSourceRepository(async (repository) => {
    const fifoPath = join(repository, "rules", "canary.fifo");
    await execFile("mkfifo", [fifoPath]);

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/canary.fifo",
            target: "rules/canary.fifo",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "NON_REGULAR_SOURCE"),
    );

    await rm(fifoPath);
    await chmod(join(repository, "rules/default.rules"), 0o755);
    await execFile("git", ["-C", repository, "add", "rules/default.rules"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "mode canary",
    ]);
    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/default.rules",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "UNEXPECTED_MODE"),
    );
  });
});

test("rejects tracked and untracked source dirt before reading source files", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, "rules/default.rules"), "changed\n");
    await assert.rejects(
      resolveSourceFiles(repository, baseManifest(cleanFiles())),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );

    await execFile("git", [
      "-C",
      repository,
      "checkout",
      "--",
      "rules/default.rules",
    ]);
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    await assert.rejects(
      resolveSourceFiles(repository, baseManifest(cleanFiles())),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});
