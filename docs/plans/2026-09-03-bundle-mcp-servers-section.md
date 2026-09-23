# Bundle `[[mcp_servers]]` Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bundle manifest declare a stdio MCP server that is rendered into the managed `config.toml` only when its capability is enabled, so an Oracle-enabled run can reach the classifying retrieval provider.

**Architecture:** A new `[[mcp_servers]]` manifest section parsed by `src/bundle/manifest.ts` into `McpServerDefinition`, filtered by capability in `src/bundle/render.ts` exactly as `[[files]]` and `[[hooks]]` are, and written into the generated `config.toml` as `[mcp_servers.<name>]` tables.
The TOML writer gains string-array support for `args`, `env_vars` and `enabled_tools`.
Nothing else in the run path changes: the existing `--strict-config` probe in doctor rejects a key the pinned Codex does not accept, which is the fail-closed check on the rendered shape.

**Tech Stack:** TypeScript (strict), `smol-toml` for parsing, `node --test` layers per `CLAUDE.md`, prettier and markdownlint through Trunk.

**Spec:** `docs/specs/2026-08-28-oracle-output-safety-boundary.md` ("Implementation ownership and sequence": this repository owns forwarding the explicitly enabled Oracle root; it must not implement classification).
This plan is phase 1 of the sequence recorded on issue #25 on 2026-09-03.

## Global Constraints

- A rendered file must never contain the runtime Oracle root literal;
  `validatePortableFiles` scans for it (`src/bundle/render.ts:144-157`).
  MCP entries therefore refer to the root only through a shell command that reads `$LLM_WIKI_ROOT` at spawn time or through an environment variable forwarded by name; nothing expands `${...}` tokens inside the generated `config.toml`.
- A `${TOKEN}` belonging to a disabled capability must not survive into any
  rendered file (`assertDisabledCapabilityTokens`, `render.ts:619-642`).
  Capability filtering must happen before `createGeneratedConfig` serializes.
- `src/generated/**` and `schemas/**` are generator-owned; do not touch them.
- Most test files import `dist/`; run `pnpm build` before any `node --test`.
- Markdown prose follows the sentence-level line breaks in `AGENTS.md`.
- No machine-specific path (for example `/opt/homebrew/bin/pnpm`) may be
  written into a fixture that ships; fixtures use `/bin/sh` and `/usr/bin`.

---

### Task 1: Measure what a Codex 0.152.1 stdio MCP child receives

The manifest shape depends on one fact this repository does not control: the environment and working directory Codex gives an MCP child.
The pinned binary is `~/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex` (never let `PATH` pick it).
This task records the answer in a dated note and nothing else.

**Files:**

- Create: `docs/notes/2026-09-04-mcp-child-environment.md`

**Interfaces:**

