import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, metadataPaths } from "./codex-contract-update.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function validatePublication(result, paths, modes) {
  if (
    result.changed !== true ||
    !/^\d+\.\d+\.\d+$/.test(result.version) ||
    !/^\d+\.\d+\.\d+$/.test(result.adopted) ||
    !Array.isArray(result.changes) ||
    result.changes.length === 0 ||
    !/^[a-f0-9]{40}$/.test(result.base) ||
    !/^[a-f0-9]{64}$/.test(result.digest)
  )
    throw new Error("Invalid monitor result");
  if (
    !paths.length ||
    paths.some(
      (file) =>
        file.split("/").some((part) => part === ".." || part === ".") ||
        (!metadataPaths.includes(file) &&
          !file.startsWith("src/generated/codex-app-server/") &&
          !file.startsWith("schemas/codex-app-server/")),
    )
  )
    throw new Error("Patch changes a path outside the contract update scope");
  if (modes.some((mode) => mode !== "100644"))
    throw new Error("Patch contains an unexpected file mode");
}
export function alreadyReported(pulls) {
  return pulls.some((pull) => pull.state === "open" || pull.state === "closed");
}
async function main() {
  const directory = process.env.CODEX_MONITOR_OUTPUT;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!directory || repository !== "AndrewDongminYoo/andrew-code-agent")
    throw new Error("Unexpected publication target");
  const result = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  );
  validatePublication(result, ["src/constants.ts"], []);
  if (
    command("git", ["rev-parse", "HEAD"]).trim() !== result.base ||
    command("git", ["status", "--porcelain"]).trim()
  )
    throw new Error("Publisher must start at the clean comparison base");
  const branch = `automation/codex-contract-${result.version}`;
  const pulls = JSON.parse(
    command("gh", [
      "api",
      `repos/${repository}/pulls?state=all&head=AndrewDongminYoo:${branch}&per_page=100`,
    ]),
  );
  if (alreadyReported(pulls)) {
    console.log("This candidate already has a PR; leaving it unchanged.");
    return;
  }
  command("git", ["apply", "--index", join(directory, "contract.patch")]);
  const paths = command("git", ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  const modes = command("git", ["ls-files", "--stage", "-z", "--", ...paths])
    .split("\0")
    .filter(Boolean)
    .map((line) => line.split(" ")[0]);
  validatePublication(result, paths, modes);
  command("git", [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    `chore(codex): update contract to ${result.version}`,
  ]);
  command("gh", ["auth", "setup-git"]);
  const existing = command("git", [
    "ls-remote",
    "--heads",
    "origin",
    branch,
  ]).trim();
  if (existing) {
    command("git", ["fetch", "origin", branch]);
    if (
      command("git", ["rev-parse", "FETCH_HEAD^{tree}"]).trim() !==
      command("git", ["rev-parse", "HEAD^{tree}"]).trim()
    )
      throw new Error(
        "Existing automation branch differs; refusing to overwrite it",
      );
  } else {
    command("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
  }
  const body = [
    `@AndrewDongminYoo: stable Codex ${result.version} changes the generated App Server contract.`,
    "",
    `Upstream: https://github.com/openai/codex/releases/tag/rust-v${result.version}`,
    `Comparison base: \`${result.base}\`; adopted version: \`${result.adopted}\`.`,
    `Contract digest: \`${result.digest}\`.`,
    "",
    "This draft replaces both generated trees and updates the runtime pin, explicit version fixtures, and README together.",
    "The official release asset SHA-256, binary version, fresh generators, and complete contract comparison ran in the read-only detection job.",
    "Required CI and a real authenticated smoke check remain necessary before adoption; schema generation does not establish runtime compatibility.",
    "GITHUB_TOKEN-created PR workflows may require operator approval in GitHub before CI starts.",
    "",
    `Changed contract files: ${result.changes.length}.`,
    "No automatic merge or approval is configured.",
    "",
  ].join("\n");
  const bodyFile = join(directory, "pr-body.md");
  await writeFile(bodyFile, body);
  console.log(
    command("gh", [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      "main",
      "--head",
      branch,
      "--draft",
      "--title",
      `chore(codex): update contract to ${result.version}`,
      "--body-file",
      bodyFile,
    ]),
  );
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
