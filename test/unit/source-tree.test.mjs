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

async function withPoisonedGitEnvironment(environment, run) {
  const previous = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function withMutatingGitShim(repository, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-code-agent-git-"));
  const markerPath = join(shimDirectory, "mutated");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  const mutatePath = join(repository, "rules/default.rules");
  await writeFile(
    shimPath,
    `#!/bin/sh
ANDREW_AGENT_TEST_GIT_MARKER=${shellQuote(markerPath)}
ANDREW_AGENT_TEST_MUTATE_PATH=${shellQuote(mutatePath)}
ANDREW_AGENT_TEST_REAL_GIT=${shellQuote(gitPath)}
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
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function withDeindexingGitShim(repository, sourcePath, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-code-agent-git-"));
  const markerPath = join(shimDirectory, "mutated");
  const outputPath = join(shimDirectory, "ls-files-output");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  await writeFile(
    shimPath,
    `#!/bin/sh
ANDREW_AGENT_TEST_DEINDEX_PATH=${shellQuote(sourcePath)}
ANDREW_AGENT_TEST_GIT_MARKER=${shellQuote(markerPath)}
ANDREW_AGENT_TEST_GIT_OUTPUT=${shellQuote(outputPath)}
ANDREW_AGENT_TEST_REAL_GIT=${shellQuote(gitPath)}
ANDREW_AGENT_TEST_REPOSITORY=${shellQuote(repository)}
if [ "$4" = "ls-files" ] && [ ! -e "$ANDREW_AGENT_TEST_GIT_MARKER" ]; then
  "$ANDREW_AGENT_TEST_REAL_GIT" "$@" > "$ANDREW_AGENT_TEST_GIT_OUTPUT" || exit $?
  "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" rm --cached --quiet -- "$ANDREW_AGENT_TEST_DEINDEX_PATH" || exit $?
  printf '%s\\n' "$ANDREW_AGENT_TEST_DEINDEX_PATH" > "$ANDREW_AGENT_TEST_REPOSITORY/.gitignore"
  "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" add .gitignore || exit $?
  "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" commit --quiet -m 'deindex source canary' || exit $?
  : > "$ANDREW_AGENT_TEST_GIT_MARKER"
  cat "$ANDREW_AGENT_TEST_GIT_OUTPUT"
  exit 0
fi
exec "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
`,
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function withLsFilesGitShim(repository, mode, sourcePath, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-code-agent-git-"));
  const markerPath = join(shimDirectory, "handled");
  const outputPath = join(shimDirectory, "ls-files-output");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  const mutatePath = join(repository, sourcePath);
  await writeFile(
    shimPath,
    `#!/bin/sh
ANDREW_AGENT_TEST_GIT_LS_FILES_MODE=${shellQuote(mode)}
ANDREW_AGENT_TEST_GIT_MARKER=${shellQuote(markerPath)}
ANDREW_AGENT_TEST_GIT_OUTPUT=${shellQuote(outputPath)}
ANDREW_AGENT_TEST_MUTATE_PATH=${shellQuote(mutatePath)}
ANDREW_AGENT_TEST_REAL_GIT=${shellQuote(gitPath)}
ANDREW_AGENT_TEST_REPOSITORY=${shellQuote(repository)}
if [ "$4" = "ls-files" ] && [ "$5" = "--cached" ] && [ ! -e "$ANDREW_AGENT_TEST_GIT_MARKER" ]; then
  "$ANDREW_AGENT_TEST_REAL_GIT" "$@" > "$ANDREW_AGENT_TEST_GIT_OUTPUT" || exit $?
  case "$ANDREW_AGENT_TEST_GIT_LS_FILES_MODE" in
    mutate)
      "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" update-index --assume-unchanged -- "$ANDREW_AGENT_TEST_MUTATE_PATH" || exit $?
      printf '%s\\n' 'hidden after closure check' > "$ANDREW_AGENT_TEST_MUTATE_PATH" || exit $?
      ;;
    missing-terminal-nul)
      byte_count=$(wc -c < "$ANDREW_AGENT_TEST_GIT_OUTPUT" | tr -d ' ')
      dd if="$ANDREW_AGENT_TEST_GIT_OUTPUT" bs=1 count=$((byte_count - 1)) 2>/dev/null > "$ANDREW_AGENT_TEST_GIT_OUTPUT.truncated" || exit $?
      mv "$ANDREW_AGENT_TEST_GIT_OUTPUT.truncated" "$ANDREW_AGENT_TEST_GIT_OUTPUT" || exit $?
      ;;
    extra-nul)
      printf '\\0' >> "$ANDREW_AGENT_TEST_GIT_OUTPUT"
      ;;
    duplicate)
      cp "$ANDREW_AGENT_TEST_GIT_OUTPUT" "$ANDREW_AGENT_TEST_GIT_OUTPUT.duplicate" || exit $?
      cat "$ANDREW_AGENT_TEST_GIT_OUTPUT.duplicate" >> "$ANDREW_AGENT_TEST_GIT_OUTPUT" || exit $?
      ;;
  esac
  : > "$ANDREW_AGENT_TEST_GIT_MARKER"
  cat "$ANDREW_AGENT_TEST_GIT_OUTPUT"
  exit 0
