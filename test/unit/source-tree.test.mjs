import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
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
const pathCanaryFixture = new URL(
  "../fixtures/source-codex/path-canary/",
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

async function withMutatingGitShim(repository, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-code-agent-git-"));
  const markerPath = join(shimDirectory, "mutated");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  await writeFile(
    shimPath,
    `#!/bin/sh
if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ] && [ ! -e "$ANDREW_AGENT_TEST_GIT_MARKER" ]; then
  "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
  printf '%s\\n' 'changed after source snapshot' > "$ANDREW_AGENT_TEST_MUTATE_PATH"
  : > "$ANDREW_AGENT_TEST_GIT_MARKER"
  exit 0
fi
exec "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
`,
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
  process.env.ANDREW_AGENT_TEST_REAL_GIT = gitPath;
  process.env.ANDREW_AGENT_TEST_GIT_MARKER = markerPath;
  process.env.ANDREW_AGENT_TEST_MUTATE_PATH = join(
    repository,
    "rules/default.rules",
  );
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.ANDREW_AGENT_TEST_REAL_GIT;
    delete process.env.ANDREW_AGENT_TEST_GIT_MARKER;
    delete process.env.ANDREW_AGENT_TEST_MUTATE_PATH;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function resolveWithSourceSwap(repository, externalPath, manifest) {
  const sourcePath = await realpath(join(repository, "rules/default.rules"));
  const backupPath = join(repository, "rules/default.rules.test-backup");
  const virtualModule = `
import { lstat as realLstat, open, readFile as realReadFile, realpath, rename, rm, symlink } from "node:fs/promises";
let sourceLstatCalls = 0;
let swapped = false;
export { open, realpath };
export async function lstat(path, options) {
  const result = await realLstat(path, options);
  if (path === process.env.ANDREW_AGENT_TEST_SOURCE_PATH && ++sourceLstatCalls === 2) {
    await rename(path, process.env.ANDREW_AGENT_TEST_BACKUP_PATH);
    await symlink(process.env.ANDREW_AGENT_TEST_EXTERNAL_PATH, path);
    swapped = true;
  }
  return result;
}
export async function readFile(path, options) {
  const result = await realReadFile(path, options);
  if (path === process.env.ANDREW_AGENT_TEST_SOURCE_PATH && swapped) {
    await rm(path);
    await rename(process.env.ANDREW_AGENT_TEST_BACKUP_PATH, path);
    swapped = false;
  }
  return result;
}
`;
  const childScript = `
import { registerHooks } from "node:module";
import { lstat, rename, rm } from "node:fs/promises";
const virtualModule = ${JSON.stringify(virtualModule)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:fs/promises" && context.parentURL === process.env.ANDREW_AGENT_TEST_MODULE_URL)
      return { shortCircuit: true, url: "andrew-test:fs-promises" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "andrew-test:fs-promises")
      return { format: "module", shortCircuit: true, source: virtualModule };
    return nextLoad(url, context);
  },
});
const sourceTree = await import(process.env.ANDREW_AGENT_TEST_MODULE_URL);
let outcome;
try {
  const files = await sourceTree.resolveSourceFiles(
    process.env.ANDREW_AGENT_TEST_REPOSITORY,
    JSON.parse(process.env.ANDREW_AGENT_TEST_MANIFEST),
  );
  outcome = { bytes: Buffer.from(files[0].bytes).toString("utf8") };
} catch (error) {
  outcome = { code: error.code };
} finally {
  try {
    if ((await lstat(process.env.ANDREW_AGENT_TEST_SOURCE_PATH)).isSymbolicLink()) {
      await rm(process.env.ANDREW_AGENT_TEST_SOURCE_PATH);
      await rename(
        process.env.ANDREW_AGENT_TEST_BACKUP_PATH,
        process.env.ANDREW_AGENT_TEST_SOURCE_PATH,
      );
    }
  } catch {}
}
process.stdout.write(JSON.stringify(outcome));
`;
  const moduleUrl =
    process.env.ANDREW_AGENT_TEST_SOURCE_TREE_MODULE ??
    new URL("../../dist/bundle/source-tree.js", import.meta.url).href;
  const { stdout } = await execFile(
    process.execPath,
    ["--input-type=module", "--eval", childScript],
    {
      env: {
        ...process.env,
        ANDREW_AGENT_TEST_BACKUP_PATH: backupPath,
        ANDREW_AGENT_TEST_EXTERNAL_PATH: externalPath,
        ANDREW_AGENT_TEST_MANIFEST: JSON.stringify(manifest),
        ANDREW_AGENT_TEST_MODULE_URL: moduleUrl,
        ANDREW_AGENT_TEST_REPOSITORY: repository,
        ANDREW_AGENT_TEST_SOURCE_PATH: sourcePath,
      },
    },
  );
  return JSON.parse(stdout);
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

test("rejects an exact manifest source that escapes through a symlink", async () => {
  await withSourceRepository(async (repository) => {
    const outside = await mkdtemp(join(tmpdir(), "andrew-code-agent-outside-"));
    try {
      await writeFile(join(outside, "secret.rules"), "outside\n");
      await mkdir(join(repository, "rules"), { recursive: true });
      await cp(pathCanaryFixture, join(repository, "rules"), {
        recursive: true,
      });
      await rm(join(repository, "rules", "escaped.rules"));
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

test("rejects a nested directory instead of discovering its parent Git worktree", async () => {
  await withSourceRepository(async (repository) => {
    await assert.rejects(
      resolveSourceFiles(join(repository, "rules"), baseManifest(cleanFiles())),
      (error) => assertSourceTreeError(error, "SOURCE_ROOT_NOT_GIT_ROOT"),
    );
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

test("rejects non-ASCII portable targets, including NFC and NFD case-fold canaries", async () => {
  await withSourceRepository(async (repository) => {
    const targets = [
      "unicode/caf\u00e9.toml",
      "unicode/cafe\u0301.toml",
      "unicode/\u00df.toml",
    ];

    for (const target of targets) {
      await assert.rejects(
        resolveSourceFiles(
          repository,
          baseManifest([
            {
              source: "rules/default.rules",
              target,
              mode: "0644",
              replacements: [],
            },
          ]),
        ),
        (error) => assertSourceTreeError(error, "NON_PORTABLE_TARGET"),
      );
    }

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/default.rules",
            target: targets[0],
            mode: "0644",
            replacements: [],
          },
          {
            source: "agents/advisor.toml",
            target: targets[1],
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "NON_PORTABLE_TARGET"),
    );
  });
});

test("normalizes owner-only modes while rejecting every other mismatch", async () => {
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
    await chmod(join(repository, "rules/default.rules"), 0o600);
    await chmod(join(repository, "hooks/safety.sh"), 0o700);
    const normalized = await resolveSourceFiles(
      repository,
      baseManifest(cleanFiles()),
    );
    assert.deepEqual(
      normalized.map((file) => [file.targetPath, file.mode]),
      [
        ["agents/advisor.toml", 0o644],
        ["hooks/safety.sh", 0o755],
        ["rules/default.rules", 0o644],
      ],
    );

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

test("rejects Unix socket sources without creating a device node", async () => {
  await withSourceRepository(async (repository) => {
    const socketPath = join(repository, "rules", "canary.socket");
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    try {
      await assert.rejects(
        resolveSourceFiles(
          repository,
          baseManifest([
            {
              source: "rules/canary.socket",
              target: "rules/canary.socket",
              mode: "0644",
              replacements: [],
            },
          ]),
        ),
        (error) => assertSourceTreeError(error, "NON_REGULAR_SOURCE"),
      );
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });
});

test("rejects unstaged, staged-only, and untracked source dirt before reading source files", async () => {
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
    await writeFile(join(repository, "rules/default.rules"), "staged only\n");
    await execFile("git", ["-C", repository, "add", "rules/default.rules"]);
    await assert.rejects(
      resolveSourceFiles(repository, baseManifest(cleanFiles())),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );

    await execFile("git", ["-C", repository, "reset", "--hard", "HEAD"]);
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    await assert.rejects(
      resolveSourceFiles(repository, baseManifest(cleanFiles())),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});

test("rejects a selected file changed after the initial clean source snapshot", async () => {
  await withSourceRepository(async (repository) => {
    await withMutatingGitShim(repository, async () => {
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
        (error) => assertSourceTreeError(error, "SOURCE_CHANGED_DURING_READ"),
      );
    });
  });
});

test("rejects an external symlink swapped in after the initial clean snapshot", async () => {
  await withSourceRepository(async (repository) => {
    const outside = await mkdtemp(join(tmpdir(), "andrew-code-agent-outside-"));
    try {
      const externalPath = join(outside, "secret.rules");
      await writeFile(externalPath, "external secret bytes\n");
      const outcome = await resolveWithSourceSwap(
        repository,
        externalPath,
        baseManifest([
          {
            source: "rules/default.rules",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      );
      assert.deepEqual(outcome, { code: "NON_REGULAR_SOURCE" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

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
