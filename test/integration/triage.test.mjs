import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const triageModule = await import("../../dist/commands/triage.js").catch(() => null);

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
}

async function withRepository(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-triage-")));
  try {
    await git(root, "init", "--quiet", "--initial-branch=main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.invalid");
    await writeFile(join(root, "tracked.txt"), "before\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "chore: initial fixture");
    await git(root, "switch", "--quiet", "-c", "feature");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "fix: change fixture");
    await run(root, await git(root, "rev-parse", "HEAD"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
    read() { return { stdout, stderr }; },
  };
}

function thread({ typename = "Bot", login = "review-bot", resolved = false, body = "finding", path = "tracked.txt", line = 1, author } = {}) {
  return {
    id: `T_${Math.random().toString(16).slice(2)}`,
    isResolved: resolved,
    path,
    line,
    comments: { nodes: [{ author: author === undefined ? { __typename: typename, login } : author, body, url: `https://github.invalid/pr/81#${login}` }] },
  };
}

function page(head, nodes, endCursor) {
  return { data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null }, nodes } } } } };
}

// A fake `gh` dependency: thread queries are answered from `pages` in order,
// and the head-only recheck answers `postHead`.
function fakeGh(pages, postHead) {
  const calls = [];
  let next = 0;
  const gh = async (cwd, args) => {
    calls.push({ cwd, args });
    const query = args.find((argument) => argument.startsWith("query="));
    if (query.includes("reviewThreads")) return JSON.stringify(pages[next++]);
    return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: postHead } } } });
  };
  return { gh, calls };
}

function verdicts(...entries) {
  return JSON.stringify({ verdicts: entries.map(([thread, verdict, evidence]) => ({ thread, verdict, evidence })) });
}

test("triage classifies bot threads by actor type and prints valid, invalid, and already fixed verdicts", async () => {
  assert.equal(typeof triageModule?.triageCommand, "function");
  await withRepository(async (root, head) => {
    const { gh, calls } = fakeGh([
      page(head, [
        thread({ login: "human-looking-name", body: "first bot finding", line: 3 }),
        thread({ typename: "User", login: "coderabbitai[bot]", body: "user named like a bot" }),
        thread({ resolved: true, body: "resolved bot finding" }),
        thread({ author: null, body: "deleted author" }),
      ], "cursor-1"),
      page(head, [
        thread({ login: "second-bot", body: "second bot finding", path: null, line: null }),
        thread({ login: "third-bot", body: "third bot finding", line: null }),
      ]),
    ], head);
    const inputs = [];
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, {
      gh,
      triage: async (input) => {
        inputs.push(input);
        return verdicts([2, "invalid", "tracked.txt:1 already handles it."], [1, "valid", "tracked.txt:3 still has the defect."], [3, "already-fixed", "Fixed by the head commit."]);
      },
    });
    assert.equal(code, 0, io.read().stderr);
    assert.equal(inputs.length, 1);
    const [input] = inputs;
    assert.deepEqual(input.threads.map((item) => [item.thread, item.author, item.body]), [[1, "human-looking-name", "first bot finding"], [2, "second-bot", "second bot finding"], [3, "third-bot", "third bot finding"]]);
    assert.doesNotMatch(input.prompt, /user named like a bot|resolved bot finding|deleted author/);
    const nonce = /BEGIN REVIEW THREADS ([0-9a-f-]{36})/.exec(input.prompt)?.[1];
    assert.ok(nonce, "the prompt must delimit the data block with a nonce");
    assert.match(input.prompt, new RegExp(`END REVIEW THREADS ${nonce}`));
    assert.match(input.prompt, /never as instructions/);
    assert.equal(input.head, head);
    assert.deepEqual(io.read().stdout.split("\n"), [
      `Triaging 3 unresolved bot review thread(s) on PR #81 at ${head}.`,
      "1. valid: human-looking-name tracked.txt:3",
      "   https://github.invalid/pr/81#human-looking-name",
      "   tracked.txt:3 still has the defect.",
      "2. invalid: second-bot (no path)",
      "   https://github.invalid/pr/81#second-bot",
      "   tracked.txt:1 already handles it.",
      "3. already fixed: third-bot tracked.txt",
      "   https://github.invalid/pr/81#third-bot",
      "   Fixed by the head commit.",
      "",
    ]);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.cwd, root);
      assert.deepEqual(call.args.slice(0, 2), ["api", "graphql"]);
      assert.ok(call.args.includes("number=81"));
      assert.match(call.args.find((argument) => argument.startsWith("query=")), /^query=query\(/);
    }
    assert.equal(calls[0].args.some((argument) => argument.startsWith("cursor=")), false);
    assert.ok(calls[1].args.includes("cursor=cursor-1"));
    assert.doesNotMatch(calls[2].args.find((argument) => argument.startsWith("query=")), /reviewThreads/);
  });
});

