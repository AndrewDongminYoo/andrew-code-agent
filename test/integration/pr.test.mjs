import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const prModule = await import("../../dist/commands/pr.js").catch(() => null);
const pathsModule = await import("../../dist/runtime/paths.js").catch(() => null);

const validBody = [
  "## Summary",
  "",
  "- Change the fixture.",
  "",
  "## Verification",
  "",
  "- `git diff --check`: passed.",
  "- Project-specific tests and quality gates were not run by `andrew-agent pr`.",
].join("\n");

function output() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: process.stdin,
      stdout: {
        write(value) {
          stdout += String(value);
          return true;
        },
      },
      stderr: {
        write(value) {
          stderr += String(value);
          return true;
        },
      },
    },
    read() {
      return { stdout, stderr };
    },
  };
}

async function withRepository(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-pr-test-")),
  );
  try {
    await execFile("git", ["init", "--quiet", "--initial-branch=main", root]);
    await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await execFile("git", ["-C", root, "config", "user.name", "Test User"]);
    await writeFile(join(root, "fixture.txt"), "before\n");
    await execFile("git", ["-C", root, "add", "fixture.txt"]);
    await execFile("git", ["-C", root, "commit", "--quiet", "-m", "initial"]);
    const base = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await execFile("git", ["-C", root, "update-ref", "refs/remotes/origin/main", base]);
    await execFile("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await execFile("git", ["-C", root, "switch", "--quiet", "-c", "feature/pr-body"]);
    await writeFile(join(root, "fixture.txt"), "after\n");
    await execFile("git", ["-C", root, "add", "fixture.txt"]);
    await execFile("git", ["-C", root, "commit", "--quiet", "-m", "feat: change fixture"]);
    const head = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await run({ root, base, head });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("pr drafts a body from the exact committed comparison and passed diff check", async () => {
  assert.notEqual(prModule, null, "dist/commands/pr.js must exist");
  await withRepository(async ({ root, base, head }) => {
    const capture = output();
    let received;
    const exitCode = await prModule.prCommand(root, undefined, capture.io, {
      async draft(input) {
        received = input;
        return validBody;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(received.baseRef, "refs/remotes/origin/main");
    assert.equal(received.base, base);
    assert.equal(received.mergeBase, base);
    assert.equal(received.headRef, "refs/heads/feature/pr-body");
    assert.equal(received.head, head);
    assert.deepEqual(received.paths, ["fixture.txt"]);
    assert.match(received.prompt, /git diff --check.*passed/s);
    assert.match(received.prompt, /project-specific tests and quality gates.*not run/is);
    assert.deepEqual(capture.read(), { stdout: `${validBody}\n`, stderr: "" });
  });
});

test("pr bounds changed paths in the model prompt", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const generatedPaths = Array.from(
      { length: 513 },
      (_, index) => `generated-${String(index).padStart(4, "0")}.txt`,
    );
    await Promise.all(
      generatedPaths.map((path) => writeFile(join(root, path), "generated\n")),
    );
    await execFile("git", ["-C", root, "add", "--", ...generatedPaths]);
    await execFile("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "test: add generated fixtures",
    ]);

    let received;
    assert.equal(
      await prModule.prCommand(root, undefined, output().io, {
        async draft(input) {
          received = input;
          return validBody;
        },
      }),
      0,
    );

    const metadata = JSON.parse(received.prompt.split("\n\n").at(-1));
    assert.equal(received.paths.length, 514);
    assert.equal(metadata.changedFileCount, 514);
    assert.equal(metadata.paths.length, 512);
    assert.equal(metadata.omittedPathCount, 2);
    assert.equal(metadata.paths.includes("generated-0511.txt"), false);
    assert.equal(metadata.paths.includes("generated-0512.txt"), false);
  });
});

test("pr bounds commit metadata in the model prompt", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const longSubject = `oversized-${"x".repeat(70 * 1024)}`;
    const messagePath = join(root, ".git", "long-commit-message.txt");
    await writeFile(messagePath, longSubject);
    await execFile("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "--amend",
      `--file=${messagePath}`,
    ]);

    let received;
    assert.equal(
      await prModule.prCommand(root, undefined, output().io, {
        async draft(input) {
          received = input;
          return validBody;
        },
      }),
      0,
    );

    const metadata = JSON.parse(received.prompt.split("\n\n").at(-1));
    assert.equal(received.commits.length, 1);
    assert.match(received.commits[0], new RegExp(longSubject.slice(0, 128)));
    assert.deepEqual(metadata.commits, []);
    assert.equal(metadata.omittedCommitCount, 1);
    assert.doesNotMatch(received.prompt, new RegExp(longSubject.slice(0, 128)));
  });
});

