import { parse } from "smol-toml";

export type FileMode = "0600" | "0644" | "0755";

export type CapabilityName = "oracle" | "shared-memory";

export type AllowedToken =
  | "HOME"
  | "CODEX_HOME"
  | "WORKSPACE_ROOT"
  | "LLM_WIKI_ROOT";

export interface ReplacementRule {
  readonly search: string;
  readonly replacement: string;
  readonly expectedMatches: number;
}

export interface BundleFileEntry {
  readonly source: string;
  readonly target: string;
  readonly mode: FileMode;
  readonly capability?: CapabilityName;
  readonly replacements: readonly ReplacementRule[];
}

export interface HookSelection {
  readonly event: string;
  readonly matcher: string;
  readonly sourceCommand: string;
  readonly renderedCommand: string;
  readonly timeout: number;
  readonly requiredScript: string;
  readonly capability?: CapabilityName;
}

export interface CapabilityDefinition {
  readonly name: CapabilityName;
  readonly requiredTokens: readonly string[];
  readonly readOnly: true;
  readonly instructionSections: readonly string[];
}

export interface RequirementDefinition {
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly capability?: CapabilityName;
}

export interface BundleManifest {
  readonly schemaVersion: 1;
  readonly configSource: string;
  readonly configKeys: readonly string[];
  readonly configOverrides: Readonly<Record<string, string | boolean | number>>;
  readonly allowedTokens: readonly AllowedToken[];
  readonly files: readonly BundleFileEntry[];
  readonly hooks: readonly HookSelection[];
  readonly capabilities: readonly CapabilityDefinition[];
  readonly requirements: readonly RequirementDefinition[];
  readonly forbiddenLiterals: readonly string[];
  readonly forbiddenPathSegments: readonly string[];
  readonly forbiddenPatternIds: readonly string[];
}

export type ManifestErrorCode =
  | "INVALID_TOML"
  | "UNKNOWN_KEY"
  | "MISSING_FIELD"
  | "INVALID_TYPE"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_PATH"
  | "DUPLICATE_TARGET"
  | "INVALID_MODE"
  | "INVALID_REPLACEMENT"
  | "INVALID_CAPABILITY"
  | "DUPLICATE_CAPABILITY"
  | "UNDECLARED_CAPABILITY"
  | "CAPABILITY_NOT_READ_ONLY"
  | "UNDECLARED_REQUIRED_SCRIPT"
  | "INVALID_ALLOWED_TOKEN"
  | "DUPLICATE_ALLOWED_TOKEN"
  | "INVALID_REQUIREMENT"
  | "DUPLICATE_REQUIREMENT"
  | "INVALID_PATTERN_ID"
  | "DUPLICATE_PATTERN_ID"
  | "INVALID_INSTRUCTION_SECTION"
  | "DUPLICATE_INSTRUCTION_SECTION"
  | "UNDECLARED_TOKEN";

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;

  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

type ManifestScalar = string | boolean | number;