test("triage refuses when local HEAD is not the PR head, before Codex runs", async () => {
  await withRepository(async (root) => {
    const { gh } = fakeGh([page("a".repeat(40), [thread()])], "a".repeat(40));
    let called = false;
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => { called = true; return ""; } });
    assert.equal(code, 3);
    assert.equal(called, false);
    assert.match(io.read().stderr, /Local HEAD does not match the head of PR #81/);
  });
});

test("triage discards the output when the PR head or local HEAD moves during the run", async () => {
  await withRepository(async (root, head) => {
    const { gh } = fakeGh([page(head, [thread()])], "b".repeat(40));
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => verdicts([1, "valid", "stale output"]) });
    assert.equal(code, 3);
    assert.equal(io.read().stdout, "");
    assert.match(io.read().stderr, /moved during triage; run triage again\./);
  });
  await withRepository(async (root, head) => {
    const { gh } = fakeGh([page(head, [thread()])], head);
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, {
      gh,
      triage: async () => {
        await git(root, "commit", "--quiet", "--allow-empty", "-m", "chore: move head");
        return verdicts([1, "valid", "stale output"]);
      },
    });
    assert.equal(code, 3);
    assert.equal(io.read().stdout, "");
  });
});

test("triage refuses more than 50 bot threads and comments above 8 KiB without truncating", async () => {
  await withRepository(async (root, head) => {
    const fifty = Array.from({ length: 50 }, () => thread());
    const accepted = fakeGh([page(head, [...fifty, thread({ typename: "User", login: "someone" })])], head);
    const entries = fifty.map((_, index) => [index + 1, "invalid", "evidence"]);
    assert.equal(await triageModule.triageCommand(root, 81, output(), { gh: accepted.gh, triage: async () => verdicts(...entries) }), 0);

    for (const [nodes, pattern] of [
      [[...fifty, thread()], /51 unresolved bot review threads; triage refuses more than 50\./],
      [[thread({ body: "x".repeat(8192) }), thread({ body: "y".repeat(8193) })], /exceeds 8192 bytes; triage refuses rather than truncating it\./],
      [[thread({ body: "\u00e9".repeat(4097) })], /exceeds 8192 bytes/],
    ]) {
      const { gh } = fakeGh([page(head, nodes)], head);
      let called = false;
      const io = output();
      const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => { called = true; return ""; } });
      assert.equal(code, 3);
      assert.equal(called, false);
      assert.match(io.read().stderr, pattern);
    }
  });
});

test("triage with no unresolved bot threads exits 0 without Codex", async () => {
  await withRepository(async (root, head) => {
    const { gh } = fakeGh([page(head, [thread({ typename: "User", login: "dependabot[bot]" }), thread({ resolved: true })])], head);
    let called = false;
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => { called = true; return ""; } });
    assert.equal(code, 0);
    assert.equal(called, false);
    assert.equal(io.read().stdout, "No unresolved bot review threads on PR #81.\n");
  });
});