test("pr accepts one explicit base and skips an empty comparison", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root, base }) => {
    let received;
    assert.equal(
      await prModule.prCommand(root, "main", output().io, {
        async draft(input) {
          received = input;
          return validBody;
        },
      }),
      0,
    );
    assert.equal(received.baseRef, "main");
    assert.equal(received.base, base);

    await execFile("git", ["-C", root, "switch", "--quiet", "main"]);
    const capture = output();
    let invoked = false;
    assert.equal(
      await prModule.prCommand(root, undefined, capture.io, {
        async draft() {
          invoked = true;
          return validBody;
        },
      }),
      0,
    );
    assert.equal(invoked, false);
    assert.match(
      capture.read().stdout,
      /No changes to describe against refs\/remotes\/origin\/main\./,
    );
  });
});

test("pr rejects dirty and detached worktrees before drafting", async () => {
  assert.notEqual(prModule, null);
  for (const state of ["dirty", "detached"]) {
    await withRepository(async ({ root }) => {
      if (state === "dirty") {
        await writeFile(join(root, "untracked.txt"), "dirty\n");
      } else {
        await execFile("git", ["-C", root, "switch", "--quiet", "--detach"]);
      }
      const capture = output();
      let invoked = false;
      const code = await prModule.prCommand(root, undefined, capture.io, {
        async draft() {
          invoked = true;
          return validBody;
        },
      });
      assert.equal(code, 3, state);
      assert.equal(invoked, false, state);
      assert.notEqual(capture.read().stderr, "", state);
    });
  }
});

test("pr refuses a committed comparison that fails git diff --check", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    await writeFile(join(root, "fixture.txt"), "after  \n");
    await execFile("git", ["-C", root, "add", "fixture.txt"]);
    await execFile("git", ["-C", root, "commit", "--quiet", "--amend", "--no-edit"]);
    const capture = output();
    let invoked = false;
    const code = await prModule.prCommand(root, undefined, capture.io, {
      async draft() {
        invoked = true;
        return validBody;
      },
    });
    assert.equal(code, 3);
    assert.equal(invoked, false);
    assert.equal(capture.read().stderr, "Committed changes fail git diff --check.\n");
  });
});

test("pr classifies runtime preparation failures without leaking details", async () => {
  assert.notEqual(prModule, null);
  assert.notEqual(pathsModule, null);
  await withRepository(async ({ root }) => {
    const capture = output();
    const error = new pathsModule.RuntimePathError(
      "CODEX_BINARY_NOT_FOUND",
      "fixture secret path",
    );
    const code = await prModule.prCommand(root, undefined, capture.io, {
      async draft() {
        throw error;
      },
    });
    assert.equal(code, 3);
    assert.equal(
      capture.read().stderr,
      "PR runtime preparation failed: CODEX_BINARY_NOT_FOUND.\n",
    );
    assert.doesNotMatch(capture.read().stderr, /fixture secret path/);
  });
});

test("pr rejects malformed, unsupported verification, controlled, and oversized bodies", async () => {
  assert.notEqual(prModule, null);
  const cases = [
    ["empty", ""],
    ["outer fence", `\`\`\`markdown\n${validBody}\n\`\`\``],
    ["duplicate heading", `${validBody}\n\n## Summary\n\nDuplicate.`],
    [
      "indented level-two heading",
      validBody.replace(
        "- Change the fixture.",
        "  ## Details\n\n- Change the fixture.",
      ),
    ],
    [
      "unordered-list level-two heading",
      validBody.replace("- Change the fixture.", "- ## Details"),
    ],
    [
      "ordered-list level-two heading",
      validBody.replace("- Change the fixture.", "1. ## Details"),
    ],
    [
      "blockquote level-two heading",
      validBody.replace("- Change the fixture.", "> ## Details"),
    ],
    [
      "setext level-two heading",
      validBody.replace(
        "- Change the fixture.",
        "Details\n-------\n\n- Change the fixture.",
      ),
    ],
    ["unsupported validation", `${validBody}\n- pnpm check: passed.`],
    [
      "unclosed HTML comment",
      validBody.replace("- Change the fixture.", "- Change the fixture. <!--"),
    ],
    [
      "unclosed fenced code",
      validBody.replace("- Change the fixture.", "- Change the fixture.\n\n```text"),
    ],
    ["terminal control", validBody.replace("Change", "Change\u001b[31m")],
    ["oversized", `${validBody}\n${"x".repeat(64 * 1024)}`],
  ];
  await withRepository(async ({ root }) => {
    for (const [name, body] of cases) {
      const capture = output();
      const code = await prModule.prCommand(root, undefined, capture.io, {
        async draft() {
          return body;
        },
      });
      assert.equal(code, 1, name);
      assert.equal(capture.read().stdout, "", name);
      assert.equal(
        capture.read().stderr,
        "Unable to draft PR body. Check the managed Codex login and runtime paths.\n",
        name,
      );
    }
  });
});