export function parseBundleManifest(source: string): BundleManifest {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw error;
    }
    throw new ManifestError("INVALID_TOML", "Manifest is not valid TOML.");
  }

  const root = readTable(document, "manifest");
  assertKeys(root, "manifest", [
    "schema_version",
    "config_source",
    "config_keys",
    "config_overrides",
    "allowed_tokens",
    "files",
    "hooks",
    "capabilities",
    "requirements",
    "forbidden",
  ]);

  const schemaVersion = readSchemaVersion(root);
  const configSource = readPath(
    readString(root, "config_source", "manifest"),
    "config_source",
  );
  const configKeys = readStringArray(root, "config_keys", "manifest");
  const configOverrides = readConfigOverrides(
    readRequired(root, "config_overrides", "manifest"),
  );
  const allowedTokens = readAllowedTokens(root);
  const files = readFiles(readRequiredArray(root, "files", "manifest"));
  const capabilities = readCapabilities(
    readRequiredArray(root, "capabilities", "manifest"),
  );
  const hooks = readHooks(readRequiredArray(root, "hooks", "manifest"));
  const requirements = readRequirements(
    readRequiredArray(root, "requirements", "manifest"),
  );
  const forbidden = readForbidden(readRequired(root, "forbidden", "manifest"));

  const declaredCapabilities = new Set(
    capabilities.map((capability) => capability.name),
  );
  for (const capability of [...files, ...hooks, ...requirements].flatMap(
    (entry) => entry.capability ?? [],
  )) {
    if (!declaredCapabilities.has(capability)) {
      throw new ManifestError(
        "UNDECLARED_CAPABILITY",
        `Capability ${capability} is not declared.`,
      );
    }
  }

  const executableTargets = new Set(
    files.filter((file) => file.mode === "0755").map((file) => file.target),
  );
  for (const hook of hooks) {
    if (!executableTargets.has(hook.requiredScript)) {
      throw new ManifestError(
        "UNDECLARED_REQUIRED_SCRIPT",
        `Hook script ${hook.requiredScript} is not declared as an executable file.`,
      );
    }
  }

  const allowedTokenNames = new Set<string>(allowedTokens);
  for (const capability of capabilities) {
    for (const token of capability.requiredTokens) {
      if (!allowedTokenNames.has(token)) {
        throw new ManifestError(
          "UNDECLARED_TOKEN",
          `Capability ${capability.name} references undeclared token ${token}.`,
        );
      }
    }
  }

  return {
    schemaVersion,
    configSource,
    configKeys,
    configOverrides,
    allowedTokens,
    files: [...files].sort(compareFileTargets),
    hooks,
    capabilities: [...capabilities].sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    ),
    requirements,
    forbiddenLiterals: forbidden.literals,
    forbiddenPathSegments: forbidden.pathSegments,
    forbiddenPatternIds: forbidden.patternIds,
  };
}

function readSchemaVersion(table: Record<string, unknown>): 1 {
  const value = readRequired(table, "schema_version", "manifest");
  if (value !== 1) {
    throw new ManifestError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Only manifest schema version 1 is supported.",
    );
  }
  return 1;
}

function readConfigOverrides(
  value: unknown,
): Readonly<Record<string, ManifestScalar>> {
  const table = readTable(value, "config_overrides");
  const overrides: Record<string, ManifestScalar> = {};
  for (const [key, entry] of Object.entries(table)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "boolean" &&
      typeof entry !== "number"
    ) {
      throw new ManifestError(
        "INVALID_TYPE",
        `config_overrides.${key} must be a string, boolean, or number.`,
      );
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new ManifestError(
        "INVALID_TYPE",
        `config_overrides.${key} must be finite.`,
      );
    }
    Object.defineProperty(overrides, key, { enumerable: true, value: entry });
  }
  return overrides;
}

function readAllowedTokens(
  table: Record<string, unknown>,
): readonly AllowedToken[] {
  const tokens = readStringArray(table, "allowed_tokens", "manifest");
  const unique = new Set<AllowedToken>();
  for (const token of tokens) {
    const allowedToken = readAllowedToken(token);
    if (unique.has(allowedToken)) {
      throw new ManifestError(
        "DUPLICATE_ALLOWED_TOKEN",
        `Allowed token ${allowedToken} is declared more than once.`,
      );
    }
    unique.add(allowedToken);
  }
  return [...unique].sort(compareCodeUnits);
}

function readAllowedToken(value: string): AllowedToken {
  if (
    value === "HOME" ||
    value === "CODEX_HOME" ||
    value === "WORKSPACE_ROOT" ||
    value === "LLM_WIKI_ROOT"
  ) {
    return value;
  }
  throw new ManifestError(
    "INVALID_ALLOWED_TOKEN",
    `Unsupported allowed token: ${value}.`,
  );
}

