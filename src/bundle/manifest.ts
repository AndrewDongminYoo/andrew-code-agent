import { parse } from "smol-toml";

export type FileMode = "0644" | "0755";

export type CapabilityName = "oracle" | "shared-memory";

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
}

export interface BundleManifest {
  readonly schemaVersion: 1;
  readonly configSource: string;
  readonly configKeys: readonly string[];
  readonly configOverrides: Readonly<Record<string, string | boolean | number>>;
  readonly files: readonly BundleFileEntry[];
  readonly hooks: readonly HookSelection[];
  readonly capabilities: readonly CapabilityDefinition[];
  readonly forbiddenLiterals: readonly string[];
  readonly forbiddenPathSegments: readonly string[];
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
  | "UNDECLARED_REQUIRED_SCRIPT";

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
    "files",
    "hooks",
    "capabilities",
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
  const files = readFiles(readOptionalArray(root, "files", "manifest"));
  const capabilities = readCapabilities(
    readOptionalArray(root, "capabilities", "manifest"),
  );
  const hooks = readHooks(readOptionalArray(root, "hooks", "manifest"));
  const forbidden = readForbidden(readRequired(root, "forbidden", "manifest"));

  const declaredCapabilities = new Set(
    capabilities.map((capability) => capability.name),
  );
  for (const capability of [...files, ...hooks].flatMap(
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

  return {
    schemaVersion,
    configSource,
    configKeys,
    configOverrides,
    files: [...files].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
    hooks,
    capabilities: [...capabilities].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    forbiddenLiterals: forbidden.literals,
    forbiddenPathSegments: forbidden.pathSegments,
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
    const normalizedTarget = target.normalize("NFC").toLocaleLowerCase("en-US");
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
      requiredTokens: readStringArray(
        table,
        "required_tokens",
        `capabilities[${index}]`,
      ),
      readOnly: true,
    };
  });
}

function readForbidden(value: unknown): {
  readonly literals: readonly string[];
  readonly pathSegments: readonly string[];
} {
  const table = readTable(value, "forbidden");
  assertKeys(table, "forbidden", ["literals", "path_segments"]);
  return {
    literals: readStringArray(table, "literals", "forbidden"),
    pathSegments: readStringArray(table, "path_segments", "forbidden"),
  };
}

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