fi
exec "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
`,
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function withRetargetingGitShim(repository, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-code-agent-git-"));
  const markerPath = join(shimDirectory, "retargeted");
  const shimPath = join(shimDirectory, "git");
  const { stdout } = await execFile("which", ["git"]);
  const gitPath = stdout.trim();
  const retargetPath = join(repository, "rules/selected.rules");
  await writeFile(
    shimPath,
    `#!/bin/sh
ANDREW_AGENT_TEST_GIT_MARKER=${shellQuote(markerPath)}
ANDREW_AGENT_TEST_REAL_GIT=${shellQuote(gitPath)}
ANDREW_AGENT_TEST_REPOSITORY=${shellQuote(repository)}
ANDREW_AGENT_TEST_RETARGET_PATH=${shellQuote(retargetPath)}
if [ "$3" = "diff" ] && [ ! -e "$ANDREW_AGENT_TEST_GIT_MARKER" ]; then
  /bin/rm -- "$ANDREW_AGENT_TEST_RETARGET_PATH" || exit $?
  /bin/ln -s new.rules "$ANDREW_AGENT_TEST_RETARGET_PATH" || exit $?
  "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" add -- rules/selected.rules || exit $?
  "$ANDREW_AGENT_TEST_REAL_GIT" -C "$ANDREW_AGENT_TEST_REPOSITORY" commit --quiet -m 'retarget source canary' || exit $?
  : > "$ANDREW_AGENT_TEST_GIT_MARKER"
fi
exec "$ANDREW_AGENT_TEST_REAL_GIT" "$@"
`,
  );
  await chmod(shimPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
  try {
    await run();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function resolveWithSourceSwap(repository, externalPath, manifest) {
  const sourcePath = await realpath(join(repository, "rules/default.rules"));
  const backupPath = join(repository, "rules/default.rules.test-backup");
  const virtualModule = `