function readFiles(values: readonly unknown[]): readonly BundleFileEntry[] {
  const targets = new Set<string>();
  return values.map((value, index) => {
    const table = readTable(value, `files[${index}]`);
    assertKeys(table, `files[${index}]`, [
      "source",
      "target",
      "mode",
      "capability",
      "replacements",
    ]);
    const source = readPath(
      readString(table, "source", `files[${index}]`),
      `files[${index}].source`,
    );
    const target = readPath(
      readString(table, "target", `files[${index}]`),
      `files[${index}].target`,
    );
    const mode = readMode(readString(table, "mode", `files[${index}]`));
    const capability = readOptionalCapability(table, `files[${index}]`);
    const replacements = readReplacements(
      readOptionalArray(table, "replacements", `files[${index}]`),
      index,
    );
    const normalizedTarget = normalizeTarget(target).toLowerCase();
    if (targets.has(normalizedTarget)) {
      throw new ManifestError(
        "DUPLICATE_TARGET",
        `Duplicate output target: ${target}.`,
      );
    }
    targets.add(normalizedTarget);

    return capability === undefined
      ? { source, target, mode, replacements }
      : { source, target, mode, capability, replacements };
  });
}

function readReplacements(
  values: readonly unknown[],
  fileIndex: number,
): readonly ReplacementRule[] {
  return values.map((value, index) => {
    const table = readTable(
      value,
      `files[${fileIndex}].replacements[${index}]`,
    );
    assertKeys(table, `files[${fileIndex}].replacements[${index}]`, [
      "search",
      "replacement",
      "expected_matches",
    ]);
    const search = readString(
      table,
      "search",
      `files[${fileIndex}].replacements[${index}]`,
    );
    if (search.length === 0) {
      throw new ManifestError(
        "INVALID_REPLACEMENT",
        "Replacement search must not be empty.",
      );
    }
    if (!hasOwn(table, "expected_matches")) {
      throw new ManifestError(
        "INVALID_REPLACEMENT",
        "Replacement expected_matches is required.",
      );
    }
    const expectedMatches = readNonNegativeSafeInteger(
      table,
      "expected_matches",
      `files[${fileIndex}].replacements[${index}]`,
      "INVALID_REPLACEMENT",
    );
    return {
      search,
      replacement: readString(
        table,
        "replacement",
        `files[${fileIndex}].replacements[${index}]`,
      ),
      expectedMatches,
    };
  });
}

function readHooks(values: readonly unknown[]): readonly HookSelection[] {
  return values.map((value, index) => {
    const table = readTable(value, `hooks[${index}]`);
    assertKeys(table, `hooks[${index}]`, [
      "event",
      "matcher",
      "source_command",
      "rendered_command",
      "timeout",
      "required_script",
      "capability",
    ]);
    const timeout = readNonNegativeSafeInteger(
      table,
      "timeout",
      `hooks[${index}]`,
      "INVALID_TYPE",
    );
    const capability = readOptionalCapability(table, `hooks[${index}]`);
    const hook = {
      event: readString(table, "event", `hooks[${index}]`),
      matcher: readString(table, "matcher", `hooks[${index}]`),
      sourceCommand: readString(table, "source_command", `hooks[${index}]`),
      renderedCommand: readString(table, "rendered_command", `hooks[${index}]`),
      timeout,
      requiredScript: readPath(
        readString(table, "required_script", `hooks[${index}]`),
        `hooks[${index}].required_script`,
      ),
    };
    return capability === undefined ? hook : { ...hook, capability };
  });
}

function readCapabilities(
  values: readonly unknown[],
): readonly CapabilityDefinition[] {
  const names = new Set<CapabilityName>();
  return values.map((value, index) => {
    const table = readTable(value, `capabilities[${index}]`);
    assertKeys(table, `capabilities[${index}]`, [
      "name",
      "required_tokens",
      "read_only",
      "instruction_sections",
    ]);
    const name = readCapability(
      readString(table, "name", `capabilities[${index}]`),
      `capabilities[${index}].name`,
    );
    if (names.has(name)) {
      throw new ManifestError(
        "DUPLICATE_CAPABILITY",
        `Capability ${name} is declared more than once.`,
      );
    }
    names.add(name);
    if (readRequired(table, "read_only", `capabilities[${index}]`) !== true) {
      throw new ManifestError(
        "CAPABILITY_NOT_READ_ONLY",
        `Capability ${name} must be read-only.`,
      );
    }
    return {
      name,
      requiredTokens: [
        ...readStringArray(table, "required_tokens", `capabilities[${index}]`),
      ].sort(compareCodeUnits),
      readOnly: true,
      instructionSections: readInstructionSections(table, index),
    };
  });
}