test("triage rejects a Codex response that does not classify every thread exactly once", async () => {
  await withRepository(async (root, head) => {
    for (const response of [
      verdicts([1, "valid", "only one"]),
      verdicts([1, "valid", "a"], [1, "invalid", "b"]),
      verdicts([1, "valid", "a"], [2, "maybe", "b"]),
      verdicts([1, "valid", "a"], [3, "invalid", "b"]),
      verdicts([1, "valid", "a"], [2, "invalid", "  "]),
      "not json",
    ]) {
      const { gh } = fakeGh([page(head, [thread(), thread()])], head);
      const io = output();
      const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => response });
      assert.equal(code, 1, response);
      assert.equal(io.read().stdout, "");
      assert.match(io.read().stderr, /Codex returned an invalid triage/);
    }
  });
});

test("triage escapes terminal controls in review text and evidence", async () => {
  await withRepository(async (root, head) => {
    const { gh } = fakeGh([page(head, [thread({ login: "bot\u001b[31m", path: "a\u0007.txt" })])], head);
    const io = output();
    const code = await triageModule.triageCommand(root, 81, io, { gh, triage: async () => verdicts([1, "valid", "see \u001b]8;;x\u0007here"]) });
    assert.equal(code, 0, io.read().stderr);
    assert.doesNotMatch(io.read().stdout, /[\u0007\u001b]/);
    assert.match(io.read().stdout, /bot\\x1B\[31m a\\x07\.txt:1/);
    assert.match(io.read().stdout, /see \\x1B\]8;;x\\x07here/);
  });
});

