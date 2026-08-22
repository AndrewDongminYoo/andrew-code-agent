import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clientModule = await import("../../dist/app-server/client.js").catch(
  () => null,
);

function requireClient() {
  assert.notEqual(
    clientModule,
    null,
    "the built app-server client module must be available",
  );
  return clientModule;
}

async function inventory(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const metadata = await stat(absolute);
      if (metadata.isDirectory()) {
        await visit(absolute);
      } else {
        entries.push({
          path: relative(root, absolute),
          mode: metadata.mode & 0o777,
          bytes: await readFile(absolute),
        });
      }
    }
  }
  await visit(root);
  return entries;
}

async function withFakeCodex(
  scenario,
  run,
  { version = "codex-cli 0.148.0" } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "andrew-agent-codex-"));
  const codexHome = join(root, "home");
  const binary = join(root, "codex");
  const server = join(root, "server.mjs");
  const launcher = join(root, "codex.mjs");
  await writeFile(join(root, "scenario"), scenario);
  await writeFile(
    launcher,
    `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { writeFile } from "node:fs/promises";\nconst root = ${JSON.stringify(root)};\nif (process.argv[2] === "--version") {\n  await writeFile(root + "/version-env.json", JSON.stringify(process.env));\n  console.log(${JSON.stringify(version)});\n  process.exit(0);\n}\nconst child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(server)}, ...process.argv.slice(2)], { stdio: "inherit" });\nchild.on("exit", (code) => process.exit(code ?? 1));\n`,
  );
  await writeFile(binary, await readFile(launcher));
  await chmod(binary, 0o700);
  await writeFile(
    server,
    `import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const home = process.env.CODEX_HOME;
await mkdir(home, { recursive: true });
const root = ${JSON.stringify(root)};
const scenario = (await readFile(${JSON.stringify(join(root, "scenario"))}, "utf8")).trim();
await writeFile(${JSON.stringify(join(root, "spawn.json"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
const record = async (message) => appendFile(${JSON.stringify(join(root, "record.jsonl"))}, JSON.stringify(message) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const initializeResult = { userAgent: "codex-test", codexHome: home, platformFamily: "unix", platformOs: "macos" };
let initialized = false;
let queued = [];
let serverRequested = false;
if (scenario === "handshake-timeout") setInterval(() => {}, 1000);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  await record(message);
  if (message.method === "initialize") {
    if (scenario === "malformed-jsonl") { process.stdout.write("{not-json}\\n"); continue; }
    if (scenario === "malformed-envelope") { send({ id: message.id, result: initializeResult, error: { code: -1, message: "bad" } }); continue; }
    if (scenario !== "handshake-timeout") send({ id: message.id, result: initializeResult });
    continue;
  }
  if (message.method === "initialized") {
    initialized = true;
    if (scenario === "duplicate") send({ id: 1, result: initializeResult });
    if (scenario === "orphan") send({ id: 99, result: {} });
    if (scenario === "unexpected-exit") process.exit(23);
    if (scenario === "notification") setTimeout(() => send({ method: "unknown/notice", params: { visible: true } }), 20);
    if (scenario === "unhandled-request") setTimeout(() => send({ method: "item/tool/requestUserInput", id: "server-1", params: { threadId: "t", turnId: "u", itemId: "i", questions: [] } }), 20);
    continue;
  }
  if (!initialized) process.exit(41);
  if (scenario === "request") send({ method: "item/tool/requestUserInput", id: "server-1", params: { threadId: "t", turnId: "u", itemId: "i", questions: [] } });
  if (scenario === "respond" && message.method === undefined && message.id === "server-1") { send({ method: "response/observed", params: message }); continue; }
  if (scenario === "respond" && !serverRequested) { serverRequested = true; send({ method: "item/tool/requestUserInput", id: "server-1", params: { threadId: "t", turnId: "u", itemId: "i", questions: [] } }); }
  if (scenario === "request-timeout") continue;
  if (scenario === "remote-error") { send({ id: message.id, error: { code: -32000, message: "sensitive upstream detail" } }); continue; }
  if (scenario === "out-of-order") {
    queued.push(message);
    if (queued.length === 2) {
      send({ id: queued[1].id, result: { order: 2 } });
      send({ id: queued[0].id, result: { order: 1 } });
    }
    continue;
  }
  if (scenario === "failure-forwarding") {
    send({ id: message.id, result: { method: message.method, params: message.params } });
    if (message.method === "thread/start") {
      send({ method: "unknown/notice", params: { beforeFailure: true } });
      setTimeout(() => process.exit(23), 10);
    }
    continue;
  }
  send({ id: message.id, result: { method: message.method, params: message.params } });
}
`,
  );
  try {
    await run({ binary, codexHome, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function startInput(binary, codexHome, overrides = {}) {
  return {
    codexBinary: binary,
    codexHome,
    productVersion: "0.1.0",
    handshakeTimeoutMs: 300,
    requestTimeoutMs: 300,
    ...overrides,
  };
}

test("regenerates stable artifacts byte-for-byte", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "andrew-agent-schema-"));
  try {
    assert.equal(
      (await execFileAsync("codex", ["--version"])).stdout.trim(),
      "codex-cli 0.148.0",
    );
    const generated = join(temporary, "generated");
    const schemas = join(temporary, "schemas");
    await execFileAsync("codex", [
      "app-server",
      "generate-ts",
      "--out",
      generated,
    ]);
    await execFileAsync("codex", [
      "app-server",
      "generate-json-schema",
      "--out",
      schemas,
    ]);
    assert.deepEqual(
      await inventory(generated),
      await inventory("src/generated/codex-app-server"),
    );
    assert.deepEqual(
      await inventory(schemas),
      await inventory("schemas/codex-app-server"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("completes initialize and initialized before typed thread calls", async () => {
  await withFakeCodex("normal", async ({ binary, codexHome, root }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    const response = await client.threadStart({ cwd: "/fixture" });
    assert.deepEqual(response, {
      method: "thread/start",
      params: { cwd: "/fixture" },
    });
    await client.close();
    const messages = (await readFile(join(root, "record.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(messages.slice(0, 3), [
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "andrew-code-agent",
            title: "Andrew Code Agent",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      },
      { method: "initialized" },
      { method: "thread/start", id: 2, params: { cwd: "/fixture" } },
    ]);
  });
});

test("uses connection-local monotonic IDs and correlates out-of-order typed responses", async () => {
  await withFakeCodex("out-of-order", async ({ binary, codexHome, root }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    const first = client.threadResume({ threadId: "thread-1" });
    const second = client.turnStart({ threadId: "thread-1", input: [] });
    assert.deepEqual(await Promise.all([first, second]), [
      { order: 1 },
      { order: 2 },
    ]);
    await client.close();
    const ids = (await readFile(join(root, "record.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((message) => "id" in message)
      .map((message) => message.id);
    assert.deepEqual(ids, [1, 2, 3]);
  });
  await withFakeCodex("normal", async ({ binary, codexHome, root }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    await client.threadStart({});
    await client.close();
    const ids = (await readFile(join(root, "record.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((message) => "id" in message)
      .map((message) => message.id);
    assert.deepEqual(ids, [1, 2]);
  });
});

test("forwards typed thread/read calls through the public client", async () => {
  await withFakeCodex("normal", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    try {
      assert.deepEqual(
        await client.threadRead({ threadId: "thread-1", includeTurns: true }),
        {
          method: "thread/read",
          params: { threadId: "thread-1", includeTurns: true },
        },
      );
    } finally {
      await client.close();
    }
  });
});

test("forwards typed turn/interrupt calls through the public client", async () => {
  await withFakeCodex("normal", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    try {
      assert.deepEqual(
        await client.turnInterrupt({
          threadId: "thread-1",
          turnId: "turn-1",
        }),
        {
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        },
      );
    } finally {
      await client.close();
    }
  });
});

test("starts a PATH-dependent launcher with sanitized child environments", async () => {
  await withFakeCodex("normal", async ({ binary, codexHome, root }) => {
    const inheritedPath = process.env.PATH;
    const customEntry = join(root, "custom-bin");
    try {
      process.env.PATH = [
        "relative-bin",
        "",
        customEntry,
        dirname(process.execPath),
        "/usr/bin",
      ].join(delimiter);
      const client = await requireClient().startAppServer(
        startInput(binary, codexHome),
      );
      await client.close();
    } finally {
      if (inheritedPath === undefined) delete process.env.PATH;
      else process.env.PATH = inheritedPath;
    }
    const expectedPath = [
      dirname(process.execPath),
      customEntry,
      "/usr/bin",
      "/bin",
    ].join(delimiter);
    const versionEnvironment = JSON.parse(
      await readFile(join(root, "version-env.json"), "utf8"),
    );
    const spawn = JSON.parse(await readFile(join(root, "spawn.json"), "utf8"));
    const expectedVersionEnvironment = { PATH: expectedPath };
    if (
      process.platform === "darwin" &&
      "__CF_USER_TEXT_ENCODING" in versionEnvironment
    ) {
      expectedVersionEnvironment.__CF_USER_TEXT_ENCODING =
        versionEnvironment.__CF_USER_TEXT_ENCODING;
    }
    assert.deepEqual(versionEnvironment, expectedVersionEnvironment);
    assert.deepEqual(spawn.argv, ["app-server", "--strict-config", "--stdio"]);
    const expectedSpawnEnvironment = {
      CODEX_HOME: codexHome,
      PATH: expectedPath,
    };
    if (
      process.platform === "darwin" &&
      "__CF_USER_TEXT_ENCODING" in spawn.env
    ) {
      expectedSpawnEnvironment.__CF_USER_TEXT_ENCODING =
        spawn.env.__CF_USER_TEXT_ENCODING;
    }
    assert.deepEqual(spawn.env, expectedSpawnEnvironment);
  });
});

test("fails a version mismatch before starting app-server", async () => {
  await withFakeCodex(
    "normal",
    async ({ binary, codexHome, root }) => {
      await assert.rejects(
        requireClient().startAppServer(startInput(binary, codexHome)),
        { code: "CODEX_VERSION_MISMATCH" },
      );
      await assert.rejects(readFile(join(root, "spawn.json")), {
        code: "ENOENT",
      });
    },
    { version: "codex-cli 0.149.0" },
  );
});

test("validates the required initialize response fields", async () => {
  await withFakeCodex("malformed-envelope", async ({ binary, codexHome }) => {
    await assert.rejects(
      requireClient().startAppServer(startInput(binary, codexHome)),
      { code: "MALFORMED_PROTOCOL" },
    );
  });
});

test("keeps correlated remote errors request-local and redacted", async () => {
  await withFakeCodex("remote-error", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    await assert.rejects(client.threadStart({ cwd: "/secret" }), (error) => {
      assert.equal(error.code, "APP_SERVER_REMOTE_ERROR");
      assert.doesNotMatch(String(error), /sensitive|secret/);
      return true;
    });
    await assert.rejects(client.turnStart({ threadId: "t", input: [] }), {
      code: "APP_SERVER_REMOTE_ERROR",
    });
    await client.close();
  });
});

test("delivers unknown notifications and typed server requests to registered listeners", async () => {
  await withFakeCodex("notification", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    const seen = new Promise((resolve) => client.onNotification(resolve));
    assert.deepEqual(await seen, {
      method: "unknown/notice",
      params: { visible: true },
    });
    await client.close();
  });
  await withFakeCodex("request", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    const seen = new Promise((resolve) => client.onRequest(resolve));
    await client.threadStart({});
    assert.deepEqual(await seen, {
      method: "item/tool/requestUserInput",
      id: "server-1",
      params: { threadId: "t", turnId: "u", itemId: "i", questions: [] },
    });
    await client.close();
  });
  await withFakeCodex("unhandled-request", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(client.threadStart({}), {
      code: "MALFORMED_PROTOCOL",
    });
    await client.close();
  });
});

test("forwards the transport failure subscription through the public client", async () => {
  await withFakeCodex("failure-forwarding", async ({ binary, codexHome }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    const order = [];
    client.onNotification(() => order.push("notification"));
    const failure = new Promise((resolve) =>
      client.onFailure((error) => {
        order.push("failure");
        resolve(error);
      }),
    );
    await client.threadStart({ cwd: "/fixture" });
    const error = await failure;
    assert.equal(error.code, "APP_SERVER_UNEXPECTED_EXIT");
    assert.deepEqual(order, ["notification", "failure"]);
    await client.close();
  });
});

test("answers a generated server request once without allocating a client request ID", async () => {
  await withFakeCodex("respond", async ({ binary, codexHome, root }) => {
    const client = await requireClient().startAppServer(
      startInput(binary, codexHome),
    );
    try {
      assert.equal(typeof client.respond, "function");
      const observed = new Promise((resolve) =>
        client.onNotification((message) => {
          if (message.method === "response/observed") resolve(message.params);
        }),
      );
      client.onRequest((message) => {
        void client.respond(message.id, { decision: "decline" });
      });
      await client.threadStart({});
      assert.deepEqual(await observed, {
        id: "server-1",
        result: { decision: "decline" },
      });
      await client.turnStart({ threadId: "t", input: [] });
    } finally {
      await client.close();
    }
    const messages = (await readFile(join(root, "record.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      messages.map((message) => message.id).filter((id) => id !== undefined),
      [1, 2, "server-1", 3],
    );
  });
});