function readRequirements(
  values: readonly unknown[],
): readonly RequirementDefinition[] {
  const names = new Set<string>();
  const requirements = values.map((value, index) => {
    const table = readTable(value, `requirements[${index}]`);
    assertKeys(table, `requirements[${index}]`, [
      "name",
      "executable",
      "arguments",
      "capability",
    ]);
    const name = readString(table, "name", `requirements[${index}]`);
    if (name.length === 0) {
      throw new ManifestError(
        "INVALID_REQUIREMENT",
        `requirements[${index}].name must not be empty.`,
      );
    }
    if (names.has(name)) {
      throw new ManifestError(
        "DUPLICATE_REQUIREMENT",
        `Requirement ${name} is declared more than once.`,
      );
    }
    names.add(name);
    const executable = readExecutable(
      readString(table, "executable", `requirements[${index}]`),
      index,
    );
    const arguments_ = readStringArray(
      table,
      "arguments",
      `requirements[${index}]`,
    );
    const capability = readOptionalCapability(table, `requirements[${index}]`);
    return capability === undefined
      ? { name, executable, arguments: arguments_ }
      : { name, executable, arguments: arguments_, capability };
  });
  return requirements.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  );
}

function readExecutable(value: string, index: number): string {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.includes("\\") ||
    /[*?\[\]{}]/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value
      .slice(1)
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new ManifestError(
      "INVALID_REQUIREMENT",
      `requirements[${index}].executable must be an absolute POSIX path.`,
    );
  }
  return value;
}

function readInstructionSections(
  table: Record<string, unknown>,
  capabilityIndex: number,
): readonly string[] {
  const sections = readStringArray(
    table,
    "instruction_sections",
    `capabilities[${capabilityIndex}]`,
  );
  const unique = new Set<string>();
  for (const section of sections) {
    if (
      section.trim().length === 0 ||
      section.includes("#") ||
      section.includes("\n") ||
      section.includes("\r") ||
      section.includes("\u0000")
    ) {
      throw new ManifestError(
        "INVALID_INSTRUCTION_SECTION",
        `capabilities[${capabilityIndex}].instruction_sections contains an invalid heading.`,
      );
    }
    if (unique.has(section)) {
      throw new ManifestError(
        "DUPLICATE_INSTRUCTION_SECTION",
        `Instruction section ${section} is declared more than once.`,
      );
    }
    unique.add(section);
  }
  return [...unique].sort(compareCodeUnits);
}

function readForbidden(value: unknown): {
  readonly literals: readonly string[];
  readonly pathSegments: readonly string[];
  readonly patternIds: readonly string[];
} {
  const table = readTable(value, "forbidden");
  assertKeys(table, "forbidden", ["literals", "path_segments", "pattern_ids"]);
  return {
    literals: readStringArray(table, "literals", "forbidden"),
    pathSegments: readStringArray(table, "path_segments", "forbidden"),
    patternIds: readPatternIds(table),
  };
}

function readPatternIds(table: Record<string, unknown>): readonly string[] {
  const ids = readStringArray(table, "pattern_ids", "forbidden");
  const unique = new Set<string>();
  for (const id of ids) {
    if (
      id !== "private-key" &&
      id !== "credential-assignment" &&
      id !== "github-token" &&
      id !== "openai-api-key"
    ) {
      throw new ManifestError(
        "INVALID_PATTERN_ID",
        `Unsupported pattern ID: ${id}.`,
      );
    }
    if (unique.has(id)) {
      throw new ManifestError(
        "DUPLICATE_PATTERN_ID",
        `Pattern ID ${id} is declared more than once.`,
      );
    }
    unique.add(id);
  }
  return [...unique].sort(compareCodeUnits);
}