import { lstat as realLstat, open, readFile as realReadFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
let sourceLstatCalls = 0;
let swapped = false;
export { open, readlink, realpath };
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

function readTrackedSourceFileBytes(sourceRoot, source) {
  assert.notEqual(
    sourceTreeModule,
    null,
    "the built source-tree module must be available",
  );
  return sourceTreeModule.readTrackedSourceFileBytes(sourceRoot, source);
}

function assertSourceTreeError(error, code) {
  return (
    error instanceof sourceTreeModule.SourceTreeError && error.code === code
  );
}

test("reads source repo A under inherited Git repository redirects", async () => {
  await withSourceRepository(async (sourceRoot) => {
    await withSourceRepository(async (poisonRoot) => {
      await writeFile(
        join(poisonRoot, "rules", "default.rules"),
        "poison repository bytes\n",
      );
      await execFile("git", [
        "-C",
        poisonRoot,
        "add",
        "--",
        "rules/default.rules",
      ]);

      const files = await withPoisonedGitEnvironment(
        {
          GIT_DIR: join(poisonRoot, ".git"),
          GIT_WORK_TREE: sourceRoot,
          GIT_INDEX_FILE: join(poisonRoot, ".git", "index"),
        },
        () =>
          resolveSourceFiles(
            sourceRoot,
            baseManifest([
              {
                source: "rules/default.rules",
                target: "rules/default.rules",
                mode: "0644",
                replacements: [],
              },
            ]),
          ),
      );

      assert.equal(
        Buffer.from(files[0].bytes).toString("utf8"),
        "Always preserve the source boundary.\n",
      );
    });
  });
});

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

for (const [indexFlag, contents] of [
  ["--assume-unchanged", "assume-hidden bytes\n"],
  ["--skip-worktree", "skip-hidden bytes\n"],
]) {
  test(`rejects a modified direct selected file hidden by ${indexFlag}`, async () => {
    await withSourceRepository(async (repository) => {
      await execFile("git", [
        "-C",
        repository,
        "update-index",
        indexFlag,
        "--",
        "rules/default.rules",
      ]);
      await writeFile(join(repository, "rules/default.rules"), contents);

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
        (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
        indexFlag,
      );
    });
  });
}

test("rejects index-hidden traversed symlinks and canonical selected targets", async () => {
  const cases = [
    ["rules/selected.rules", "--assume-unchanged"],
    ["rules/default.rules", "--skip-worktree"],
  ];

  for (const [path, indexFlag] of cases) {
    await withSourceRepository(async (repository) => {
      await symlink("default.rules", join(repository, "rules/selected.rules"));
      await execFile("git", [
        "-C",
        repository,
        "add",
        "--",
        "rules/selected.rules",
      ]);
      await execFile("git", [
        "-C",
        repository,
        "commit",
        "--quiet",
        "-m",
        "tracked source symlink",
      ]);
      await execFile("git", [
        "-C",
        repository,
        "update-index",
        indexFlag,
        "--",
        path,
      ]);

      await assert.rejects(
        resolveSourceFiles(
          repository,
          baseManifest([
            {
              source: "rules/selected.rules",
              target: "rules/default.rules",
              mode: "0644",
              replacements: [],
            },
          ]),
        ),
        (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
        `${path} ${indexFlag}`,
      );
    });
  }
});

test("allows an index-hidden unrelated tracked file", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, "unrelated.rules"), "original\n");
    await execFile("git", ["-C", repository, "add", "--", "unrelated.rules"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "unrelated source canary",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "update-index",
      "--assume-unchanged",
      "--",
      "unrelated.rules",
    ]);
    await writeFile(join(repository, "unrelated.rules"), "hidden unrelated bytes\n");

    const files = await resolveSourceFiles(
      repository,
      baseManifest([
        {
          source: "rules/default.rules",
          target: "rules/default.rules",
          mode: "0644",
          replacements: [],
        },
      ]),
    );

    assert.equal(files.length, 1);
    assert.equal(
      new TextDecoder().decode(files[0].bytes),
      "Always preserve the source boundary.\n",
    );
  });
});

test("rejects an ignored manifest source absent from the Git index", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, ".gitignore"), "rules/ignored.rules\n");
    await execFile("git", ["-C", repository, "add", ".gitignore"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "ignore source canary",
    ]);
    await writeFile(join(repository, "rules/ignored.rules"), "ignored\n");

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/ignored.rules",
            target: "rules/ignored.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});

test("rejects an ignored selected symlink path absent from the Git index", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, ".gitignore"), "rules/ignored-link.rules\n");
    await symlink("default.rules", join(repository, "rules/ignored-link.rules"));
    await execFile("git", ["-C", repository, "add", ".gitignore"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "ignore selected path canary",
    ]);

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/ignored-link.rules",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});

test("rejects an ignored canonical source path absent from the Git index", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, ".gitignore"), "rules/ignored.rules\n");
    await writeFile(join(repository, "rules/ignored.rules"), "ignored\n");
    await symlink("ignored.rules", join(repository, "rules/tracked-link.rules"));
    await execFile("git", [
      "-C",
      repository,
      "add",
      ".gitignore",
      "rules/tracked-link.rules",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "ignore canonical path canary",
    ]);

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/tracked-link.rules",
            target: "rules/ignored.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});

test("rejects an ignored intermediate symlink absent from the Git index", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, ".gitignore"), "rules/bridge.rules\n");
    await symlink("default.rules", join(repository, "rules/bridge.rules"));
    await symlink("bridge.rules", join(repository, "rules/selected.rules"));
    await execFile("git", [
      "-C",
      repository,
      "add",
      ".gitignore",
      "rules/selected.rules",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "ignore intermediate symlink canary",
    ]);

    await assert.rejects(
      resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/selected.rules",
            target: "rules/default.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      ),
      (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
    );
  });
});

