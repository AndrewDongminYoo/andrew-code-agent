import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareContracts, generate, metadataPaths, newer, prepare, releaseVersion } from "../../.github/scripts/codex-contract-update.mjs";
import { alreadyReported, validatePublication } from "../../.github/scripts/publish-codex-contract.mjs";

const trees = ["src/generated/codex-app-server", "schemas/codex-app-server"];
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "codex-monitor-test-"));
  const repo = join(root, "repo");
  const fresh = join(root, "fresh");
  try {
    for (const base of [repo, fresh]) for (const tree of trees) {
      await mkdir(join(base, tree), { recursive: true });
      await writeFile(join(base, tree, "a.json"), "stable");
    }
    await run({ root, repo, fresh });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("monitor selects stable forward releases, not previews or downgrades", () => {
  assert.equal(releaseVersion({ tag_name: "rust-v0.167.0" }), "0.167.0");
  for (const release of [{ tag_name: "rust-v0.167.0", prerelease: true }, { tag_name: "rust-v0.167.0", draft: true }, { tag_name: "rust-v0.167.0-alpha.1" }, { tag_name: "../bad" }])
    assert.throws(() => releaseVersion(release), /stable/);
  assert.equal(newer("0.167.0", "0.166.0"), true);
  assert.equal(newer("0.166.1", "0.166.0"), true);
  assert.equal(newer("0.166.0", "0.166.0"), false);
  assert.equal(newer("0.165.9", "0.166.0"), false);
});
test("identical contracts do not notify even for a newer binary", () => fixture(async ({ repo, fresh }) => {
  assert.deepEqual(await compareContracts(repo, fresh), []);
}));
test("comparison catches additions, byte changes, and stale removed files", () => fixture(async ({ repo, fresh }) => {
  await writeFile(join(repo, trees[0], "obsolete.ts"), "obsolete");
  await writeFile(join(fresh, trees[0], "added.ts"), "new");
  await writeFile(join(fresh, trees[1], "a.json"), "changed");
  assert.deepEqual(await compareContracts(repo, fresh), [
    { path: `${trees[0]}/added.ts`, kind: "added" },
    { path: `${trees[0]}/obsolete.ts`, kind: "removed" },
    { path: `${trees[1]}/a.json`, kind: "modified" },
  ]);
}));
test("empty and symlink output fail instead of being classified as unchanged", () => fixture(async ({ repo, fresh }) => {
  await rm(join(fresh, trees[0], "a.json"));
  await assert.rejects(compareContracts(repo, fresh), /empty/);
  await symlink(join(repo, trees[0], "a.json"), join(fresh, trees[0], "a.json"));
  await assert.rejects(compareContracts(repo, fresh), /non-regular/);
}));
test("wrong binary version and failed generators propagate failures", () => fixture(async ({ fresh }) => {
  await assert.rejects(generate("fake", "0.167.0", fresh, () => "codex-cli 0.166.0"), /version/);
  await assert.rejects(generate("fake", "0.167.0", fresh, (_binary, args) => {
    if (args[0] === "--version") return "codex-cli 0.167.0";
    throw new Error("generator failed");
  }), /generator failed/);
}));
test("prepared draft replaces old trees and keeps pin, digest, fixtures, and docs together", () => fixture(async ({ repo, fresh }) => {
  for (const file of metadataPaths) {
    await mkdir(join(repo, file, ".."), { recursive: true });
    await writeFile(join(repo, file), file === "src/constants.ts"
      ? `export const REQUIRED_CODEX_VERSION = "0.166.0";\nexport const REQUIRED_CODEX_CONTRACT_DIGEST =\n  "${"a".repeat(64)}";\n`
      : "codex-cli 0.166.0\n");
  }
  await writeFile(join(repo, trees[0], "obsolete.ts"), "old");
  await prepare(repo, fresh, "0.167.0", "b".repeat(64));
  await assert.rejects(readFile(join(repo, trees[0], "obsolete.ts")), { code: "ENOENT" });
  for (const file of metadataPaths) assert.match(await readFile(join(repo, file), "utf8"), /0\.167\.0/);
  assert.match(await readFile(join(repo, "src/constants.ts"), "utf8"), new RegExp("b".repeat(64)));
}));
test("publication deduplicates open and closed candidates", () => {
  assert.equal(alreadyReported([]), false);
  assert.equal(alreadyReported([{ state: "open" }]), true);
  assert.equal(alreadyReported([{ state: "closed" }]), true);
});
test("publisher refuses unrelated paths, symlinks, and invalid result metadata", () => {
  const result = { changed: true, version: "0.167.0", adopted: "0.166.0", changes: [{}], base: "a".repeat(40), digest: "b".repeat(64) };
  validatePublication(result, ["src/constants.ts", `${trees[0]}/New.ts`], ["100644"]);
  for (const paths of [[], [".github/workflows/ci.yml"], ["src/commands/commit.ts"]])
    assert.throws(() => validatePublication(result, paths, ["100644"]), /scope/);
  assert.throws(() => validatePublication(result, ["src/constants.ts"], ["120000"]), /mode/);
  assert.throws(() => validatePublication({ ...result, changed: false }, ["src/constants.ts"], []), /result/);
});

test("successful generation writes both stable contract trees", () => fixture(async ({ root }) => {
  const fresh = join(root, "success");
  const calls = [];
  await generate("fake", "0.167.0", fresh, (binary, args) => {
    assert.equal(binary, "fake");
    calls.push(args);
    if (args[0] === "--version") return "codex-cli 0.167.0";
    writeFileSync(join(args[3], "generated.txt"), args[1]);
    return "";
  });
  assert.deepEqual(calls, [
    ["--version"],
    ["app-server", "generate-ts", "--out", join(fresh, trees[0])],
    ["app-server", "generate-json-schema", "--out", join(fresh, trees[1])],
  ]);
  assert.equal(await readFile(join(fresh, trees[0], "generated.txt"), "utf8"), "generate-ts");
  assert.equal(await readFile(join(fresh, trees[1], "generated.txt"), "utf8"), "generate-json-schema");
}));