// A manifest cannot declare 0600. Only the rendered config takes it, because
// Codex rewrites that file owner-only itself; bundled sources stay on the two
// modes the manifest has always allowed.
function readMode(value: string): FileMode {
  if (value === "0644" || value === "0755") {
    return value;
  }
  throw new ManifestError("INVALID_MODE", `Unsupported file mode: ${value}.`);
}

function readOptionalCapability(
  table: Record<string, unknown>,
  location: string,
): CapabilityName | undefined {
  if (!hasOwn(table, "capability")) {
    return undefined;
  }
  return readCapability(
    readString(table, "capability", location),
    `${location}.capability`,
  );
}

function readCapability(value: string, location: string): CapabilityName {
  if (value === "oracle" || value === "shared-memory") {
    return value;
  }
  throw new ManifestError(
    "INVALID_CAPABILITY",
    `${location} has an unsupported capability.`,
  );
}

function readStringArray(
  table: Record<string, unknown>,
  key: string,
  location: string,
): readonly string[] {
  const values = readRequired(table, key, location);
  if (!Array.isArray(values)) {
    throw new ManifestError(
      "INVALID_TYPE",
      `${location}.${key} must be an array of strings.`,
    );
  }
  return values.map((value) => {
    if (typeof value !== "string") {
      throw new ManifestError(
        "INVALID_TYPE",
        `${location}.${key} must be an array of strings.`,
      );
    }
    return value;
  });
}

function readOptionalArray(
  table: Record<string, unknown>,
  key: string,
  location: string,
): readonly unknown[] {
  if (!hasOwn(table, key)) {
    return [];
  }
  const value = table[key];
  if (!Array.isArray(value)) {
    throw new ManifestError(
      "INVALID_TYPE",
      `${location}.${key} must be an array.`,
    );
  }
  return value;
}

function readRequiredArray(
  table: Record<string, unknown>,
  key: string,
  location: string,
): readonly unknown[] {
  const value = readRequired(table, key, location);
  if (!Array.isArray(value)) {
    throw new ManifestError(
      "INVALID_TYPE",
      `${location}.${key} must be an array.`,
    );
  }
  return value;
}

function readString(
  table: Record<string, unknown>,
  key: string,
  location: string,
): string {
  const value = readRequired(table, key, location);
  if (typeof value !== "string") {
    throw new ManifestError(
      "INVALID_TYPE",
      `${location}.${key} must be a string.`,
    );
  }
  return value;
}

function readNonNegativeSafeInteger(
  table: Record<string, unknown>,
  key: string,
  location: string,
  code: "INVALID_REPLACEMENT" | "INVALID_TYPE",
): number {
  const value = readRequired(table, key, location);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ManifestError(
      code,
      `${location}.${key} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function readPath(value: string, location: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    /[*?\[\]{}]/u.test(value) ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new ManifestError(
      "INVALID_PATH",
      `${location} must be a POSIX relative path.`,
    );
  }
  return value;
}

function compareFileTargets(
  left: BundleFileEntry,
  right: BundleFileEntry,
): number {
  const normalized = compareCodeUnits(
    normalizeTarget(left.target),
    normalizeTarget(right.target),
  );
  return normalized === 0
    ? compareCodeUnits(left.target, right.target)
    : normalized;
}

function normalizeTarget(target: string): string {
  return target.normalize("NFC");
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function readRequired(
  table: Record<string, unknown>,
  key: string,
  location: string,
): unknown {
  if (!hasOwn(table, key)) {
    throw new ManifestError("MISSING_FIELD", `${location}.${key} is required.`);
  }
  return table[key];
}

function readTable(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(
      "INVALID_TYPE",
      `${location} must be a TOML table.`,
    );
  }
  const table: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    table[key] = entry;
  }
  return table;
}

function assertKeys(
  table: Record<string, unknown>,
  location: string,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(table)) {
    if (!allowedKeys.has(key)) {
      throw new ManifestError(
        "UNKNOWN_KEY",
        `${location}.${key} is not allowed.`,
      );
    }
  }
}

function hasOwn(table: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(table, key);
}
