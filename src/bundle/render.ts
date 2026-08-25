import { execFile as execFileCallback } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { parse } from "smol-toml";

import type {
  BundleFileEntry,
  BundleManifest,
  CapabilityDefinition,
  HookSelection,
  RequirementDefinition,
} from "./manifest.js";
import { resolveSourceFiles, type ResolvedSourceFile } from "./source-tree.js";
import { validatePortableFiles } from "./validate.js";

const generatedConfigTarget = "config.toml";
const generatedHooksTarget = "hooks.json";
const configInputTarget = "__render_input_config.toml";
const hooksInputTarget = "__render_input_hooks.json";
const execFile = promisify(execFileCallback);

export interface CapabilityInputs {
  readonly oracle?: { readonly llmWikiRoot: string };
}

export interface RenderedBundle {
  readonly files: readonly ResolvedSourceFile[];
  readonly enabledCapabilities: readonly string[];
  readonly disabledCapabilities: Readonly<Record<string, string>>;
}

export type RenderErrorCode =
  | "UNSUPPORTED_CAPABILITY"
  | "CAPABILITY_INPUT_INVALID"
  | "ORACLE_INPUT_INVALID"
  | "BASE_REQUIREMENT_UNAVAILABLE"
  | "CAPABILITY_REQUIREMENT_UNAVAILABLE"
  | "RENDERED_TARGET_CONFLICT"
  | "CONFIG_INVALID"
  | "CONFIG_KEY_MISSING"
  | "HOOKS_INVALID"
  | "HOOK_COMMAND_INVALID"
  | "HOOK_CARDINALITY_INVALID"
  | "HOOK_SOURCE_MISMATCH"
  | "HOOK_DEPENDENCY_MISSING"
  | "REPLACEMENT_INPUT_INVALID"
  | "REPLACEMENT_COUNT_MISMATCH"
  | "DISABLED_CAPABILITY_TOKEN"
  | "INSTRUCTION_SECTION_CARDINALITY"
  | "INSTRUCTION_SECTION_MISSING";

export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

type ConfigScalar = string | boolean | number;

interface ConfigTable {
  [key: string]: ConfigScalar | ConfigTable;
}

export async function renderBundle(
  sourceRoot: string,
  manifest: BundleManifest,
  capabilities: CapabilityInputs,
): Promise<RenderedBundle> {
  assertSupportedCapabilities(manifest.capabilities);
  assertCapabilityInputs(manifest, capabilities);
  await assertRequirements(manifest.requirements, undefined);

  const oracle = manifest.capabilities.find(
    (capability) => capability.name === "oracle",
  );
  const oracleEnabled = await resolveOracleCapability(oracle, capabilities);
  if (oracleEnabled) {
    await assertRequirements(manifest.requirements, "oracle");
  }

  const enabledCapabilities = oracleEnabled ? ["oracle"] : [];
  const disabledCapabilities =
    oracle === undefined || oracleEnabled
      ? {}
      : { oracle: "Oracle input was not provided." };
  const activeFiles = manifest.files.filter(
    (file) =>
      file.capability === undefined ||
      enabledCapabilities.includes(file.capability),
  );
  const activeHooks = manifest.hooks.filter(
    (hook) =>
      hook.capability === undefined ||
      enabledCapabilities.includes(hook.capability),
  );
  assertHookCommands(activeHooks);
  assertUniqueHookSelections(activeHooks);
  const sourceFiles = await resolveSourceFiles(
    sourceRoot,
    manifestForSourceResolution(manifest, activeFiles),
  );
  const sourceByTarget = new Map(
    sourceFiles.map((file) => [file.targetPath, file]),
  );
  const configSource = readSourceFile(sourceByTarget, configInputTarget);
  const hooksSource = readSourceFile(sourceByTarget, hooksInputTarget);
  const renderedFiles = activeFiles.map((entry) =>
    renderSourceFile(entry, readSourceFile(sourceByTarget, entry.target)),
  );

  assertNoGeneratedTargetConflict(renderedFiles);
  assertHookDependencies(activeHooks, renderedFiles);
  const sourceConfig = parseConfig(configSource);
  const sourceHooks = parseHooks(hooksSource);
  assertSourceHooksMatch(sourceHooks, activeHooks);

  const filesWithoutDisabledInstructions =
    oracleEnabled || oracle === undefined
      ? renderedFiles
      : removeDisabledInstructionSections(renderedFiles, oracle);
  const generatedConfig = createGeneratedConfig(
    sourceConfig,
    manifest,
    filesWithoutDisabledInstructions,
  );
  const generatedHooks = createGeneratedHooks(activeHooks);
  const files = [
    ...filesWithoutDisabledInstructions,
    generatedConfig,
    generatedHooks,
  ].sort(compareTargets);

  assertFinalTargets(files);
  // The enabled root is scanned for as a literal of this run. Rendering is
  // what turns a source file into bundled bytes, so this is the last point at
  // which the operator's path can be caught before it is written out.
  validatePortableFiles(
    files,
    manifest,
    oracleEnabled && capabilities.oracle !== undefined
      ? [capabilities.oracle.llmWikiRoot]
      : [],
  );
  assertDisabledCapabilityTokens(
    files,
    manifest.capabilities,
    enabledCapabilities,
  );
  return { files, enabledCapabilities, disabledCapabilities };
}

