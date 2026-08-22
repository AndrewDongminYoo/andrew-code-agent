/// <reference types="node" />

import { constants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface RuntimePaths {
  readonly sourceRoot: string;
  readonly stateRoot: string;
  readonly codexHome: string;
  readonly codexBin: string;
}

export type RuntimePathErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "RUNTIME_PATH_INVALID"
  | "RUNTIME_PATH_OVERLAP"
  | "CODEX_BINARY_NOT_FOUND"
  | "RUNTIME_STATE_UNSAFE";

export class RuntimePathError extends Error {
  readonly code: RuntimePathErrorCode;

  constructor(code: RuntimePathErrorCode, message: string) {
    super(message);
    this.name = "RuntimePathError";
    this.code = code;
  }
}

export interface RuntimePathResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export async function resolveRuntimePaths(
  options: RuntimePathResolutionOptions = {},
): Promise<RuntimePaths> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new RuntimePathError(
      "UNSUPPORTED_PLATFORM",
      "andrew-code-agent runtime state is supported only on macOS.",
    );
  }

  const env = options.env ?? process.env;
  const home = requireAbsolute(env.HOME, "HOME");
  const sourceInput = env.ANDREW_AGENT_CODEX_SOURCE ?? join(home, ".codex");
  const stateInput =
    env.ANDREW_AGENT_STATE_ROOT ??
    join(home, "Library", "Application Support", "andrew-code-agent");
  requireAbsolute(sourceInput, "ANDREW_AGENT_CODEX_SOURCE");
  requireAbsolute(stateInput, "ANDREW_AGENT_STATE_ROOT");

  const sourceRoot = await canonicalExistingDirectory(sourceInput);
  const stateRoot = await canonicalPotentialPath(stateInput);
  assertSeparated(sourceRoot, stateRoot);
  const codexBin = await resolveCodexBinary(env);

  return {
    sourceRoot,
    stateRoot,
    codexHome: join(stateRoot, "codex-home"),
    codexBin,
  };
}

export async function initializeRuntimeState(
  paths: RuntimePaths,
): Promise<void> {
  if (!isAbsolute(paths.sourceRoot) || !isAbsolute(paths.stateRoot)) {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      "Runtime state paths must be absolute.",
    );
  }
  if (paths.codexHome !== join(paths.stateRoot, "codex-home")) {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      "Codex home is not the expected runtime state child.",
    );
  }
  await rejectDirectSymlink(paths.stateRoot);
  await rejectDirectSymlink(paths.codexHome);
  const sourceRoot = await canonicalExistingDirectory(paths.sourceRoot);
  const stateRoot = await canonicalPotentialPath(paths.stateRoot);
  if (sourceRoot !== paths.sourceRoot || stateRoot !== paths.stateRoot) {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      "Runtime paths must use their canonical absolute form.",
    );
  }
  assertSeparated(sourceRoot, stateRoot, "RUNTIME_STATE_UNSAFE");
  await revalidateCodexBinary(paths.codexBin);

  await ensureOwnerDirectory(stateRoot);
  await ensureOwnerDirectory(join(stateRoot, "codex-home"));
  await ensureOwnerDirectory(join(stateRoot, "threads"));
}

async function revalidateCodexBinary(codexBin: string): Promise<void> {
  if (!isAbsolute(codexBin)) {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      "Codex binary path must be absolute.",
    );
  }
  try {
    const canonical = await realpath(codexBin);
    const metadata = await lstat(canonical);
    await access(canonical, constants.X_OK);
    if (canonical !== codexBin || !metadata.isFile())
      throw new Error("unsafe binary");
  } catch {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      "Codex binary is not a canonical executable regular file.",
    );
  }
}

async function rejectDirectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new RuntimePathError(
        "RUNTIME_STATE_UNSAFE",
        `Runtime state path must not be a symbolic link: ${path}`,
      );
    }
  } catch (error) {
    if (error instanceof RuntimePathError) throw error;
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new RuntimePathError(
        "RUNTIME_STATE_UNSAFE",
        `Unable to inspect runtime state path: ${path}`,
      );
    }
  }
}

function requireAbsolute(value: string | undefined, name: string): string {
  if (value === undefined || !isAbsolute(value)) {
    throw new RuntimePathError(
      "RUNTIME_PATH_INVALID",
      `${name} must be an absolute path.`,
    );
  }
  return resolve(value);
}

async function canonicalExistingDirectory(input: string): Promise<string> {
  try {
    const canonical = await realpath(input);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new RuntimePathError(
      "RUNTIME_PATH_INVALID",
      `Runtime directory does not exist or is unsafe: ${input}`,
    );
  }
}

async function canonicalPotentialPath(input: string): Promise<string> {
  const absolute = resolve(input);
  let ancestor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return join(canonicalAncestor, ...suffix.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new RuntimePathError(
          "RUNTIME_PATH_INVALID",
          `Runtime path cannot be canonicalized: ${input}`,
        );
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new RuntimePathError(
          "RUNTIME_PATH_INVALID",
          `Runtime path cannot be canonicalized: ${input}`,
        );
      }
      suffix.push(
        ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
      );
      ancestor = parent;
    }
  }
}

function assertSeparated(
  sourceRoot: string,
  stateRoot: string,
  code: RuntimePathErrorCode = "RUNTIME_PATH_OVERLAP",
): void {
  if (contains(sourceRoot, stateRoot) || contains(stateRoot, sourceRoot)) {
    throw new RuntimePathError(
      code,
      "Source and state roots must not overlap.",
    );
  }
}

function contains(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

async function resolveCodexBinary(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.ANDREW_AGENT_CODEX_BIN;
  const candidates =
    override === undefined
      ? (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((entry) => join(entry, "codex"))
      : [requireAbsolute(override, "ANDREW_AGENT_CODEX_BIN")];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await lstat(canonical);
      await access(canonical, constants.X_OK);
      if (metadata.isFile()) return canonical;
    } catch {
      // Continue through PATH candidates.
    }
  }
  throw new RuntimePathError(
    "CODEX_BINARY_NOT_FOUND",
    "An executable codex binary was not found.",
  );
}

async function ensureOwnerDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new RuntimePathError(
        "RUNTIME_STATE_UNSAFE",
        `Unable to create runtime directory: ${path}`,
      );
    }
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      `Unable to inspect runtime directory: ${path}`,
    );
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new RuntimePathError(
      "RUNTIME_STATE_UNSAFE",
      `Runtime directory is not an owner-only ordinary directory: ${path}`,
    );
  }
}

function currentUid(): number {
  return process.getuid?.() ?? -1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
