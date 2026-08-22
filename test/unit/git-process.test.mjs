import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gitProcessModule = await import("../../dist/git/process.js").catch(
  () => null,
);
const maxGitOutputBytes = 16 * 1024 * 1024;

function requireGitProcess() {
  assert.notEqual(
    gitProcessModule,
    null,
    "the built Git process module must be available",
  );
  return gitProcessModule;
}

async function withOutputGitShim(run) {
  const directory = await mkdtemp(join(tmpdir(), "andrew-agent-git-output-"));
  const shimPath = join(directory, "git");
  const originalPath = process.env.PATH;
  await writeFile(
    shimPath,
    `#!${process.execPath}
const args = process.argv.slice(2);
const stream = args[3] === "stderr" ? process.stderr : process.stdout;
const size = Number(args[4]);
const secret = args[5] ?? "x";
stream.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
if (args[2] === "multibyte") {
  stream.write("€".repeat(size));
} else {
  const prefix = Buffer.from(secret);
  stream.write(prefix);
  stream.write(Buffer.alloc(size - prefix.length, 0x78));
}
`,
  );
  await chmod(shimPath, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  try {
    await run(directory);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test("captures multibyte Git stdout above 1 MiB by byte count", async () => {
  await withOutputGitShim(async (repositoryRoot) => {
    const repetitions = 400_000;
    const stdout = await requireGitProcess().executeGit(repositoryRoot, [
      "multibyte",
      "stdout",
      String(repetitions),
    ]);

    assert.equal(stdout.length, repetitions);
    assert.equal(Buffer.byteLength(stdout, "utf8"), repetitions * 3);
    assert.ok(Buffer.byteLength(stdout, "utf8") > 1024 * 1024);
    assert.ok(Buffer.byteLength(stdout, "utf8") <= maxGitOutputBytes);
  });
});

test("captures stdout at the exact 16 MiB boundary", async () => {
  await withOutputGitShim(async (repositoryRoot) => {
    const stdout = await requireGitProcess().executeGit(repositoryRoot, [
      "bytes",
      "stdout",
      String(maxGitOutputBytes),
      "boundary-canary",
    ]);

    assert.equal(Buffer.byteLength(stdout, "utf8"), maxGitOutputBytes);
    assert.match(stdout, /^boundary-canary/);
  });
});

for (const stream of ["stdout", "stderr"]) {
  test(`normalizes ${stream} above 16 MiB without raw output leakage`, async () => {
    await withOutputGitShim(async (repositoryRoot) => {
      const secret = `${stream}-overflow-secret`;
      await assert.rejects(
        requireGitProcess().executeGit(repositoryRoot, [
          "bytes",
          stream,
          String(maxGitOutputBytes + 1),
          secret,
        ]),
        (error) => {
          assert.ok(error instanceof requireGitProcess().GitProcessError);
          assert.equal(error.code, "GIT_OUTPUT_TOO_LARGE");
          assert.equal(
            error.message,
            "Git command output exceeds the v0.1 limit.",
          );
          assert.equal(error.message.includes(secret), false);
          assert.equal("stdout" in error, false);
          assert.equal("stderr" in error, false);
          return true;
        },
      );
    });
  });
}
