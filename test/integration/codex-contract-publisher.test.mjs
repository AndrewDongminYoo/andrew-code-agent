import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function fixture(run) {
  const scratch = await mkdtemp(join(tmpdir(), "codex-publisher-test-"));
  const repo = join(scratch, "repo");
  const artifacts = join(scratch, "artifacts");
  const tools = join(scratch, "tools");
  const remote = join(scratch, "remote.git");
  const log = join(scratch, "gh.jsonl");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (const directory of [join(repo, ".github/scripts"), join(repo, "src"), artifacts, tools]) await mkdir(directory, { recursive: true });
    for (const file of ["codex-contract-update.mjs", "publish-codex-contract.mjs"])
      await cp(resolve(".github/scripts", file), join(repo, ".github/scripts", file));
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "src/constants.ts"), "old contract\n");
    git("add", ".github/scripts", "src/constants.ts");
    git("commit", "-m", "fixture");
    const base = git("rev-parse", "HEAD").trim();
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git("remote", "add", "origin", remote);
    await writeFile(join(repo, "src/constants.ts"), "new contract\n");
    await writeFile(join(artifacts, "contract.patch"), git("diff", "--binary"));
    git("restore", "--", "src/constants.ts");
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ changed: true, version: "0.167.0", adopted: "0.166.0", base, digest: "b".repeat(64), changes: [{ path: "example", kind: "modified" }] }));
    const gh = join(tools, "gh");
    await writeFile(gh, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');\nif (args[0] === 'api') console.log(process.env.FIXTURE_PULLS || '[]');\nelse if (args[0] === 'pr') console.log('https://example.invalid/draft');\n`);
    await chmod(gh, 0o700);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitShim = join(tools, "git");
    await writeFile(gitShim, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\nconst args = process.argv.slice(2);\nif (['ls-remote', 'fetch', 'push'].includes(args[0]) && !fs.readFileSync(process.env.GH_LOG, 'utf8').includes('setup-git')) { console.error('private remote requires git authentication first'); process.exit(128); }\nconst result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`);
    await chmod(gitShim, 0o700);
    const publish = (pulls = []) => execFileSync(process.execPath, [join(repo, ".github/scripts/publish-codex-contract.mjs")], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, GH_LOG: log, FIXTURE_PULLS: JSON.stringify(pulls), CODEX_MONITOR_OUTPUT: artifacts, GITHUB_REPOSITORY: "AndrewDongminYoo/andrew-code-agent" },
    });
    await run({ repo, remote, artifacts, log, git, publish, base });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
test("publisher pushes a candidate and requests a draft PR with review limits", () => fixture(async ({ artifacts, log, git, publish }) => {
  assert.match(publish(), /example.invalid\/draft/);
  const remote = git("ls-remote", "--heads", "origin", "automation/codex-contract-0.167.0");
  assert.match(remote, /refs\/heads\/automation\/codex-contract-0.167.0/);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const create = calls.find((args) => args[0] === "pr");
  assert.ok(create.includes("--draft"));
  assert.ok(create.includes("--body-file"));
  const body = await readFile(join(artifacts, "pr-body.md"), "utf8");
  assert.match(body, /@AndrewDongminYoo/);
  assert.match(body, /real authenticated smoke/);
  assert.match(body, /No automatic merge/);
}));
for (const state of ["open", "closed"]) test(`publisher leaves an existing ${state} PR untouched`, () => fixture(async ({ log, git, publish, base }) => {
  assert.match(publish([{ state }]), /already has a PR/);
  assert.equal(git("rev-parse", "HEAD").trim(), base);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
}));
test("publisher refuses an unrelated patch before pushing", () => fixture(async ({ repo, artifacts, git, publish }) => {
  await writeFile(join(repo, "README.md"), "allowed baseline\n");
  git("add", "README.md");
  git("commit", "-m", "baseline");
  const result = JSON.parse(await readFile(join(artifacts, "result.json"), "utf8"));
  result.base = git("rev-parse", "HEAD").trim();
  await writeFile(join(artifacts, "result.json"), JSON.stringify(result));
  await writeFile(join(repo, ".github/scripts/unrelated.mjs"), "unrelated\n");
  git("add", ".github/scripts/unrelated.mjs");
  await writeFile(join(artifacts, "contract.patch"), git("diff", "--cached", "--binary"));
  git("restore", "--staged", "--", ".github/scripts/unrelated.mjs");
  await rm(join(repo, ".github/scripts/unrelated.mjs"));
  assert.throws(publish, (error) => /outside the contract update scope/.test(error.stderr));
  assert.equal(git("ls-remote", "--heads", "origin"), "");
}));
test("publisher never overwrites a different pre-existing branch", () => fixture(async ({ git, publish }) => {
  git("push", "origin", "HEAD:refs/heads/automation/codex-contract-0.167.0");
  const before = git("ls-remote", "--heads", "origin");
  assert.throws(publish, (error) => /refusing to overwrite/.test(error.stderr));
  assert.equal(git("ls-remote", "--heads", "origin"), before);
}));
