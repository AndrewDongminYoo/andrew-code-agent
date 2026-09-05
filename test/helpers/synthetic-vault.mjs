import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const page = (frontmatter, body) =>
  `---\n${frontmatter}\n---\n\n${body}`;

const publicPage = page(
  "title: Public Page\nscope: global\ntags: [canary]\ntype: concept\ncreated: 2026-09-03\nupdated: 2026-09-03\nrelated: []\nsources: []",
  "PUBLIC_ORACLE_CANARY_7A42\n",
);
const hiddenFrontmatter =
  "title: Hidden Page\nscope: global\ntags: [canary]\nsensitive: true\ntype: concept\ncreated: 2026-09-03\nupdated: 2026-09-03\nrelated: []\nsources: []";
const filterDisabledFrontmatter = hiddenFrontmatter.replace(
  "sensitive: true\n",
  "",
);
const falsePositivePage = page(
  "title: Words\nscope: global\ntags: [words]\ntype: concept\ncreated: 2026-09-03\nupdated: 2026-09-03\nrelated: []\nsources: []",
  "secret private employment\n",
);
const falseNegativePage = page(
  "title: Plain\nscope: global\ntags: [plain]\nsensitive: true\ntype: concept\ncreated: 2026-09-03\nupdated: 2026-09-03\nrelated: []\nsources: []",
  "Nothing to see.\n",
);
const malformedPage =
  "---\ntitle: Broken\nsensitive: [true\n---\n\nMALFORMED_ORACLE_CANARY\n";

async function run(command, args, options = {}) {
  return execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function commit(root, message) {
  await run("git", ["add", "--all"], { cwd: root });
  await run("git", ["commit", "--quiet", "-m", message], { cwd: root });
}

async function runWikiScript(root, script) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  if (process.env.HOME !== undefined) environment.HOME = process.env.HOME;
  await run(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env: environment,
  });
}

export async function listSyntheticVaultTools({
  wikiServerRoot,
  vaultRoot,
}) {
  const serverRoot = await realpath(wikiServerRoot);
  const requireFromServer = createRequire(join(serverRoot, "package.json"));
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(
      pathToFileURL(
        requireFromServer.resolve("@modelcontextprotocol/client"),
      ).href
    ),
    import(
      pathToFileURL(
        requireFromServer.resolve("@modelcontextprotocol/client/stdio"),
      ).href
    ),
  ]);
  const client = new Client({
    name: "oracle-boundary-launcher-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    args: [
      "-c",
      'cd "$LLM_WIKI_ROOT" && exec ./node_modules/.bin/tsx mcp-server/src/start-local.ts',
    ],
    command: "/bin/sh",
    env: {
      LLM_WIKI_MCP_MODE: "managed",
      LLM_WIKI_ROOT: vaultRoot,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name).sort();
  } catch (error) {
    throw new Error(
      `synthetic Oracle launcher failed: ${String(error)}${
        stderr.length === 0 ? "" : `\n${stderr}`
      }`,
    );
  } finally {
    try {
      await client.close();
    } catch {
      // The failed connection already closed the child transport.
    }
  }
}

export async function createSyntheticVault({
  wikiServerRoot,
  leakRestricted = false,
}) {
  const serverRoot = await realpath(wikiServerRoot);
  const providerSourcePaths = [
    "artifact-kernel",
    "mcp-server",
    "scripts/artifact-restricted-facets.ts",
  ];
  const { stdout: providerStatus } = await run(
    "git",
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...providerSourcePaths,
    ],
    { cwd: serverRoot },
  );
  if (providerStatus.trim().length > 0) {
    throw new Error(
      `wiki provider source paths do not match HEAD:\n${providerStatus.trim()}`,
    );
  }
  const { stdout: providerCommit } = await run(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: serverRoot },
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-agent-oracle-vault-")),
  );
  try {
    await run("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    await run("git", ["config", "user.name", "Synthetic Oracle Test"], {
      cwd: root,
    });
    await run(
      "git",
      ["config", "user.email", "synthetic-oracle@example.invalid"],
      { cwd: root },
    );
    await run("git", ["config", "core.autocrlf", "false"], { cwd: root });

    const linkedPaths = [
      "artifact-kernel",
      "mcp-server",
      "node_modules",
      "package.json",
      "pnpm-lock.yaml",
    ];
    for (const linkedPath of linkedPaths) {
      await symlink(join(serverRoot, linkedPath), join(root, linkedPath));
    }
    await writeFile(
      join(root, ".gitignore"),
      `${linkedPaths.join("\n")}\n.oracle-artifact/\n`,
    );

    const pages = {
      "wiki/concepts/public-page.md": publicPage,
      "wiki/concepts/hidden-page.md": page(
        leakRestricted ? filterDisabledFrontmatter : hiddenFrontmatter,
        "SENSITIVE_ORACLE_CANARY_9C31\n",
      ),
      "wiki/concepts/false-positive.md": falsePositivePage,
      "wiki/concepts/false-negative.md": falseNegativePage,
      "wiki/concepts/malformed.md": malformedPage,
    };
    for (const [relativePath, content] of Object.entries(pages)) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "artifact-exclusions.json"),
      `${JSON.stringify({ version: 1, excludedPaths: [] }, null, 2)}\n`,
    );
    await writeFile(
      join(root, "artifact-policy.json"),
      `${JSON.stringify({ version: 1, privateSourcePaths: [] }, null, 2)}\n`,
    );
    await commit(root, "synthetic vault inputs");

    await runWikiScript(
      root,
      join(serverRoot, "scripts", "artifact-restricted-facets.ts"),
    );
    await commit(root, "generate restricted facets");
    await runWikiScript(
      root,
      join(
        serverRoot,
        "mcp-server",
        "src",
        "pipeline",
        "generate-policy.ts",
      ),
    );
    await commit(root, "generate artifact policy");

    const facets = JSON.parse(
      await readFile(
        join(root, "config", "restricted-facets.json"),
        "utf8",
      ),
    );
    const restrictedIdHash = createHash("sha256")
      .update(`${facets.salt}:concepts/hidden-page`)
      .digest("hex");
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
    return {
      root,
      sourceCommit: stdout.trim(),
      providerSourceCommit: providerCommit.trim(),
      restrictedIdHash,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
