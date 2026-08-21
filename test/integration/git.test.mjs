import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const gitModule = await import("../../dist/runtime/git.js").catch(() => null);
const gitOverrideNames = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
];

function requireGit() {
  assert.notEqual(
    gitModule,
    null,
    "the built runtime git module must be available",
  );
  return gitModule;
}

async function git(repository, args) {
  return execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
  });
}

async function rawGit(repository, args) {
  return execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: { ...cleanGitEnvironment(), GIT_NO_REPLACE_OBJECTS: "1" },
  });
}

function cleanGitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of gitOverrideNames) delete env[name];
  return env;
}

async function withRepository(run) {
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-git-")),
  );
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await git(repository, ["config", "user.name", "Test User"]);
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "--quiet", "-m", "initial"]);
  try {
    await run(repository);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

async function withGitlinkSource(run) {
  await withRepository(async (source) => {
    const sourceHead = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
    await withRepository(async (repository) => {
      await run({ repository, source, sourceHead });
    });
  });
}

async function withGitShim(repository, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-agent-git-shim-"));
  const shimPath = join(shimDirectory, "git");
  const realGit = (await execFile("which", ["git"], { encoding: "utf8" })).stdout.trim();
  const statePath = join(shimDirectory, "first-index-check-complete");
  const originalPath = process.env.PATH;
  await writeFile(
    shimPath,
    `#!/bin/sh\n"${realGit}" "$@"\ncommand_exit=$?\nif [ "$1" = "-C" ] && [ "$3" = "ls-files" ] && [ ! -e "${statePath}" ]; then\n  : > "${statePath}"\n  "${realGit}" -C "${repository}" update-index --assume-unchanged tracked.txt\nfi\nexit "$command_exit"\n`,
  );
  await chmod(shimPath, 0o755);
  process.env.PATH = `${shimDirectory}:${originalPath}`;
  try {
    await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function withGitListingShim(indexEntries, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-agent-git-shim-"));
  const shimPath = join(shimDirectory, "git");
  const realGit = (await execFile("which", ["git"], { encoding: "utf8" })).stdout.trim();
  const listingBase64 = Buffer.from(indexEntries, "utf8").toString("base64");
  const originalPath = process.env.PATH;
  await writeFile(
    shimPath,
    `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nif (args[0] === "-C" && args[2] === "ls-files") {\n  process.stdout.write(Buffer.from("${listingBase64}", "base64"));\n  process.exit(0);\n}\nconst result = spawnSync("${realGit}", args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
  );
  await chmod(shimPath, 0o755);
  process.env.PATH = `${shimDirectory}:${originalPath}`;
  try {
    await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

async function withSecondHeadMutationShim(repository, flag, run) {
  const shimDirectory = await mkdtemp(join(tmpdir(), "andrew-agent-git-shim-"));
  const shimPath = join(shimDirectory, "git");
  const realGit = (await execFile("which", ["git"], { encoding: "utf8" })).stdout.trim();
  const headCountPath = join(shimDirectory, "head-count");
  const originalPath = process.env.PATH;
  await writeFile(
    shimPath,
    `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then\n  head_count=0\n  if [ -e "${headCountPath}" ]; then\n    head_count=$(cat "${headCountPath}")\n  fi\n  head_count=$((head_count + 1))\n  printf '%s' "$head_count" > "${headCountPath}"\n  if [ "$head_count" -eq 2 ]; then\n    head_output=$("${realGit}" "$@")\n    command_exit=$?\n    printf '%s\\n' "$head_output"\n    if [ "$command_exit" -eq 0 ]; then\n      "${realGit}" -C "${repository}" update-index ${flag} tracked.txt\n      printf '%s\\n' 'hidden after second HEAD read' > "${repository}/tracked.txt"\n    fi\n    exit "$command_exit"\n  fi\nfi\nexec "${realGit}" "$@"\n`,
  );
  await chmod(shimPath, 0o755);
  process.env.PATH = `${shimDirectory}:${originalPath}`;
  try {
    await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDirectory, { recursive: true, force: true });
  }
}

test("captures a clean nested worktree exactly without mutation", async () => {
  await withRepository(async (repository) => {
    const nested = join(repository, "nested");
    await mkdir(nested);
    const before = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;
    const head = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const snapshot = await requireGit().readGitSnapshot(nested);
    const after = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;

    assert.deepEqual(snapshot, {
      repositoryRoot: repository,
      head,
      porcelainV2: before,
      clean: true,
    });
    assert.equal(after, before);
    assert.equal(await requireGit().resolveRepositoryRoot(nested), repository);
    assert.equal(requireGit().assertCleanGitSnapshot(snapshot), snapshot);
  });
});

test("reports tracked, staged, and untracked bytes and preserves an untracked canary", async () => {
  await withRepository(async (repository) => {
    await writeFile(join(repository, "tracked.txt"), "changed\n");
    let snapshot = await requireGit().readGitSnapshot(repository);
    assert.equal(snapshot.clean, false);
    assert.match(snapshot.porcelainV2, /^1 \.M /m);

    await git(repository, ["add", "tracked.txt"]);
    snapshot = await requireGit().readGitSnapshot(repository);
    assert.match(snapshot.porcelainV2, /^1 M\. /m);

    const canaryPath = join(repository, "untracked-canary.txt");
    await writeFile(canaryPath, "do not mutate\n");
    const beforeStatus = (
      await git(repository, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ])
    ).stdout;
    await assert.rejects(
      async () =>
        requireGit().assertCleanGitSnapshot(
          await requireGit().readGitSnapshot(repository),
        ),
      { code: "GIT_WORKTREE_DIRTY" },
    );
    assert.equal(await readFile(canaryPath, "utf8"), "do not mutate\n");
    assert.equal(
      (
        await git(repository, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ])
      ).stdout,
      beforeStatus,
    );
  });
});

for (const [flag, label] of [
  ["--assume-unchanged", "assume-unchanged"],
  ["--skip-worktree", "skip-worktree"],
]) {
  test(`rejects a modified tracked file hidden by ${label}`, async () => {
    await withRepository(async (repository) => {
      await git(repository, ["update-index", flag, "tracked.txt"]);
      await writeFile(join(repository, "tracked.txt"), "hidden change\n");

      await assert.rejects(
        requireGit().readGitSnapshot(repository),
        { code: "GIT_WORKTREE_DIRTY" },
      );
    });
  });
}

for (const [flag, label] of [
  ["--assume-unchanged", "assume-unchanged"],
  ["--skip-worktree", "skip-worktree"],
]) {
  test(`rejects an unchanged tracked file flagged ${label}`, async () => {
    await withRepository(async (repository) => {
      await git(repository, ["update-index", flag, "tracked.txt"]);

      await assert.rejects(
        requireGit().readGitSnapshot(repository),
        { code: "GIT_WORKTREE_DIRTY" },
      );
    });
  });
}

test("accepts a clean tracked filename containing a newline", async () => {
  await withRepository(async (repository) => {
    const unusualFilename = "tracked\nfilename.txt";
    await writeFile(join(repository, unusualFilename), "unchanged\n");
    await git(repository, ["add", unusualFilename]);
    await git(repository, ["commit", "--quiet", "-m", "unusual filename"]);

    const snapshot = await requireGit().readGitSnapshot(repository);

    assert.equal(snapshot.clean, true);
    assert.equal(snapshot.porcelainV2, "");
  });
});

test("rejects a flag introduced after the initial index flag check", async () => {
  await withRepository(async (repository) => {
    await withGitShim(repository, async () => {
      await assert.rejects(
        requireGit().readGitSnapshot(repository),
        { code: "GIT_WORKTREE_DIRTY" },
      );
    });
  });
});

for (const [flag, label] of [
  ["--assume-unchanged", "assume-unchanged"],
  ["--skip-worktree", "skip-worktree"],
]) {
  test(`rejects ${label} introduced after the second HEAD read`, async () => {
    await withRepository(async (repository) => {
      await withSecondHeadMutationShim(repository, flag, async () => {
        await assert.rejects(
          requireGit().readGitSnapshot(repository),
          { code: "GIT_WORKTREE_DIRTY" },
        );
      });
    });
  });
}

for (const [label, indexEntries] of [
  ["a missing terminal NUL", "H 100644 0123456789012345678901234567890123456789 0\ttracked.txt"],
  ["an extra terminal empty record", "H 100644 0123456789012345678901234567890123456789 0\ttracked.txt\0\0"],
  ["an empty internal record", "H 100644 0123456789012345678901234567890123456789 0\ttracked.txt\0\0H 100644 0123456789012345678901234567890123456789 0\tsecond.txt\0"],
  ["a malformed tag and stage shape", "H100644 0123456789012345678901234567890123456789 0\ttracked.txt\0"],
]) {
  test(`maps ${label} from ls-files to GIT_STATUS_FAILED`, async () => {
    await withRepository(async (repository) => {
      await withGitListingShim(indexEntries, async () => {
        await assert.rejects(
          requireGit().readGitSnapshot(repository),
          { code: "GIT_STATUS_FAILED" },
        );
      });
    });
  });
}

test("rejects initialized submodules even when status ignores their dirt", async () => {
  await withGitlinkSource(async ({ repository, source }) => {
    await git(repository, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      source,
      "modules/source",
    ]);
    await git(repository, ["commit", "--quiet", "-am", "add submodule"]);

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });

    await git(repository, ["config", "submodule.modules/source.ignore", "all"]);
    await writeFile(join(repository, "modules", "source", "tracked.txt"), "dirty\n");

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });
  });
});

test("rejects a raw HEAD gitlink hidden by a replacement tree", async () => {
  await withGitlinkSource(async ({ repository, sourceHead }) => {
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sourceHead},raw-gitlink`,
    ]);
    await git(repository, ["commit", "--quiet", "-m", "raw gitlink"]);
    const rawHead = (await rawGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const parent = (await rawGit(repository, ["rev-parse", "HEAD^"])).stdout.trim();
    const parentTree = (await rawGit(repository, ["rev-parse", `${parent}^{tree}`])).stdout.trim();
    const replacementHead = (await git(repository, [
      "commit-tree",
      parentTree,
      "-p",
      parent,
      "-m",
      "replacement without gitlink",
    ])).stdout.trim();
    await git(repository, ["replace", rawHead, replacementHead]);
    await git(repository, ["read-tree", "--reset", "-u", replacementHead]);

    assert.match(
      (await rawGit(repository, ["ls-tree", "-r", "--format=%(objectmode)", rawHead])).stdout,
      /^160000$/m,
    );
    assert.equal(
      (await git(repository, ["status", "--porcelain=v2", "--untracked-files=all"])).stdout,
      "",
    );

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });
  });
});

