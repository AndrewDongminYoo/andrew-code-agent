import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const metadataPaths = [
  "README.md",
  "src/constants.ts",
  "test/unit/constants.test.mjs",
  "test/integration/doctor.test.mjs",
  "test/integration/cli.test.mjs",
  "test/integration/transport.test.mjs",
  "test/contract/client.test.mjs",
];
const trees = ["src/generated/codex-app-server", "schemas/codex-app-server"];
const versionPattern = /^\d+\.\d+\.\d+$/;
export function releaseVersion(release) {
  const version = release.tag_name?.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1];
  if (
    release.draft ||
    release.prerelease ||
    !versionPattern.test(version ?? "")
  )
    throw new Error("Expected a stable Codex release");
  return version;
}
export function newer(candidate, adopted) {
  const left = candidate.split(".").map(Number);
  const right = adopted.split(".").map(Number);
  return left.some(
    (value, i) =>
      value > right[i] && left.slice(0, i).every((v, j) => v === right[j]),
  );
}
export function command(binary, args, cwd = root, env = process.env) {
  return execFileSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}
export async function inventory(directory, prefix = "") {
  const result = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const entry = await lstat(join(directory, relative));
    if (entry.isDirectory())
      result.push(...(await inventory(directory, relative)));
    else if (entry.isFile()) result.push(relative);
    else throw new Error("Contract output contains a non-regular entry");
  }
  return result;
}
export async function compareContracts(repo, fresh) {
  const changes = [];
  for (const tree of trees) {
    const before = join(repo, tree);
    const after = join(fresh, tree);
    const oldFiles = await inventory(before);
    const newFiles = await inventory(after);
    if (newFiles.length === 0)
      throw new Error("Generator produced an empty contract tree");
    for (const name of [...new Set([...oldFiles, ...newFiles])].sort()) {
      const existed = oldFiles.includes(name);
      const exists = newFiles.includes(name);
      if (
        !existed ||
        !exists ||
        !(await readFile(join(before, name))).equals(
          await readFile(join(after, name)),
        )
      )
        changes.push({
          path: `${tree}/${name}`,
          kind: !existed ? "added" : !exists ? "removed" : "modified",
        });
    }
  }
  return changes;
}
export async function generate(binary, version, fresh, run = command) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (run(binary, ["--version"], root, env).trim() !== `codex-cli ${version}`)
    throw new Error("Candidate binary version does not match the release");
  for (const [i, tree] of trees.entries()) {
    const destination = join(fresh, tree);
    await mkdir(destination, { recursive: true });
    run(
      binary,
      [
        "app-server",
        i === 0 ? "generate-ts" : "generate-json-schema",
        "--out",
        destination,
      ],
      root,
      env,
    );
  }
}
export async function prepare(repo, fresh, version, digest) {
  const constants = await readFile(join(repo, "src/constants.ts"), "utf8");
  const previous = constants.match(/REQUIRED_CODEX_VERSION = "([^"]+)"/)?.[1];
  if (
    !versionPattern.test(version) ||
    !versionPattern.test(previous ?? "") ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error("Invalid contract metadata");
  for (const file of metadataPaths) {
    const filename = join(repo, file);
    const source = await readFile(filename, "utf8");
    if (!source.includes(previous))
      throw new Error(`Missing version fixture in ${file}`);
  }
  for (const tree of trees) {
    await rm(join(repo, tree), { recursive: true });
    await cp(join(fresh, tree), join(repo, tree), { recursive: true });
  }
  for (const file of metadataPaths) {
    const filename = join(repo, file);
    let source = (await readFile(filename, "utf8")).replaceAll(
      previous,
      version,
    );
    if (file === "src/constants.ts") {
      if (!/REQUIRED_CODEX_CONTRACT_DIGEST =\s*"[a-f0-9]{64}"/.test(source))
        throw new Error("Missing contract digest");
      source = source.replace(
        /(REQUIRED_CODEX_CONTRACT_DIGEST =\s*)"[a-f0-9]{64}"/,
        `$1"${digest}"`,
      );
    }
    await writeFile(filename, source);
  }
}
export async function downloadBinary(release, scratch) {
  const assetName = `codex-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`;
  const asset = release.assets.find((entry) => entry.name === assetName);
  const expectedUrl = `https://github.com/openai/codex/releases/download/${release.tag_name}/${assetName}`;
  if (
    !asset ||
    asset.browser_download_url !== expectedUrl ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
  )
    throw new Error("Missing official binary asset or SHA-256 digest");
  const response = await fetch(expectedUrl, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok)
    throw new Error(`Binary download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
    asset.digest
  )
    throw new Error("Binary asset SHA-256 mismatch");
  const archive = join(scratch, "codex.tar.gz");
  await writeFile(archive, bytes);
  const entries = command("tar", ["-tzf", archive]).trim().split("\n");
  const executable = assetName.replace(/\.tar\.gz$/, "");
  if (entries.length !== 1 || entries[0] !== executable)
    throw new Error("Unexpected binary archive layout");
  command("tar", ["-xzf", archive, "-C", scratch, executable]);
  const binary = join(scratch, executable);
  if (!(await lstat(binary)).isFile())
    throw new Error("Binary asset is not a regular file");
  return binary;
}
async function main() {
  const prepareChanges = process.argv.includes("--prepare");
  if (prepareChanges && command("git", ["status", "--porcelain"]).trim())
    throw new Error("Preparing a candidate requires a clean checkout");
  const output = process.env.CODEX_MONITOR_OUTPUT;
  if (!output) throw new Error("CODEX_MONITOR_OUTPUT is required");
  await mkdir(output, { recursive: true });
  const { REQUIRED_CODEX_VERSION: adopted } = await import(
    pathToFileURL(join(root, "dist/constants.js"))
  );
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(
    "https://api.github.com/repos/openai/codex/releases/latest",
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok)
    throw new Error(`Release lookup failed: ${response.status}`);
  const release = await response.json();
  const version = releaseVersion(release);
  const result = {
    version,
    adopted,
    changed: false,
    base: command("git", ["rev-parse", "HEAD"]).trim(),
  };
  if (newer(version, adopted)) {
    const scratch = await mkdtemp(join(tmpdir(), "codex-contract-monitor-"));
    try {
      const binary = await downloadBinary(release, scratch);
      const fresh = join(scratch, "fresh");
      await generate(binary, version, fresh);
      const { codexContractDigest } = await import(
        pathToFileURL(join(root, "dist/app-server/contract-digest.js"))
      );
      result.digest = await codexContractDigest({
        generated: join(fresh, trees[0]),
        schemas: join(fresh, trees[1]),
      });
      result.changes = await compareContracts(root, fresh);
      result.changed = result.changes.length > 0;
      if (result.changed && prepareChanges) {
        await prepare(root, fresh, version, result.digest);
        command("git", ["add", "--", ...trees, ...metadataPaths]);
        await writeFile(
          join(output, "contract.patch"),
          command("git", ["diff", "--cached", "--binary"]),
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`, {
      flag: "a",
    });
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