test("resolves a fully tracked symlink chain", async () => {
  await withSourceRepository(async (repository) => {
    await symlink("default.rules", join(repository, "rules/bridge.rules"));
    await symlink("bridge.rules", join(repository, "rules/selected.rules"));
    await execFile("git", [
      "-C",
      repository,
      "add",
      "rules/bridge.rules",
      "rules/selected.rules",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "tracked symlink chain",
    ]);

    const files = await resolveSourceFiles(
      repository,
      baseManifest([
        {
          source: "rules/selected.rules",
          target: "rules/default.rules",
          mode: "0644",
          replacements: [],
        },
      ]),
    );

    assert.equal(
      new TextDecoder().decode(files[0].bytes),
      "Always preserve the source boundary.\n",
    );
  });
});

test("does not require a synthetic descendant beneath a tracked symlink", async () => {
  await withSourceRepository(async (repository) => {
    await symlink("rules", join(repository, "linked-rules"));
    await execFile("git", ["-C", repository, "add", "linked-rules"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "tracked directory symlink",
    ]);

    const files = await resolveSourceFiles(
      repository,
      baseManifest([
        {
          source: "linked-rules/default.rules",
          target: "rules/default.rules",
          mode: "0644",
          replacements: [],
        },
      ]),
    );

    assert.equal(
      new TextDecoder().decode(files[0].bytes),
      "Always preserve the source boundary.\n",
    );
  });
});

test("rejects a source de-indexed after the initial revision snapshot", async () => {
  await withSourceRepository(async (repository) => {
    await withDeindexingGitShim(
      repository,
      "rules/default.rules",
      async () => {
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
          (error) =>
            assertSourceTreeError(error, "SOURCE_CHANGED_DURING_READ"),
        );
      },
    );
  });
});

test("rejects a selected flag introduced after the initial closure check before returning resolved sources", async () => {
  await withSourceRepository(async (repository) => {
    await withLsFilesGitShim(
      repository,
      "mutate",
      "rules/default.rules",
      async () => {
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
          (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
        );
      },
    );
  });
});

test("rejects a selected flag introduced after the initial closure check before returning tracked bytes", async () => {
  await withSourceRepository(async (repository) => {
    await withLsFilesGitShim(
      repository,
      "mutate",
      "rules/default.rules",
      async () => {
        await assert.rejects(
          readTrackedSourceFileBytes(repository, "rules/default.rules"),
          (error) => assertSourceTreeError(error, "DIRTY_SOURCE"),
        );
      },
    );
  });
});

for (const [mode, description] of [
  ["missing-terminal-nul", "a missing final NUL"],
  ["extra-nul", "an extra empty record"],
  ["duplicate", "a duplicate record"],
]) {
  test(`rejects ${description} from exact selected index output`, async () => {
    await withSourceRepository(async (repository) => {
      await withLsFilesGitShim(
        repository,
        mode,
        "rules/default.rules",
        async () => {
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
            (error) => assertSourceTreeError(error, "SOURCE_GIT_ERROR"),
          );
        },
      );
    });
  });
}

test("uses a symlink target committed before the initial source snapshot", async () => {
  await withSourceRepository(async (repository) => {
    await writeFile(join(repository, "rules/old.rules"), "old revision bytes\n");
    await writeFile(join(repository, "rules/new.rules"), "new revision bytes\n");
    await symlink("old.rules", join(repository, "rules/selected.rules"));
    await execFile("git", ["-C", repository, "add", "--all"]);
    await execFile("git", [
      "-C",
      repository,
      "commit",
      "--quiet",
      "-m",
      "symlink revision canary",
    ]);

    await withRetargetingGitShim(repository, async () => {
      const files = await resolveSourceFiles(
        repository,
        baseManifest([
          {
            source: "rules/selected.rules",
            target: "rules/selected.rules",
            mode: "0644",
            replacements: [],
          },
        ]),
      );

      assert.equal(
        new TextDecoder().decode(files[0].bytes),
        "new revision bytes\n",
      );
    });
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