test("rejects a gitlink without a .gitmodules file", async () => {
  await withGitlinkSource(async ({ repository, sourceHead }) => {
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sourceHead},linked-source`,
    ]);
    await git(repository, ["commit", "--quiet", "-m", "add gitlink"]);
    await assert.rejects(readFile(join(repository, ".gitmodules")), {
      code: "ENOENT",
    });

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });
  });
});

test("rejects an index-only gitlink", async () => {
  await withGitlinkSource(async ({ repository, sourceHead }) => {
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sourceHead},index-only`,
    ]);

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });
  });
});

test("rejects a HEAD gitlink before checking a divergent index", async () => {
  await withGitlinkSource(async ({ repository, sourceHead }) => {
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${sourceHead},head-only`,
    ]);
    await git(repository, ["commit", "--quiet", "-m", "add gitlink"]);
    await git(repository, ["update-index", "--force-remove", "head-only"]);

    await assert.rejects(requireGit().readGitSnapshot(repository), {
      code: "UNSUPPORTED_GIT_SUBMODULE",
    });
  });
});

test("accepts a nested directory and lone .gitmodules file without gitlinks", async () => {
  await withRepository(async (repository) => {
    await mkdir(join(repository, "nested"));
    await writeFile(join(repository, ".gitmodules"), "[submodule \"not-a-gitlink\"]\n");
    await git(repository, ["add", "nested", ".gitmodules"]);
    await git(repository, ["commit", "--quiet", "-m", "ordinary files"]);

    const snapshot = await requireGit().readGitSnapshot(repository);
    assert.equal(snapshot.clean, true);
  });
});

test("rejects a non-worktree and accepts a later clean changed HEAD", async () => {
  const outside = await mkdtemp(join(tmpdir(), "andrew-agent-not-git-"));
  try {
    await assert.rejects(requireGit().resolveRepositoryRoot(outside), {
      code: "NOT_GIT_REPOSITORY",
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }

  await withRepository(async (repository) => {
    const first = await requireGit().readGitSnapshot(repository);
    await writeFile(join(repository, "second.txt"), "second\n");
    await git(repository, ["add", "second.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "second"]);
    const second = await requireGit().readGitSnapshot(repository);
    assert.notEqual(second.head, first.head);
    assert.equal(second.clean, true);
  });
});

test("ignores inherited Git repository redirection without mutating either repository", async () => {
  await withRepository(async (repositoryA) => {
    await withRepository(async (repositoryB) => {
      await writeFile(join(repositoryA, "tracked.txt"), "repository A dirty\n");
      const beforeA = (
        await git(repositoryA, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ])
      ).stdout;
      const beforeB = (
        await git(repositoryB, [
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
        ])
      ).stdout;
      const overrides = {
        GIT_DIR: join(repositoryB, ".git"),
        GIT_WORK_TREE: repositoryB,
        GIT_INDEX_FILE: join(repositoryB, ".git", "index"),
        GIT_OBJECT_DIRECTORY: join(repositoryB, ".git", "objects"),
        GIT_COMMON_DIR: join(repositoryB, ".git"),
      };
      const original = Object.fromEntries(
        gitOverrideNames.map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, overrides);
      let snapshot;
      try {
        snapshot = await requireGit().readGitSnapshot(repositoryA);
      } finally {
        for (const name of gitOverrideNames) {
          if (original[name] === undefined) delete process.env[name];
          else process.env[name] = original[name];
        }
      }

      assert.equal(snapshot.repositoryRoot, repositoryA);
      assert.equal(snapshot.porcelainV2, beforeA);
      assert.equal(snapshot.clean, false);
      assert.equal(
        (
          await git(repositoryA, [
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
          ])
        ).stdout,
        beforeA,
      );
      assert.equal(
        (
          await git(repositoryB, [
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
          ])
        ).stdout,
        beforeB,
      );
    });
  });
});