function assertSupportedCapabilities(
  capabilities: readonly CapabilityDefinition[],
): void {
  if (capabilities.some((capability) => capability.name !== "oracle")) {
    throw new RenderError(
      "UNSUPPORTED_CAPABILITY",
      "Only the oracle capability is supported by this renderer.",
    );
  }
}

function assertCapabilityInputs(
  manifest: BundleManifest,
  capabilities: CapabilityInputs,
): void {
  if (
    !isObjectRecord(capabilities) ||
    !hasOnlyOwnKeys(capabilities, ["oracle"])
  ) {
    throw new RenderError(
      "CAPABILITY_INPUT_INVALID",
      "Capability inputs contain an unsupported value.",
    );
  }
  if (!Object.hasOwn(capabilities, "oracle")) {
    return;
  }
  if (
    !manifest.capabilities.some((capability) => capability.name === "oracle")
  ) {
    throw new RenderError(
      "CAPABILITY_INPUT_INVALID",
      "Oracle input was provided without an Oracle capability declaration.",
    );
  }
  const oracle = capabilities.oracle;
  if (
    !isObjectRecord(oracle) ||
    !hasOnlyOwnKeys(oracle, ["llmWikiRoot"]) ||
    !Object.hasOwn(oracle, "llmWikiRoot") ||
    typeof oracle.llmWikiRoot !== "string"
  ) {
    throw new RenderError(
      "CAPABILITY_INPUT_INVALID",
      "Oracle input must contain only llmWikiRoot.",
    );
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every(
    (key) => typeof key === "string" && allowedKeys.includes(key),
  );
}

async function resolveOracleCapability(
  oracle: CapabilityDefinition | undefined,
  capabilities: CapabilityInputs,
): Promise<boolean> {
  if (oracle === undefined || capabilities.oracle === undefined) {
    return false;
  }
  const root = capabilities.oracle.llmWikiRoot;
  if (!isAbsolute(root)) {
    throw new RenderError(
      "ORACLE_INPUT_INVALID",
      "Oracle llmWikiRoot must be an absolute readable directory.",
    );
  }
  try {
    const canonicalRoot = await realpath(root);
    const metadata = await stat(canonicalRoot);
    await access(canonicalRoot, fsConstants.R_OK);
    if (!metadata.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new RenderError(
      "ORACLE_INPUT_INVALID",
      "Oracle llmWikiRoot must be an absolute readable directory.",
    );
  }
  return true;
}

async function assertRequirements(
  requirements: readonly RequirementDefinition[],
  capability: "oracle" | undefined,
): Promise<void> {
  const selected = requirements.filter(
    (requirement) => requirement.capability === capability,
  );
  for (const requirement of selected) {
    try {
      const metadata = await stat(requirement.executable);
      await access(requirement.executable, fsConstants.X_OK);
      if (!metadata.isFile()) {
        throw new Error("not a file");
      }
      await execFile(requirement.executable, requirement.arguments, {
        shell: false,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch {
      throw new RenderError(
        capability === undefined
          ? "BASE_REQUIREMENT_UNAVAILABLE"
          : "CAPABILITY_REQUIREMENT_UNAVAILABLE",
        capability === undefined
          ? "A required base executable is unavailable."
          : "A required capability executable is unavailable.",
      );
    }
  }
}

function manifestForSourceResolution(
  manifest: BundleManifest,
  activeFiles: readonly BundleFileEntry[],
): BundleManifest {
  return {
    ...manifest,
    files: [
      ...activeFiles,
      {
        source: manifest.configSource,
        target: configInputTarget,
        mode: "0644",
        replacements: [],
      },
      {
        source: generatedHooksTarget,
        target: hooksInputTarget,
        mode: "0644",
        replacements: [],
      },
    ],
  };
}

function readSourceFile(
  sourceByTarget: ReadonlyMap<string, ResolvedSourceFile>,
  targetPath: string,
): ResolvedSourceFile {
  const source = sourceByTarget.get(targetPath);
  if (source === undefined) {
    throw new RenderError(
      "RENDERED_TARGET_CONFLICT",
      "A required rendering input is unavailable.",
    );
  }
  return source;
}

function renderSourceFile(
  entry: BundleFileEntry,
  source: ResolvedSourceFile,
): ResolvedSourceFile {
  let bytes = source.bytes;
  if (entry.replacements.length > 0) {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RenderError(
        "REPLACEMENT_INPUT_INVALID",
        `Replacement input for ${entry.target} is not UTF-8.`,
      );
    }
    for (const replacement of entry.replacements) {
      const matches = countLiteralMatches(content, replacement.search);
      if (matches !== replacement.expectedMatches) {
        throw new RenderError(
          "REPLACEMENT_COUNT_MISMATCH",
          `Replacement count did not match for ${entry.target}.`,
        );
      }
      content = content.replaceAll(replacement.search, replacement.replacement);
    }
    bytes = new TextEncoder().encode(content);
  }
  return source.capability === undefined
    ? { ...source, targetPath: entry.target, mode: fileMode(entry), bytes }
    : {
        ...source,
        targetPath: entry.target,
        mode: fileMode(entry),
        bytes,
        capability: source.capability,
      };
}

function countLiteralMatches(content: string, search: string): number {
  let count = 0;
  let position = 0;
  while (true) {
    const next = content.indexOf(search, position);
    if (next === -1) {
      return count;
    }
    count += 1;
    position = next + search.length;
  }
}

function fileMode(entry: BundleFileEntry): 0o644 | 0o755 {
  return entry.mode === "0644" ? 0o644 : 0o755;
}

function assertNoGeneratedTargetConflict(
  files: readonly ResolvedSourceFile[],
): void {
  const reservedTargets = new Set(
    [generatedConfigTarget, generatedHooksTarget].map(targetIdentity),
  );
  if (
    files.some((file) => reservedTargets.has(targetIdentity(file.targetPath)))
  ) {
    throw new RenderError(
      "RENDERED_TARGET_CONFLICT",
      "Generated config or hooks would conflict with a rendered source file.",
    );
  }
}

function assertFinalTargets(files: readonly ResolvedSourceFile[]): void {
  const targets = new Set<string>();
  for (const file of files) {
    const identity = targetIdentity(file.targetPath);
    if (targets.has(identity)) {
      throw new RenderError(
        "RENDERED_TARGET_CONFLICT",
        "Rendered files contain a duplicate or case-colliding target.",
      );
    }
    targets.add(identity);
  }
}

function targetIdentity(targetPath: string): string {
  return targetPath.normalize("NFC").toLowerCase();
}

function assertHookCommands(hooks: readonly HookSelection[]): void {
  for (const hook of hooks) {
    const expected = `bash "\${CODEX_HOME}/${hook.requiredScript}"`;
    if (hook.renderedCommand !== expected) {
      throw new RenderError(
        "HOOK_COMMAND_INVALID",
        "A rendered hook command is not an approved CODEX_HOME script invocation.",
      );
    }
  }
}

function assertUniqueHookSelections(hooks: readonly HookSelection[]): void {
  const sourceIdentities = new Set<string>();
  const emittedIdentities = new Set<string>();
  for (const hook of hooks) {
    const sourceIdentity = JSON.stringify([
      hook.event,
      hook.matcher,
      hook.sourceCommand,
      hook.timeout,
    ]);
    const emittedIdentity = JSON.stringify([
      hook.event,
      hook.matcher,
      hook.renderedCommand,
      hook.timeout,
    ]);
    if (
      sourceIdentities.has(sourceIdentity) ||
      emittedIdentities.has(emittedIdentity)
    ) {
      throw new RenderError(
        "HOOK_CARDINALITY_INVALID",
        "Selected hooks do not have one-to-one source and emitted identities.",
      );
    }
    sourceIdentities.add(sourceIdentity);
    emittedIdentities.add(emittedIdentity);
  }
}

function assertHookDependencies(
  hooks: readonly HookSelection[],
  files: readonly ResolvedSourceFile[],
): void {
  const filesByTarget = new Map(files.map((file) => [file.targetPath, file]));
  for (const hook of hooks) {
    const script = filesByTarget.get(hook.requiredScript);
    if (script === undefined || script.mode !== 0o755) {
      throw new RenderError(
        "HOOK_DEPENDENCY_MISSING",
        "A selected hook dependency is unavailable or not executable.",
      );
    }
  }
}

function parseConfig(source: ResolvedSourceFile): Record<string, unknown> {
  try {
    return readTable(parse(decode(source, "CONFIG_INVALID")), "CONFIG_INVALID");
  } catch (error) {
    if (error instanceof RenderError) {
      throw error;
    }
    throw new RenderError("CONFIG_INVALID", "Source config is not valid TOML.");
  }
}

function parseHooks(source: ResolvedSourceFile): Record<string, unknown> {
  try {
    return readTable(
      JSON.parse(decode(source, "HOOKS_INVALID")),
      "HOOKS_INVALID",
    );
  } catch (error) {
    if (error instanceof RenderError) {
      throw error;
    }
    throw new RenderError("HOOKS_INVALID", "Source hooks are not valid JSON.");
  }
}

function decode(source: ResolvedSourceFile, code: RenderErrorCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
  } catch {
    throw new RenderError(code, "A rendering input is not UTF-8.");
  }
}

function readTable(
  value: unknown,
  code: RenderErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RenderError(code, "A rendering input must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertSourceHooksMatch(
  source: Record<string, unknown>,
  hooks: readonly HookSelection[],
): void {
  const hooksByEvent = readTable(source.hooks, "HOOKS_INVALID");
  for (const selection of hooks) {
    const eventEntries = hooksByEvent[selection.event];
    const matchCount = Array.isArray(eventEntries)
      ? eventEntries.reduce(
          (count, entry) => count + countMatchingHooks(entry, selection),
          0,
        )
      : 0;
    if (matchCount !== 1) {
      throw new RenderError(
        "HOOK_CARDINALITY_INVALID",
        "A selected hook command does not have exactly one source match.",
      );
    }
  }
}

function countMatchingHooks(value: unknown, selection: HookSelection): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const group = value as Record<string, unknown>;
  if (group.matcher !== selection.matcher || !Array.isArray(group.hooks)) {
    return 0;
  }
  return group.hooks.reduce((count, hook) => {
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
      return count;
    }
    const command = hook as Record<string, unknown>;
    return command.type === "command" &&
      command.command === selection.sourceCommand &&
      command.timeout === selection.timeout
      ? count + 1
      : count;
  }, 0);
}

function removeDisabledInstructionSections(
  files: readonly ResolvedSourceFile[],
  capability: CapabilityDefinition,
): readonly ResolvedSourceFile[] {
  let remaining = [...files];
  for (const section of capability.instructionSections) {
    const heading = `^## ${escapeRegularExpression(section)}(?:\\r?\\n|$)`;
    const matches = remaining.reduce(
      (count, file) =>
        file.targetPath.endsWith(".md")
          ? count +
            [
              ...decode(file, "INSTRUCTION_SECTION_MISSING").matchAll(
                new RegExp(heading, "gmu"),
              ),
            ].length
          : count,
      0,
    );
    if (matches !== 1) {
      throw new RenderError(
        "INSTRUCTION_SECTION_CARDINALITY",
        "A declared capability instruction section must appear exactly once.",
      );
    }
    const expression = new RegExp(
      `${heading}[\\s\\S]*?(?=^## |(?![\\s\\S]))`,
      "mu",
    );
    remaining = remaining.map((file) =>
      file.targetPath.endsWith(".md")
        ? {
            ...file,
            bytes: new TextEncoder().encode(
              decode(file, "INSTRUCTION_SECTION_MISSING").replace(
                expression,
                "",
              ),
            ),
          }
        : file,
    );
  }
  return remaining;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertDisabledCapabilityTokens(
  files: readonly ResolvedSourceFile[],
  capabilities: readonly CapabilityDefinition[],
  enabledCapabilities: readonly string[],
): void {
  for (const capability of capabilities) {
    if (enabledCapabilities.includes(capability.name)) {
      continue;
    }
    for (const token of capability.requiredTokens) {
      const literal = `\${${token}}`;
      if (
        files.some((file) =>
          new TextDecoder().decode(file.bytes).includes(literal),
        )
      ) {
        throw new RenderError(
          "DISABLED_CAPABILITY_TOKEN",
          "A disabled capability token remains in rendered output.",
        );
      }
    }
  }
}

function createGeneratedConfig(
  source: Record<string, unknown>,
  manifest: BundleManifest,
  files: readonly ResolvedSourceFile[],
): ResolvedSourceFile {
  const projected: ConfigTable = {};
  for (const key of manifest.configKeys) {
    setConfigValue(projected, key, readConfigValue(source, key));
  }
  for (const [key, value] of Object.entries(manifest.configOverrides)) {
    setConfigValue(projected, key, value, true);
  }
  for (const agent of selectedAgents(files)) {
    setConfigValue(
      projected,
      `agents.${agent}.config_file`,
      `./agents/${agent}.toml`,
    );
  }
  return {
    sourcePath: "generated:config.toml",
    targetPath: generatedConfigTarget,
    mode: 0o600,
    bytes: new TextEncoder().encode(serializeToml(projected)),
  };
}

function readConfigValue(
  source: Record<string, unknown>,
  key: string,
): ConfigScalar {
  const segments = key.split(".");
  let value: unknown = source;
  for (const segment of segments) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new RenderError(
        "CONFIG_KEY_MISSING",
        `Required config key ${key} is missing.`,
      );
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new RenderError(
      "CONFIG_KEY_MISSING",
      `Required config key ${key} is missing.`,
    );
  }
  return value;
}

function setConfigValue(
  table: ConfigTable,
  key: string,
  value: ConfigScalar,
  allowExactOverwrite = false,
): void {
  const segments = key.split(".");
  const finalSegment = segments.pop();
  if (
    finalSegment === undefined ||
    finalSegment.length === 0 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new RenderError("CONFIG_INVALID", "Manifest config key is invalid.");
  }
  let current = table;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing === undefined) {
      const nested: ConfigTable = {};
      current[segment] = nested;
      current = nested;
    } else if (isConfigTable(existing)) {
      current = existing;
    } else {
      throw new RenderError(
        "CONFIG_INVALID",
        "Manifest config key conflicts with a scalar value.",
      );
    }
  }
  const existing = current[finalSegment];
  if (existing !== undefined) {
    if (isConfigTable(existing) || !allowExactOverwrite) {
      throw new RenderError(
        "CONFIG_INVALID",
        "Manifest config key conflicts with an existing value.",
      );
    }
  }
  current[finalSegment] = value;
}

