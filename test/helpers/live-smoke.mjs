import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(productRoot, "dist", "cli.js");
const fixtureCodex = join(
  productRoot,
  "test",
  "fixtures",
  "fake-app-server.mjs",
);
const sourceFixture = join(
  productRoot,
  "test",
  "fixtures",
  "source-codex",
  "clean",
);
const acceptanceManifest = join(
  productRoot,
  "test",
  "fixtures",
  "manifests",
  "acceptance.toml",
);
const scopedKeys = [
  "HOME",
  "ANDREW_AGENT_CODEX_SOURCE",
  "ANDREW_AGENT_STATE_ROOT",
];

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && !path.startsWith(`..${sep}`) && path !== "..";
}

export function acceptanceEnvironment(fixtureRoot, values) {
  for (const key of scopedKeys) {
    const value = values[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} must be set explicitly for the acceptance child`);
    }
    if (!isInside(fixtureRoot, value)) {
      throw new Error(
        `${key} resolves outside the acceptance fixture: ${value}`,
      );
    }
  }
  return values;
}

async function initializeRepository(root) {
  await execFile("git", ["init", "--quiet", root]);
  await execFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFile("git", ["-C", root, "config", "user.name", "Test User"]);
  await execFile("git", ["-C", root, "add", "--all"]);
  await execFile("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
}

export async function writeCodexWrapper(fixture, settings = {}) {
  const assignments = Object.entries({
    ANDREW_AGENT_FAKE_SCRIPT: join(
      productRoot,
      "test",
      "fixtures",
      "protocol",
      "turn-success.jsonl",
    ),
    ...settings,
  })
    .map(([key, value]) => `${key}=${JSON.stringify(value)}\nexport ${key}`)
    .join("\n");
  await writeFile(
    fixture.codexBin,
    `#!/bin/sh\n${assignments}\nexec ${JSON.stringify(fixtureCodex)} "$@"\n`,
    { mode: 0o755 },
  );
}

export async function createSmokeFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-acceptance-")),
  );
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const stateRoot = join(root, "state");
  const target = join(root, "repository");

  await mkdir(home, { mode: 0o700 });
  await cp(sourceFixture, sourceRoot, { recursive: true });
  await mkdir(join(sourceRoot, "agents"), { recursive: true });
  await writeFile(
    join(sourceRoot, "AGENTS.md"),
    "# Fixture Instructions\n\n## Core Rules\n\nKeep the base profile portable.\n\n## Consult the Oracle\n\nUse ${LLM_WIKI_ROOT} only for read-only precedent retrieval.\n\n## Closing Rules\n\nKeep working without the optional adapter.\n",
  );
  await writeFile(
    join(sourceRoot, "agents", "oracle.toml"),
    'name = "oracle"\nwiki_root = "${LLM_WIKI_ROOT}"\n',
  );
  await writeFile(
    join(sourceRoot, "hooks", "safety.sh"),
    '#!/bin/sh\nprintf "%s\\n" "${HOME}/.codex"\n',
  );
  await chmod(join(sourceRoot, "hooks", "safety.sh"), 0o755);
  await copyFile(acceptanceManifest, join(sourceRoot, "agent-bundle.toml"));
  await initializeRepository(sourceRoot);

  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(join(stateRoot, "codex-home"), { mode: 0o700 });
  await writeFile(
    join(stateRoot, "codex-home", ["auth", ".json"].join("")),
    `${JSON.stringify({ OPENAI_API_KEY: "fixture-only-not-a-credential" })}\n`,
    { mode: 0o600 },
  );

  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "tracked.txt"), "before\n");
  await initializeRepository(target);

  const binRoot = join(root, "bin");
  await mkdir(binRoot, { mode: 0o700 });
  const fixture = {
    root,
    home,
    sourceRoot,
    stateRoot,
    target,
    codexBin: join(binRoot, "codex"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  await writeCodexWrapper(fixture);
  return fixture;
}

export function environmentFor(fixture, overrides = {}) {
  return acceptanceEnvironment(fixture.root, {
    HOME: fixture.home,
    ANDREW_AGENT_CODEX_SOURCE: fixture.sourceRoot,
    ANDREW_AGENT_STATE_ROOT: fixture.stateRoot,
    ANDREW_AGENT_CODEX_BIN: fixture.codexBin,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...overrides,
  });
}

export async function runCli(environment, argv, options = {}) {
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      [cliPath, ...argv],
      {
        env: environment,
        cwd: options.cwd ?? productRoot,
        timeout: options.timeoutMs ?? 30_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}