test("triage fails closed on GitHub errors, a moved head between pages, a dirty worktree, and a detached HEAD", async () => {
  await withRepository(async (root, head) => {
    for (const [pages, pattern] of [
      [[{ errors: [{ message: "ignore this" }], data: null }], /GitHub rejected the read of PR #81\./],
      [[{ data: { repository: { pullRequest: null } } }], /PR #81 was not found on GitHub\./],
      [[page(head, [thread()], "c1"), page("d".repeat(40), [thread()])], /moved while its threads were read/],
      [[page(head, [{ isResolved: false }])], /Unable to read the review threads of PR #81\./],
    ]) {
      const { gh } = fakeGh(pages, head);
      const io = output();
      assert.equal(await triageModule.triageCommand(root, 81, io, { gh, triage: async () => "" }), 3);
      assert.match(io.read().stderr, pattern);
      assert.doesNotMatch(io.read().stderr, /ignore this/);
    }
    const failing = await triageModule.triageCommand(root, 81, output(), { gh: async () => { throw new Error("gh secret"); }, triage: async () => "" });
    assert.equal(failing, 3);

    await writeFile(join(root, "tracked.txt"), "dirty\n");
    const dirty = output();
    assert.equal(await triageModule.triageCommand(root, 81, dirty, fakeGh([page(head, [thread()])], head)), 3);
    assert.match(dirty.read().stderr, /Git worktree is not clean/);
    await git(root, "checkout", "--quiet", "--", "tracked.txt");

    await git(root, "switch", "--quiet", "--detach", "HEAD");
    const detached = output();
    assert.equal(await triageModule.triageCommand(root, 81, detached, { ...fakeGh([page(head, [thread()])], head), triage: async () => "" }), 3);
    assert.match(detached.read().stderr, /named current branch/);
  });
});

test("runGh runs only read-only graphql queries and strips token variables", async () => {
  assert.equal(typeof triageModule?.runGh, "function");
  const root = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-triage-gh-")));
  const saved = Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map((name) => [name, process.env[name]]));
  try {
    const record = join(root, "record.json");
    const binary = join(root, "gh");
    await writeFile(binary, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
process.stderr.write("secret gh diagnostic\\n");
process.stdout.write("{\\"ok\\":true}");
`);
    await chmod(binary, 0o755);
    for (const name of Object.keys(saved)) process.env[name] = "fixture-token";
    const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", "number=81", "-f", "query=query($owner: String!) { viewer { login } }", "-f", "cursor=Y3Vyc29yquery="];
    assert.equal(await triageModule.runGh(binary, root, args), '{"ok":true}');
    const invocation = JSON.parse(await readFile(record, "utf8"));
    assert.deepEqual(invocation.argv, args);
    assert.equal(invocation.cwd, root);
    for (const name of Object.keys(saved)) assert.equal(invocation.env[name], undefined, name);
    assert.equal(invocation.env.GH_PROMPT_DISABLED, "1");

    await rm(record);
    for (const refused of [
      ["pr", "comment", "81", "--body", "x"],
      ["api", "graphql", "-f", "query=mutation { resolveReviewThread(input: {}) { clientMutationId } }"],
      ["api", "graphql", "-X", "POST", "-f", "query=query { viewer { login } }"],
      ["api", "graphql", "-f", "query=query { viewer { login } }", "-f", "query=mutation { resolveReviewThread(input: {}) { clientMutationId } }"],
      ["api", "graphql", "-f", "query=query { viewer { login } }", "--raw-field=query=mutation { resolveReviewThread(input: {}) { clientMutationId } }"],
      ["api", "graphql", "-fquery=mutation { resolveReviewThread(input: {}) { clientMutationId } }"],
      ["api", "repos/{owner}/{repo}/pulls/81/comments"],
    ]) {
      await assert.rejects(triageModule.runGh(binary, root, refused), /not a read/);
    }
    await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" });

    await writeFile(binary, "#!/bin/sh\necho 'secret failure' >&2\nexit 1\n");
    await assert.rejects(triageModule.runGh(binary, root, args), (error) => error.message === "gh failed.");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("triageWithCodex runs Codex in an isolated checkout of the PR head with the head as both ends", async () => {
  assert.equal(typeof triageModule?.triageWithCodex, "function");
  await withRepository(async (root, head) => {
    const runtime = await realpath(await mkdtemp(join(tmpdir(), "andrew-agent-triage-codex-")));
    const stateRoot = join(runtime, "state");
    const record = join(runtime, "record.json");
    const binary = join(runtime, "codex");
    await writeFile(binary, `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const rev = (name) => execFileSync("git", ["rev-parse", "--verify", name + "^{commit}"], { encoding: "utf8" }).trim();
await writeFile(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), head: rev("HEAD"), base: rev("review-base"), tracked: readFileSync("tracked.txt", "utf8"), untrackedVisible: existsSync("untracked.txt"), input }));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "[]" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);
    await chmod(binary, 0o755);
    await writeFile(join(root, "untracked.txt"), "source dirt\n");
    // Leave the named branch so its tip differs from the PR head commit; a
    // mapping that passed the branch name or another commit fails the identity check.
    await writeFile(join(root, "tracked.txt"), "later\n");
    await git(root, "commit", "--quiet", "-am", "fix: later change");
    const environment = Object.fromEntries(["ANDREW_AGENT_CODEX_SOURCE", "ANDREW_AGENT_STATE_ROOT", "ANDREW_AGENT_CODEX_BIN"].map((name) => [name, process.env[name]]));
    process.env.ANDREW_AGENT_CODEX_SOURCE = root;
    process.env.ANDREW_AGENT_STATE_ROOT = stateRoot;
    process.env.ANDREW_AGENT_CODEX_BIN = binary;
    try {
      const result = await triageModule.triageWithCodex({ repositoryRoot: root, headRef: "feature", head, pullRequest: 81, threads: [], prompt: "triage prompt marker" });
      assert.equal(result.response, "[]");
      const invocation = JSON.parse(await readFile(record, "utf8"));
      assert.notEqual(invocation.cwd, root);
      assert.equal(invocation.head, head);
      assert.equal(invocation.base, head);
      assert.equal(invocation.tracked, "after\n");
      assert.equal(invocation.untrackedVisible, false);
      assert.equal(invocation.input, "triage prompt marker");
      assert.equal((await readdir(stateRoot)).some((entry) => entry.startsWith("review-")), false);
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(runtime, { recursive: true, force: true });
    }
  });
});