test("pr accepts implementation prose without inferring validation semantics", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const capture = output();
    const body = validBody.replace(
      "- Change the fixture.",
      "- Add regression tests that reject unsupported success claims.",
    );
    assert.equal(
      await prModule.prCommand(root, undefined, capture.io, {
        async draft() {
          return body;
        },
      }),
      0,
    );
    assert.equal(capture.read().stdout, `${body}\n`);
    assert.equal(capture.read().stderr, "");
  });
});

test("pr discards stale output when HEAD, branch, base, or worktree moves", async () => {
  assert.notEqual(prModule, null);
  for (const race of ["head", "branch", "base", "worktree"]) {
    await withRepository(async ({ root }) => {
      const capture = output();
      const code = await prModule.prCommand(root, "main", capture.io, {
        async draft() {
          if (race === "head") {
            await writeFile(join(root, "later.txt"), "later\n");
            await execFile("git", ["-C", root, "add", "later.txt"]);
            await execFile("git", ["-C", root, "commit", "--quiet", "-m", "fix: move head"]);
          } else if (race === "branch") {
            await execFile("git", ["-C", root, "switch", "--quiet", "-c", "other-feature"]);
          } else if (race === "worktree") {
            await writeFile(join(root, "later.txt"), "later\n");
          } else {
            await execFile("git", ["-C", root, "branch", "-f", "main", "HEAD"]);
          }
          return validBody;
        },
      });
      assert.equal(code, 3, race);
      assert.equal(capture.read().stdout, "", race);
      assert.equal(capture.read().stderr, "PR inputs changed; run pr again.\n", race);
    });
  }
});

test("pr preserves a valid body when temporary checkout cleanup warns", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const capture = output();
    const code = await prModule.prCommand(root, undefined, capture.io, {
      async draft() {
        return {
          response: validBody,
          cleanupWarning: "sensitive cleanup detail",
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(capture.read().stdout, `${validBody}\n`);
    assert.equal(capture.read().stderr, "Temporary PR checkout cleanup failed.\n");
  });
});

test("pr preserves a cleanup warning when returned body validation fails", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const capture = output();
    const code = await prModule.prCommand(root, undefined, capture.io, {
      async draft() {
        return {
          response: "invalid body",
          cleanupWarning: "sensitive cleanup detail",
        };
      },
    });
    assert.equal(code, 1);
    assert.equal(capture.read().stdout, "");
    assert.equal(
      capture.read().stderr,
      "Temporary PR checkout cleanup failed.\nUnable to draft PR body. Check the managed Codex login and runtime paths.\n",
    );
    assert.doesNotMatch(capture.read().stderr, /sensitive cleanup detail/);
  });
});

test("the default pr path excludes ignored source content and removes its checkout", async () => {
  assert.notEqual(prModule, null);
  await withRepository(async ({ root }) => {
    const runtime = await realpath(
      await mkdtemp(join(tmpdir(), "andrew-agent-pr-runtime-")),
    );
    const stateRoot = join(runtime, "state");
    const record = join(runtime, "record.json");
    const binary = join(runtime, "codex");
    const script = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), secretVisible: existsSync("ignored-secret.txt"), input }));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(validBody)} } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`;
    await writeFile(binary, script);
    await chmod(binary, 0o755);
    await writeFile(join(root, ".git", "info", "exclude"), "ignored-secret.txt\n", { flag: "a" });
    await writeFile(join(root, "ignored-secret.txt"), "source-only\n");
    const environment = {
      ANDREW_AGENT_CODEX_SOURCE: process.env.ANDREW_AGENT_CODEX_SOURCE,
      ANDREW_AGENT_STATE_ROOT: process.env.ANDREW_AGENT_STATE_ROOT,
      ANDREW_AGENT_CODEX_BIN: process.env.ANDREW_AGENT_CODEX_BIN,
    };
    process.env.ANDREW_AGENT_CODEX_SOURCE = root;
    process.env.ANDREW_AGENT_STATE_ROOT = stateRoot;
    process.env.ANDREW_AGENT_CODEX_BIN = binary;
    try {
      const capture = output();
      assert.equal(await prModule.prCommand(root, "main", capture.io), 0);
      const invocation = JSON.parse(await readFile(record, "utf8"));
      assert.notEqual(invocation.cwd, root);
      assert.equal(invocation.secretVisible, false);
      assert.deepEqual(invocation.argv, [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "-C",
        invocation.cwd,
        "-",
      ]);
      assert.match(invocation.input, /git diff --check.*passed/s);
      assert.equal(capture.read().stdout, `${validBody}\n`);
      assert.equal(
        (await readdir(stateRoot)).some((entry) => entry.startsWith("review-")),
        false,
      );
    } finally {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