- Produces: the facts Task 3 relies on, named `MCP_ENV_INHERITS_PARENT`
  (boolean), `MCP_ENV_VARS_KEY_ACCEPTED` (boolean, whether `mcp_servers.<name>.env_vars` passes `--strict-config`), and `MCP_CWD_DEFAULT` (the child's `pwd`).

- \[ \] **Step 1: Write a recording MCP "server"**

Create `/tmp/mcp-probe/record.sh` (outside the repository):

```sh
#!/bin/sh
# Records what Codex handed this MCP child, then behaves as a server that
# never answers, so the session moves on after its startup timeout.
out="/tmp/mcp-probe/child.txt"
{ echo "cwd=$(pwd)"; env | sort; } > "$out"
exec cat
```

Run `chmod 0755 /tmp/mcp-probe/record.sh`.

- \[ \] **Step 2: Write a strict-config probe home**

Create `/tmp/mcp-probe/home/config.toml`:

```toml
[mcp_servers.probe]
command = "/tmp/mcp-probe/record.sh"
args = []
env = { PROBE_LITERAL = "set-by-config" }
env_vars = ["PROBE_PARENT"]
startup_timeout_sec = 5
```

- \[ \] **Step 3: Check whether the key set passes strict config**

Run:

```bash
CODEX_HOME=/tmp/mcp-probe/home PROBE_PARENT=from-parent \
  ~/.codex/packages/standalone/releases/0.152.1-aarch64-apple-darwin/bin/codex \
  app-server --strict-config --stdio < /dev/null; echo "exit=$?"
```

Expected: exit 0 means every key was accepted; a non-zero exit with a message naming `env_vars` means the key is unknown to 0.152.1.
Record the verbatim message either way as `MCP_ENV_VARS_KEY_ACCEPTED`.

- \[ \] **Step 4: Drive one thread so the MCP child is spawned**

Codex spawns MCP servers when a thread starts, not when the app server starts.
Use the live smoke's credentials (see the project memory `live-smoke-setup`) and the existing e2e harness:

```bash
pnpm build
REL=~/.codex/packages/standalone/releases
CODEX=$REL/0.152.1-aarch64-apple-darwin/bin/codex
ANDREW_AGENT_REAL_SMOKE=1 ANDREW_AGENT_SMOKE_AUTH=<path> \
ANDREW_AGENT_CODEX_BIN="$CODEX" \
  node --test --test-name-pattern='real Codex' test/e2e/acceptance.test.mjs
```

Before running, copy `config.toml` from Step 2 over the fixture's rendered `codex-home/config.toml` is not possible (the install owns it), so instead add the `[mcp_servers.probe]` table to `/tmp/mcp-probe/source/config.toml` of a throwaway bundle source and point `ANDREW_AGENT_CODEX_SOURCE` at it, with `config_keys` in its `agent-bundle.toml` listing `mcp_servers.probe.command` and `mcp_servers.probe.startup_timeout_sec`.
Scalar keys only: this proves the spawn, not the array keys.

Expected: `/tmp/mcp-probe/child.txt` exists after the run.

- \[ \] **Step 5: Record the note**

Write `docs/notes/2026-09-04-mcp-child-environment.md` with: the exact commands, the strict-config exit code and message, the full sorted `env` the child saw with values redacted to presence, the `cwd`, and the three named facts.
State which of `HOME`, `PATH`, `CODEX_HOME`, `LLM_WIKI_ROOT` and `PROBE_PARENT` were present.
Use sentence-level line breaks.

- \[ \] **Step 6: Commit**

```bash
git add docs/notes/2026-09-04-mcp-child-environment.md
git commit -m "docs(notes): measure the environment a Codex MCP child receives"
```

---

### Task 2: Parse `[[mcp_servers]]` in the manifest

**Files:**

- Modify: `src/bundle/manifest.ts` (types near line 41-61, root
  `assertKeys` at 112-123, add a reader beside `readRequirements` at 436)
- Modify: `test/fixtures/manifests/valid.toml`
- Create: `test/fixtures/manifests/mcp-duplicate.toml`
- Test: `test/unit/manifest.test.mjs`

**Interfaces:**

- Produces:

```ts
export interface McpServerDefinition {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly envVars: readonly string[];
  readonly enabledTools: readonly string[];
  readonly defaultToolsApprovalMode?: "approve" | "prompt";
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly capability?: CapabilityName;
}
```

and `BundleManifest.mcpServers: readonly McpServerDefinition[]`, sorted by `name`.
New `ManifestErrorCode` members: `"INVALID_MCP_SERVER"` and `"DUPLICATE_MCP_SERVER"`.

- \[ \] **Step 1: Extend the valid fixture and write the failing tests**

Append to `test/fixtures/manifests/valid.toml`:

```toml
[[mcp_servers]]
name = "oracle"
command = "/bin/sh"
args = [
  "-c",
  "cd \"$LLM_WIKI_ROOT\" && exec pnpm exec tsx mcp-server/src/start-local.ts",
]
env = { LLM_WIKI_MCP_MODE = "managed" }
env_vars = ["LLM_WIKI_ROOT", "PATH"]
enabled_tools = ["search_precedent", "read_precedent", "read_evidence"]
default_tools_approval_mode = "approve"
startup_timeout_sec = 240
tool_timeout_sec = 60
capability = "oracle"
```

Create `test/fixtures/manifests/mcp-duplicate.toml` as a copy of `valid.toml` with the `[[mcp_servers]]` block repeated verbatim.

Add to `test/unit/manifest.test.mjs`, after the `manifest.requirements` assertion inside `decodes a valid manifest into a stable sorted file contract`:

```js
assert.deepEqual(manifest.mcpServers, [
  {
    name: "oracle",
    command: "/bin/sh",
    args: [
      "-c",
      'cd "$LLM_WIKI_ROOT" && exec pnpm exec tsx mcp-server/src/start-local.ts',
    ],
    env: { LLM_WIKI_MCP_MODE: "managed" },
    envVars: ["LLM_WIKI_ROOT", "PATH"],
    enabledTools: ["search_precedent", "read_precedent", "read_evidence"],
    defaultToolsApprovalMode: "approve",
    startupTimeoutSec: 240,
    toolTimeoutSec: 60,
    capability: "oracle",
  },
]);
```

And new tests at the end of the file:

```js
test("rejects a duplicate MCP server name", async () => {
  assertManifestError(await fixture("mcp-duplicate"), "DUPLICATE_MCP_SERVER");
});

test("rejects a bad command, name, key, or approval mode", async () => {
  const valid = await fixture("valid");
  assertManifestError(
    valid.replace('command = "/bin/sh"', 'command = "sh"'),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(
    valid.replace(
      'name = "oracle"\ncommand',
      'name = "Oracle Server"\ncommand',
    ),
    "INVALID_MCP_SERVER",
  );
  assertManifestError(
    valid.replace(
      "tool_timeout_sec = 60",
      'tool_timeout_sec = 60\ncwd = "/tmp"',
    ),
    "UNKNOWN_KEY",
  );
  assertManifestError(
    valid.replace(
      'default_tools_approval_mode = "approve"',
      'default_tools_approval_mode = "always"',
    ),
    "INVALID_MCP_SERVER",
  );
});

test("a manifest without mcp_servers parses to an empty list", async () => {
  const manifest = parse(
    (await fixture("valid")).replace(
      /\[\[mcp_servers\]\][\s\S]*?capability = "oracle"\n/,
      "",
    ),
  );
  assert.deepEqual(manifest.mcpServers, []);
});
```

- \[ \] **Step 2: Run the tests to verify they fail**

Run: `pnpm build && node --test test/unit/manifest.test.mjs` Expected: the first assertion fails with `manifest.mcpServers` undefined; the duplicate test fails because `mcp_servers` is reported as `UNKNOWN_KEY`.

- \[ \] **Step 3: Implement the reader**

In `src/bundle/manifest.ts`:

1. Add `"mcp_servers"` to the root `assertKeys` list at line 112-123.
2. Add the interface from **Interfaces** next to `RequirementDefinition`,
   add `readonly mcpServers: readonly McpServerDefinition[];` to `BundleManifest`, and add the two error codes to `ManifestErrorCode`.
3. Add the reader, modelled on `readRequirements`:

```ts
const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const MCP_SERVER_KEYS = [
  "name",
  "command",
  "args",
  "env",
  "env_vars",
  "enabled_tools",
  "default_tools_approval_mode",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "capability",
] as const;

function readMcpServers(
  values: readonly unknown[],
): readonly McpServerDefinition[] {
  const names = new Set<string>();
  const servers = values.map((value, index) => {
    const location = `mcp_servers[${index}]`;
    const table = readTable(value, location);
    assertKeys(table, location, [...MCP_SERVER_KEYS]);
    const name = readString(table, "name", location);
    if (!MCP_SERVER_NAME.test(name)) {
      throw new ManifestError(
        "INVALID_MCP_SERVER",
        `${location}.name must match ${MCP_SERVER_NAME}.`,
      );
    }
    if (names.has(name)) {
      throw new ManifestError(
        "DUPLICATE_MCP_SERVER",
        `MCP server ${name} is declared more than once.`,
      );
    }
    names.add(name);
    const command = readString(table, "command", location);
    if (!command.startsWith("/")) {
      throw new ManifestError(
        "INVALID_MCP_SERVER",
        `${location}.command must be an absolute POSIX path.`,
      );
    }
    const args = hasOwn(table, "args")
      ? readStringArray(table, "args", location)
      : [];
    const env = hasOwn(table, "env")
      ? readStringMap(table, "env", location)
      : {};
    const envVars = hasOwn(table, "env_vars")
      ? readStringArray(table, "env_vars", location)
      : [];
    const enabledTools = hasOwn(table, "enabled_tools")
      ? readStringArray(table, "enabled_tools", location)
      : [];
    const definition: {
      -readonly [K in keyof McpServerDefinition]: McpServerDefinition[K];
    } = { name, command, args, env, envVars, enabledTools };
    if (hasOwn(table, "default_tools_approval_mode")) {
      const mode = readString(table, "default_tools_approval_mode", location);
      if (mode !== "approve" && mode !== "prompt") {
        throw new ManifestError(
          "INVALID_MCP_SERVER",
          `${location}.default_tools_approval_mode must be approve or prompt.`,
        );
      }
      definition.defaultToolsApprovalMode = mode;
    }
    for (const [key, field] of [
      ["startup_timeout_sec", "startupTimeoutSec"],
      ["tool_timeout_sec", "toolTimeoutSec"],
    ] as const) {
      if (!hasOwn(table, key)) continue;
      const seconds = table[key];
      if (
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > 3600
      ) {
        throw new ManifestError(
          "INVALID_MCP_SERVER",
          `${location}.${key} must be an integer between 1 and 3600.`,
        );
      }
      definition[field] = seconds;
    }
    const capability = readOptionalCapability(table, location);
    if (capability !== undefined) definition.capability = capability;
    return definition;
  });
  return servers.sort((left, right) => compareCodeUnits(left.name, right.name));
}

function readStringMap(
  table: Record<string, unknown>,
  key: string,
  location: string,
): Readonly<Record<string, string>> {
  const value = readTable(table[key], `${location}.${key}`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof entry !== "string") {
      throw new ManifestError(
        "INVALID_MCP_SERVER",
        `${location}.${key}.${name}: uppercase name and string value required.`,
      );
    }
    result[name] = entry;
  }
  return result;
}
```

4. Wire it where `requirements` is read into the `BundleManifest` literal,
   using whatever array reader `requirements` already uses (read the surrounding code; do not invent a second one):

```ts
mcpServers: hasOwn(root, "mcp_servers")
  ? readMcpServers(readArray(root, "mcp_servers", "manifest"))
  : [],
```

- \[ \] **Step 4: Run the tests to verify they pass**

Run: `pnpm build && node --test test/unit/manifest.test.mjs` Expected: all pass, including the three new tests.

- \[ \] **Step 5: Run the wider gates**

Run:

```bash
pnpm typecheck && pnpm test:unit && \
  trunk check --no-fix src/bundle/manifest.ts test/fixtures/manifests
```

Expected: clean.
`test/unit/render.test.mjs` still passes because its inline `manifest()` object lacks `mcpServers`; Task 3 makes the renderer tolerate `undefined` only through the parser, so add `mcpServers: []` to that inline object now to keep the type honest.

- \[ \] **Step 6: Commit**

```bash
git add src/bundle/manifest.ts test/fixtures/manifests \
  test/unit/manifest.test.mjs test/unit/render.test.mjs
git commit -m "feat(bundle): parse a capability-gated mcp_servers section"
```

---

### Task 3: Render `[mcp_servers.<name>]` only for enabled capabilities

**Files:**

- Modify: `src/bundle/render.ts` (`ConfigTable` at 65-69, capability
  filters at 97-106, `createGeneratedConfig` at 644-669, `writeTomlTable` and `formatTomlScalar` at 763-796)
- Test: `test/unit/render.test.mjs`

**Interfaces:**

- Consumes: `BundleManifest.mcpServers` from Task 2.
- Produces: in the generated `config.toml`, one `[mcp_servers.<name>]`
  table per active server with keys `command`, `args`, `env` (as a nested `[mcp_servers.<name>.env]` table), `env_vars`, `enabled_tools`, `default_tools_approval_mode`, `startup_timeout_sec`, `tool_timeout_sec`, each present only when the manifest set it (arrays are written even when empty for `args`; `env_vars` and `enabled_tools` are omitted when empty).

- \[ \] **Step 1: Write the failing tests**

Add to `test/unit/render.test.mjs`, next to the config tests near line 570.

`renderedText` and `parse` (smol-toml) already exist in that file.

```js
const ORACLE_ARGV = [
  "-c",
  'cd "$LLM_WIKI_ROOT" && exec pnpm exec tsx mcp-server/src/start-local.ts',
];

const oracleMcpServer = () => ({
  name: "oracle",
  command: "/bin/sh",
  args: ORACLE_ARGV,
  env: { LLM_WIKI_MCP_MODE: "managed" },
  envVars: ["LLM_WIKI_ROOT", "PATH"],
  enabledTools: ["search_precedent", "read_precedent", "read_evidence"],
  defaultToolsApprovalMode: "approve",
  startupTimeoutSec: 240,
  toolTimeoutSec: 60,
  capability: "oracle",
});

test("renders a gated MCP server only when enabled", async () => {
  await withSourceRepository(async (repository) => {
    const gated = manifest();
    gated.mcpServers = [oracleMcpServer()];
    const disabled = await renderBundle(repository, gated, {});
    assert.equal(
      parse(renderedText(disabled, "config.toml")).mcp_servers,
      undefined,
    );

    const enabled = await renderBundle(repository, gated, {
      oracle: { llmWikiRoot: repository },
    });
    const config = parse(renderedText(enabled, "config.toml"));
    assert.deepEqual(config.mcp_servers, {
      oracle: {
        command: "/bin/sh",
        args: ORACLE_ARGV,
        env: { LLM_WIKI_MCP_MODE: "managed" },
        env_vars: ["LLM_WIKI_ROOT", "PATH"],
        enabled_tools: ["search_precedent", "read_precedent", "read_evidence"],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 240,
        tool_timeout_sec: 60,
      },
    });
    assert.doesNotMatch(
      renderedText(enabled, "config.toml"),
      new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});

test("renders an ungated MCP server with arrays intact", async () => {
  await withSourceRepository(async (repository) => {
    const base = manifest();
    base.mcpServers = [
      {
        name: "probe",
        command: "/bin/sh",
        args: [],
        env: {},
        envVars: [],
        enabledTools: [],
      },
    ];
    const config = parse(
      renderedText(await renderBundle(repository, base, {}), "config.toml"),
    );
    assert.deepEqual(config.mcp_servers, {
      probe: { command: "/bin/sh", args: [] },
    });
  });
});
```

The `llmWikiRoot: repository` value reuses the fixture repository as the Oracle root so the literal-root scan has something to look for; the `doesNotMatch` assertion is what proves the root never reaches the config.

- \[ \] **Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm build && \
  node --test --test-name-pattern='MCP server' test/unit/render.test.mjs
```

Expected: both fail; `config.mcp_servers` is `undefined` in the enabled case.

- \[ \] **Step 3: Implement rendering**

In `src/bundle/render.ts`:

1. Widen the config model:

```ts
type ConfigScalar = string | boolean | number;
type ConfigValue = ConfigScalar | readonly string[] | ConfigTable;

interface ConfigTable {
  [key: string]: ConfigValue;
}
```

Update `isConfigTable` to exclude arrays (`Array.isArray(value)` is not a table) and `formatTomlScalar` to accept `ConfigScalar | readonly string[]`:

```ts
function formatTomlValue(value: ConfigScalar | readonly string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
```

and use it in `writeTomlTable` in place of `formatTomlScalar`.
Keep `setConfigValue`, `readConfigValue` and `config_overrides` scalar-only; arrays enter only through the MCP path below, so `config_keys` cannot start projecting arrays by accident.

2. Filter servers beside the other two filters at line 97-106:

```ts
const activeMcpServers = manifest.mcpServers.filter(
  (server) =>
    server.capability === undefined ||
    enabledCapabilities.includes(server.capability),
);
```

and pass `activeMcpServers` into `createGeneratedConfig` (add a fourth parameter; update its one call site).

3. In `createGeneratedConfig`, after the agents loop:

```ts
for (const server of servers) {
  const table: ConfigTable = { command: server.command, args: server.args };
  if (Object.keys(server.env).length > 0) table.env = { ...server.env };
  if (server.envVars.length > 0) table.env_vars = server.envVars;
  if (server.enabledTools.length > 0) table.enabled_tools = server.enabledTools;
  if (server.defaultToolsApprovalMode !== undefined)
    table.default_tools_approval_mode = server.defaultToolsApprovalMode;
  if (server.startupTimeoutSec !== undefined)
    table.startup_timeout_sec = server.startupTimeoutSec;
  if (server.toolTimeoutSec !== undefined)
    table.tool_timeout_sec = server.toolTimeoutSec;
  setConfigTable(projected, ["mcp_servers", server.name], table);
}
```

with a small helper that refuses to overwrite a key `config_keys` or `config_overrides` already set:

```ts
function setConfigTable(
  root: ConfigTable,
  path: readonly string[],
  table: ConfigTable,
): void {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (next === undefined) {
      cursor[segment] = {};
    } else if (!isConfigTable(next)) {
      throw new RenderError(
        "CONFIG_INVALID",
        `${path.join(".")} collides with a scalar config key.`,
      );
    }
    cursor = cursor[segment] as ConfigTable;
  }
  const leaf = path[path.length - 1];
  if (cursor[leaf] !== undefined) {
    throw new RenderError(
      "CONFIG_INVALID",
      `${path.join(".")} is declared twice.`,
    );
  }
  cursor[leaf] = table;
}
```

4. Token check: `assertDisabledCapabilityTokens` already scans the
   rendered config; because the filter above runs before serialization, a gated server's `${LLM_WIKI_ROOT}` never reaches a disabled build.
   No change there.

- \[ \] **Step 4: Run the tests to verify they pass**

Run: `pnpm build && node --test test/unit/render.test.mjs` Expected: all pass.

- \[ \] **Step 5: Run the wider gates**

Run:

```bash
pnpm typecheck && pnpm test:unit && pnpm test:integration && \
  trunk check --no-fix src/bundle/render.ts test/unit/render.test.mjs
```

Expected: clean.
The integration layer is included because `test/integration/install.test.mjs` and `doctor.test.mjs` render real bundles from `test/fixtures/manifests/acceptance.toml`; if that fixture has no `[[mcp_servers]]`, nothing changes for them.

- \[ \] **Step 6: Commit**

```bash
git add src/bundle/render.ts test/unit/render.test.mjs
git commit -m "feat(bundle): render gated MCP servers into config.toml"
```

---

### Task 4: Prove the rendered table against the pinned binary

`--strict-config` is the only authority on which keys 0.152.1 accepts.
The doctor probe already runs it against the installed home, so the contract test is the place to pin the shape.

**Files:**

- Modify: `test/fixtures/manifests/acceptance.toml` (add the oracle server
  from Task 2's fixture, gated on `oracle`)
- Test: `test/contract/client.test.mjs` (skip-gated on
  `ANDREW_AGENT_PINNED_CODEX_BIN`, like `regenerates stable artifacts`)

- \[ \] **Step 1: Write the failing contract test**

Add next to `regenerates stable artifacts byte-for-byte`:

```js
test(
  "the pinned binary accepts a rendered MCP server table under strict config",
  { skip: pinnedCodexSkipReason },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "andrew-agent-mcp-strict-"));
    try {
      await writeFile(
        join(home, "config.toml"),
        [
          "[mcp_servers.oracle]",
          'command = "/bin/sh"',
          'args = ["-c", "exec cat"]',
          'env_vars = ["LLM_WIKI_ROOT"]',
          'enabled_tools = ["search_precedent"]',
          'default_tools_approval_mode = "approve"',
          "startup_timeout_sec = 5",
          "tool_timeout_sec = 5",
          "",
          "[mcp_servers.oracle.env]",
          'LLM_WIKI_MCP_MODE = "managed"',
          "",
        ].join("\n"),
      );
      const probe = await probeStrictConfig(pinnedCodexBin, home);
      assert.equal(probe.code, 0, probe.stderr);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
```

`probeStrictConfig` exists in `test/e2e/acceptance.test.mjs`; move it to a shared helper `test/helpers/strict-config.mjs` and import it from both files rather than copying it.

- \[ \] **Step 2: Run it against the pinned binary**

Run:

```bash
pnpm build
REL=~/.codex/packages/standalone/releases
CODEX=$REL/0.152.1-aarch64-apple-darwin/bin/codex
ANDREW_AGENT_PINNED_CODEX_BIN="$CODEX" \
  node --test --test-name-pattern='strict config' test/contract/client.test.mjs
```

Expected: PASS if every key is accepted.
If it fails naming `env_vars`, remove `env_vars` from the manifest section (Task 2) and from the renderer (Task 3), and record in the Task 1 note that forwarding by name is not available in 0.152.1; the bundle then relies on `MCP_ENV_INHERITS_PARENT`.

- \[ \] **Step 3: Commit**

```bash
git add test/contract/client.test.mjs test/helpers/strict-config.mjs \
  test/e2e/acceptance.test.mjs test/fixtures/manifests/acceptance.toml
git commit -m "test(contract): pin the MCP server table under strict config"
```

---

### Task 5: Document the section

**Files:**

- Modify: `README.md` (the manifest reference section; find it with
  `grep -n 'requirements' README.md`)
- Modify: `CLAUDE.md` "Architecture" step 3 (one sentence: config also
  carries capability-gated MCP servers)

- \[ \] **Step 1: Write the reference**

Add a `### mcp_servers` subsection beside the `requirements` one, listing every key from Task 2 with its type and whether it is optional, the name pattern, the absolute-command rule, the capability filter, and this sentence verbatim: "The runtime Oracle root never appears in the rendered config; a server reaches it through `env_vars` forwarding or through a shell that reads `$LLM_WIKI_ROOT`."

- \[ \] **Step 2: Lint**

Run: `trunk check --no-fix README.md CLAUDE.md` Expected: clean.

- \[ \] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: describe the mcp_servers manifest section"
```

---

## Self-review

- Spec coverage: the spec assigns this repository "forwarding the explicitly
  enabled Oracle root" (Task 3 keeps the root out of rendered bytes and forwards it by name) and forbids classification here (no task touches agent output).
- Placeholder scan: Task 1 Step 4 depends on the live smoke; if
  `ANDREW_AGENT_SMOKE_AUTH` is unavailable, the note records `[TOOL_FAILED]` for the spawn measurement and Task 4's strict-config probe still decides the key set.
- Type consistency: `McpServerDefinition` field names in Task 2 match the
  object literal in Task 3's tests and the table keys in Task 3's renderer.