function isConfigTable(
  value: ConfigScalar | ConfigTable,
): value is ConfigTable {
  return typeof value === "object" && value !== null;
}

function selectedAgents(
  files: readonly ResolvedSourceFile[],
): readonly string[] {
  return files
    .map((file) => /^agents\/([^/]+)\.toml$/u.exec(file.targetPath)?.[1])
    .filter((agent): agent is string => agent !== undefined)
    .sort(compareCodeUnits);
}

function serializeToml(table: ConfigTable): string {
  const sections: string[] = [];
  writeTomlTable(sections, table, []);
  return `${sections.join("\n\n")}\n`;
}

function writeTomlTable(
  sections: string[],
  table: ConfigTable,
  path: readonly string[],
): void {
  const entries = Object.entries(table).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  const scalars = entries.filter(([, value]) => !isConfigTable(value));
  if (path.length > 0 || scalars.length > 0) {
    const lines =
      path.length > 0 ? [`[${path.map(formatTomlKey).join(".")}]`] : [];
    lines.push(
      ...scalars.map(
        ([key, value]) =>
          `${formatTomlKey(key)} = ${formatTomlScalar(value as ConfigScalar)}`,
      ),
    );
    sections.push(lines.join("\n"));
  }
  for (const [key, value] of entries) {
    if (isConfigTable(value)) {
      writeTomlTable(sections, value, [...path, key]);
    }
  }
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

function formatTomlScalar(value: ConfigScalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function createGeneratedHooks(
  hooks: readonly HookSelection[],
): ResolvedSourceFile {
  const grouped = new Map<string, Map<string, HookSelection[]>>();
  for (const hook of hooks) {
    const byMatcher =
      grouped.get(hook.event) ?? new Map<string, HookSelection[]>();
    const group = byMatcher.get(hook.matcher) ?? [];
    group.push(hook);
    byMatcher.set(hook.matcher, group);
    grouped.set(hook.event, byMatcher);
  }
  const renderedHooks: Record<string, unknown> = {};
  for (const event of [...grouped.keys()].sort(compareCodeUnits)) {
    const byMatcher = grouped.get(event);
    if (byMatcher === undefined) {
      continue;
    }
    renderedHooks[event] = [...byMatcher.keys()]
      .sort(compareCodeUnits)
      .map((matcher) => ({
        matcher,
        hooks: [...(byMatcher.get(matcher) ?? [])]
          .sort((left, right) =>
            compareCodeUnits(left.renderedCommand, right.renderedCommand),
          )
          .map((hook) => ({
            type: "command",
            command: hook.renderedCommand,
            timeout: hook.timeout,
          })),
      }));
  }
  return {
    sourcePath: "generated:hooks.json",
    targetPath: generatedHooksTarget,
    mode: 0o644,
    bytes: new TextEncoder().encode(
      `${JSON.stringify({ hooks: renderedHooks }, null, 2)}\n`,
    ),
  };
}

function compareTargets(
  left: ResolvedSourceFile,
  right: ResolvedSourceFile,
): number {
  return compareCodeUnits(left.targetPath, right.targetPath);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
