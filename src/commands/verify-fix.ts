/// <reference types="node" />

import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import {
  access,
  constants as fsConstants,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { escapeTerminalControls } from "../app-server/terminal.js";
import { executeGit } from "../git/process.js";
import {
  assertCleanGitSnapshot,
  GitRuntimeError,
  readGitSnapshot,
} from "../runtime/git.js";
import { createReviewCheckout } from "./review.js";
import { writeLine, type CommandIO } from "./run.js";

const execFile = promisify(execFileCallback);

export const RUN_TIMEOUT_MS = 600_000;
export const RUN_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
export const CLEANUP_WARNING =
  "Temporary verification checkout cleanup failed.";
const PROBE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const TAIL_BYTES = 2048;
const DEFAULT_BASE_SYMBOLIC_REF = "refs/remotes/origin/HEAD";
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec"]);
const TEST_NAME_MARKERS = [".test.", ".spec.", "_test."];
// `sandbox-exec` exits 71 and prints this prefix when it cannot exec the
// command, so that case is not mistaken for a failing test run.
const SANDBOX_EXEC_FAILURE_PREFIX = "sandbox-exec: execvp() of ";
const SANDBOX_EXEC_FAILURE_CODE = 71;

// Paths reach the profile only through `-D` parameters, never by
// interpolation, so a quote in a path cannot change the profile. Reads of the
// source worktree are denied so that no symbolic link, at any depth of a
// `--with` clone, can show a run the source worktree's files.
export const SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  '(deny file-read* (subpath (param "SOURCE")))',
  "(deny file-write*)",
  '(allow file-write* (subpath (param "CHECKOUT")) (subpath (param "TMPDIR")) (literal "/dev/null"))',
].join("\n");
const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

class VerifyFixError extends Error {}

export interface VerifyFixOptions {
  readonly baseInput?: string;
  readonly withPaths: readonly string[];
  readonly testPaths: readonly string[];
  readonly command: readonly string[];
}

export interface VerifyFixDependencies {
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly sandboxExecutable: string;
}

const defaultDependencies: VerifyFixDependencies = {
  timeoutMs: RUN_TIMEOUT_MS,
  outputLimitBytes: RUN_OUTPUT_LIMIT_BYTES,
  sandboxExecutable: SANDBOX_EXECUTABLE,
};

export interface VerifyFixInput {
  readonly repositoryRoot: string;
  readonly baseRef: string;
  readonly base: string;
  readonly mergeBase: string;
  readonly headRef: string;
  readonly head: string;
  readonly testPaths: readonly string[];
  readonly productionPaths: readonly string[];
}

export type RunOutcome =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "output-limit" }
  | { readonly kind: "not-started" }
  | { readonly kind: "interrupted" };

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly tail: string;
}

interface PreparedRun {
  readonly label: string;
  readonly source: string;
  readonly checkout: string;
  readonly temporaryDirectory: string;
}

interface PreparedCheckouts {
  readonly root: string;
  readonly withoutFix: PreparedRun;
  readonly withFix: PreparedRun;
}

export async function verifyFixCommand(
  repositoryInput: string,
  options: VerifyFixOptions,
  io: CommandIO,
  dependencies: VerifyFixDependencies = defaultDependencies,
): Promise<number> {
  let input: VerifyFixInput;
  let withPaths: string[];
  try {
    if (options.command.length === 0 || options.command[0] === "")
      throw new VerifyFixError("A test command is required after --.");
    const testSelectors = options.testPaths.map(normalizeTestSelector);
    input = await readVerifyFixInput(
      repositoryInput,
      options.baseInput,
      testSelectors,
    );
    if (input.testPaths.length === 0)
      throw new VerifyFixError(
        "No changed test files; name them with --test or add a test.",
      );
    if (input.productionPaths.length === 0)
      throw new VerifyFixError(
        "No changed production files; there is no fix to verify.",
      );
    withPaths = await validateWithPaths(
      input.repositoryRoot,
      options.withPaths,
    );
  } catch (error) {
    await writeLine(io.stderr, preflightMessage(error));
    return 3;
  }

  // One listener per signal spans preparation, both runs, and cleanup, so an
  // interrupt, a termination, or a hangup at any point starts no further run
  // and still removes the checkouts.
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  let withoutFix: RunResult | undefined;
  let withFix: RunResult | undefined;
  let preparationFailure: string | undefined;
  let refusal: string | undefined;
  let cleanupFailed = false;
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onInterrupt);
  try {
    let prepared: PreparedCheckouts | undefined;
    try {
      prepared = await prepareCheckouts(input, withPaths);
    } catch (error) {
      cleanupFailed = error instanceof CleanupFailure;
      const cause = error instanceof CleanupFailure ? error.cause : error;
      preparationFailure =
        cause instanceof VerifyFixError
          ? escapeTerminalControls(cause.message)
          : "Unable to prepare the verification checkouts.";
    }
    if (prepared !== undefined) {
      try {
        if (!interrupted)
          refusal = await sandboxRefusal(dependencies, prepared.withoutFix);
        if (!interrupted && refusal === undefined)
          withoutFix = await runSandboxed(
            dependencies,
            prepared.withoutFix,
            options.command,
          );
        if (!interrupted && withoutFix !== undefined)
          withFix = await runSandboxed(
            dependencies,
            prepared.withFix,
            options.command,
          );
      } finally {
        try {
          await rm(prepared.root, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
    }
  } finally {
    for (const signal of INTERRUPT_SIGNALS) process.off(signal, onInterrupt);
  }

  try {
    if (interrupted) {
      await writeLine(
        io.stderr,
        "Verification interrupted; no verdict was reported.",
      );
      return 1;
    }
    if (preparationFailure !== undefined) {
      await writeLine(io.stderr, preparationFailure);
      return 3;
    }
    if (refusal !== undefined) {
      await writeLine(io.stderr, refusal);
      return 3;
    }
    let current: VerifyFixInput;
    try {
      current = await readVerifyFixInput(
        repositoryInput,
        options.baseInput,
        options.testPaths.map(normalizeTestSelector),
      );
    } catch {
      current = { ...input, head: "" };
    }
    if (verifyFixIdentity(current) !== verifyFixIdentity(input)) {
      await writeLine(
        io.stderr,
        "Verification inputs changed; run verify-fix again.",
      );
      return 3;
    }
    return await report(io, dependencies, input, withoutFix!, withFix!);
  } finally {
    if (cleanupFailed) await writeLine(io.stderr, CLEANUP_WARNING);
  }
}

async function report(
  io: CommandIO,
  dependencies: VerifyFixDependencies,
  input: VerifyFixInput,
  withoutFix: RunResult,
  withFix: RunResult,
): Promise<number> {
  await writeLine(
    io.stdout,
    `Verifying ${input.headRef} (${input.head}) against ${input.baseRef} (${input.base}).`,
  );
  await writeLine(io.stdout, `Merge base: ${input.mergeBase}.`);
  await writeLine(
    io.stdout,
    `Test paths: ${input.testPaths.length}. Production paths: ${input.productionPaths.length}.`,
  );
  for (const [label, result] of [
    ["Run A (production paths at the merge base)", withoutFix],
    ["Run B (HEAD)", withFix],
  ] as const) {
    await writeLine(
      io.stdout,
      `${label}: ${describeOutcome(result.outcome, dependencies)}.`,
    );
    for (const line of tailLines(result.tail))
      await writeLine(io.stdout, `  | ${line}`);
  }
  const verdict = judge(withoutFix.outcome, withFix.outcome, dependencies);
  for (const line of verdict.lines) await writeLine(io.stdout, line);
  return verdict.code;
}

export function judge(
  withoutFix: RunOutcome,
  withFix: RunOutcome,
  dependencies: Pick<VerifyFixDependencies, "timeoutMs" | "outputLimitBytes">,
): { code: 0 | 1; lines: string[] } {
  const failedWithoutFix =
    withoutFix.kind === "exited" && withoutFix.code !== 0;
  const passedWithFix = withFix.kind === "exited" && withFix.code === 0;
  if (failedWithoutFix && passedWithFix)
    return {
      code: 0,
      lines: ["Verified: the tests fail without the fix and pass with it."],
    };
  const lines = ["Not verified."];
  if (!failedWithoutFix)
    lines.push(
      withoutFix.kind === "exited"
        ? "Expected run A to fail without the fix, but it passed."
        : `Expected run A to fail without the fix, but it ${describeOutcome(withoutFix, dependencies)}.`,
    );
  if (!passedWithFix)
    lines.push(
      withFix.kind === "exited"
        ? `Expected run B to pass with the fix, but it failed with exit ${withFix.code}.`
        : `Expected run B to pass with the fix, but it ${describeOutcome(withFix, dependencies)}.`,
    );
  return { code: 1, lines };
}

function describeOutcome(
  outcome: RunOutcome,
  dependencies: Pick<VerifyFixDependencies, "timeoutMs" | "outputLimitBytes">,
): string {
  switch (outcome.kind) {
    case "exited":
      return `exit ${outcome.code}`;
    case "signaled":
      return `was terminated by ${outcome.signal}`;
    case "timed-out":
      return `timed out after ${dependencies.timeoutMs / 1000} seconds`;
    case "output-limit":
      return `exceeded the output limit of ${dependencies.outputLimitBytes} bytes`;
    case "not-started":
      return "could not start the command";
    case "interrupted":
      return "was interrupted";
  }
}

function tailLines(tail: string): string[] {
  if (tail === "") return [];
  const lines = tail.replace(/\n$/, "").split("\n");
  return lines.map((line) => escapeTerminalControls(line));
}

export async function readVerifyFixInput(
  repositoryInput: string,
  baseInput: string | undefined,
  testSelectors: readonly string[],
): Promise<VerifyFixInput> {
  const snapshot = await assertCleanGitSnapshot(
    await readGitSnapshot(repositoryInput),
  );
  const repositoryRoot = snapshot.repositoryRoot;
  const head = snapshot.head;
  const headRef = await readHeadRef(repositoryRoot);
  const baseRef = await resolveBaseRef(repositoryRoot, baseInput);
  const base = await resolveCommit(repositoryRoot, baseRef);
  const mergeBase = await readMergeBase(repositoryRoot, base, head);
  const changed = await readChangedPaths(repositoryRoot, mergeBase, head);
  const { testPaths, productionPaths } = classifyChangedPaths(
    changed,
    testSelectors,
  );

  const finalSnapshot = await assertCleanGitSnapshot(
    await readGitSnapshot(repositoryRoot),
  );
  const finalHeadRef = await readHeadRef(repositoryRoot);
  const finalBaseRef = await resolveBaseRef(repositoryRoot, baseInput);
  const finalBase = await resolveCommit(repositoryRoot, finalBaseRef);
  if (
    finalSnapshot.head !== head ||
    finalHeadRef !== headRef ||
    finalBaseRef !== baseRef ||
    finalBase !== base
  )
    throw new VerifyFixError(
      "Git comparison changed while it was read; retry.",
    );
  return {
    repositoryRoot,
    baseRef,
    base,
    mergeBase,
    headRef,
    head,
    testPaths,
    productionPaths,
  };
}

function verifyFixIdentity(input: VerifyFixInput): string {
  return JSON.stringify(input);
}

// With no selectors, a path is a test path when a directory above it is a
// conventional test directory or its file name carries a test marker. Any
// selector replaces those defaults: a path is a test path only when it equals
// a selector or lies under one.
export function classifyChangedPaths(
  paths: readonly string[],
  testSelectors: readonly string[],
): { testPaths: string[]; productionPaths: string[] } {
  const testPaths: string[] = [];
  const productionPaths: string[] = [];
  for (const path of paths) {
    const isTest =
      testSelectors.length === 0
        ? isDefaultTestPath(path)
        : testSelectors.some(
            (selector) => path === selector || path.startsWith(`${selector}/`),
          );
    (isTest ? testPaths : productionPaths).push(path);
  }
  return { testPaths, productionPaths };
}

export function isDefaultTestPath(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment)) ||
    TEST_NAME_MARKERS.some((marker) => name.includes(marker))
  );
}

function normalizeTestSelector(selector: string): string {
  const normalized = normalizeRelativePath(selector);
  if (normalized === undefined)
    throw new VerifyFixError(
      "A --test path must be a relative repository path without '..'.",
    );
  return normalized;
}

// Returns the path without a leading `./` or trailing slashes, or undefined
// when it is empty, absolute, the repository root, or has a `..` segment.
function normalizeRelativePath(value: string): string | undefined {
  if (value === "" || isAbsolute(value)) return undefined;
  if (value.split("/").some((segment) => segment === "..")) return undefined;
  const normalized = posix.normalize(value).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return undefined;
  return normalized;
}

async function validateWithPaths(
  repositoryRoot: string,
  values: readonly string[],
): Promise<string[]> {
  const accepted: string[] = [];
  for (const value of values) {
    const path = normalizeRelativePath(value);
    if (path === undefined)
      throw new VerifyFixError(
        "A --with path must be a relative path inside the worktree without '..'.",
      );
    if (path.split("/").some((segment) => isGitDirectoryName(segment)))
      throw new VerifyFixError("A --with path cannot name a .git directory.");
    let resolved: string;
    try {
      await lstat(join(repositoryRoot, path));
      resolved = await realpath(join(repositoryRoot, path));
    } catch {
      throw new VerifyFixError(`A --with path does not exist: ${path}.`);
    }
    if (!resolved.startsWith(`${repositoryRoot}${sep}`))
      throw new VerifyFixError(
        `A --with path resolves outside the worktree: ${path}.`,
      );
    const resolvedSegments = resolved
      .slice(repositoryRoot.length + 1)
      .split(sep);
    if (resolvedSegments.some((segment) => isGitDirectoryName(segment)))
      throw new VerifyFixError("A --with path cannot name a .git directory.");
    // Both the name and the path it resolves to are checked, so an ignored
    // symbolic link to a tracked directory is refused too.
    const tracked = await executeGit(repositoryRoot, [
      "--literal-pathspecs",
      "ls-files",
      "-z",
      "--",
      path,
      resolvedSegments.join("/"),
    ]);
    if (tracked !== "")
      throw new VerifyFixError(`A --with path is tracked by Git: ${path}.`);
    if (
      accepted.some(
        (other) =>
          other === path ||
          other.startsWith(`${path}/`) ||
          path.startsWith(`${other}/`),
      )
    )
      throw new VerifyFixError(`A --with path overlaps another: ${path}.`);
    accepted.push(path);
  }
  return accepted;
}

function isGitDirectoryName(segment: string): boolean {
  return segment.toLowerCase() === ".git";
}

class CleanupFailure extends Error {}

async function prepareCheckouts(
  input: VerifyFixInput,
  withPaths: readonly string[],
): Promise<PreparedCheckouts> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "andrew-agent-verify-fix-"),
  );
  try {
    const withoutFixCheckout = await createReviewCheckout(
      input.repositoryRoot,
      root,
      input.mergeBase,
      input.head,
    );
    const withFixCheckout = await createReviewCheckout(
      input.repositoryRoot,
      root,
      input.mergeBase,
      input.head,
    );
    await restoreProductionPaths(root, withoutFixCheckout, input);
    for (const path of withPaths) {
      for (const checkout of [withoutFixCheckout, withFixCheckout])
        await cloneWithPath(input.repositoryRoot, checkout, path);
    }
    const source = await realpath(input.repositoryRoot);
    const withoutFix = {
      label: "A",
      source,
      checkout: withoutFixCheckout,
      temporaryDirectory: join(root, "tmp-a"),
    };
    const withFix = {
      label: "B",
      source,
      checkout: withFixCheckout,
      temporaryDirectory: join(root, "tmp-b"),
    };
    await mkdir(withoutFix.temporaryDirectory, { mode: 0o700 });
    await mkdir(withFix.temporaryDirectory, { mode: 0o700 });
    return { root, withoutFix, withFix };
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      throw new CleanupFailure("cleanup failed", { cause: error });
    }
    throw error;
  }
}

// Restores every production path in checkout A to its merge-base state:
// modified files are reverted, added files are removed, and deleted files
// come back. The result is then checked: the index may differ from the merge
// base only in the test paths, and the worktree must match the index.
async function restoreProductionPaths(
  root: string,
  checkout: string,
  input: VerifyFixInput,
): Promise<void> {
  const isolated = { isolateConfig: true } as const;
  const pathspecFile = join(root, "production-paths");
  await writeFile(pathspecFile, `${input.productionPaths.join("\0")}\0`, {
    mode: 0o600,
  });
  await executeGit(
    checkout,
    [
      "--literal-pathspecs",
      "restore",
      `--source=${input.mergeBase}`,
      "--staged",
      "--worktree",
      `--pathspec-from-file=${pathspecFile}`,
      "--pathspec-file-nul",
    ],
    isolated,
  );
  const indexDifference = await executeGit(
    checkout,
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      input.mergeBase,
      "--",
    ],
    isolated,
  );
  const worktreeDifference = await executeGit(
    checkout,
    ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
    isolated,
  );
  // The paths are compared as sorted lists: the source repository's
  // `diff.orderFile` orders `readChangedPaths`, and this isolated checkout
  // ignores that configuration, so the two sides list them differently.
  const expected = [...input.testPaths].sort().join("\0");
  const restored = indexDifference.endsWith("\0")
    ? indexDifference.slice(0, -1).split("\0").sort().join("\0")
    : indexDifference;
  const unstagedOrUntracked = worktreeDifference
    .split("\0")
    .filter((entry) => entry !== "" && entry[1] !== " ");
  if (restored !== expected || unstagedOrUntracked.length !== 0)
    throw new VerifyFixError(
      "Unable to restore the production paths in the verification checkout.",
    );
}

async function cloneWithPath(
  repositoryRoot: string,
  checkout: string,
  path: string,
): Promise<void> {
  const destination = join(checkout, path);
  try {
    await lstat(destination);
    throw new VerifyFixError(
      `A --with path already exists in a verification checkout: ${path}.`,
    );
  } catch (error) {
    if (error instanceof VerifyFixError) throw error;
  }
  try {
    await mkdir(dirname(destination), { recursive: true });
    await execFile("/bin/cp", [
      "-c",
      "-R",
      join(repositoryRoot, path),
      destination,
    ]);
  } catch {
    throw new VerifyFixError(
      `Unable to clone a --with path with copy-on-write: ${path}.`,
    );
  }
}

async function sandboxRefusal(
  dependencies: VerifyFixDependencies,
  run: PreparedRun,
): Promise<string | undefined> {
  const refusal =
    "The network sandbox could not be applied; the test command was not run.";
  try {
    await access(dependencies.sandboxExecutable, fsConstants.X_OK);
  } catch {
    return refusal;
  }
  const probe = await runSandboxed(
    { ...dependencies, timeoutMs: PROBE_TIMEOUT_MS },
    run,
    ["/usr/bin/true"],
  );
  if (probe.outcome.kind === "exited" && probe.outcome.code === 0)
    return undefined;
  return refusal;
}

export async function runSandboxed(
  dependencies: VerifyFixDependencies,
  run: Pick<PreparedRun, "source" | "checkout" | "temporaryDirectory">,
  command: readonly string[],
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        dependencies.sandboxExecutable,
        [
          "-D",
          `SOURCE=${run.source}`,
          "-D",
          `CHECKOUT=${run.checkout}`,
          "-D",
          `TMPDIR=${run.temporaryDirectory}`,
          "-p",
          SANDBOX_PROFILE,
          "--",
          ...command,
        ],
        {
          cwd: run.checkout,
          detached: true,
          env: runEnvironment(run.temporaryDirectory),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      resolve({ outcome: { kind: "not-started" }, tail: "" });
      return;
    }
    const pid = child.pid;
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let total = 0;
    let forced: RunOutcome | undefined;
    let exited: RunOutcome | undefined;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const killGroup = (): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      for (const signal of INTERRUPT_SIGNALS) process.off(signal, onInterrupt);
      // A survivor that left the process group can still hold the pipes
      // open; destroying them releases the handles that would otherwise keep
      // the CLI process alive until the survivor exits.
      child.stdout.destroy();
      child.stderr.destroy();
      let outcome: RunOutcome = forced ??
        exited ?? { kind: "signaled", signal: "an unknown cause" };
      if (
        outcome.kind === "exited" &&
        outcome.code === SANDBOX_EXEC_FAILURE_CODE &&
        head.toString("utf8").startsWith(SANDBOX_EXEC_FAILURE_PREFIX)
      )
        outcome = { kind: "not-started" };
      resolve({ outcome, tail: tail.toString("utf8") });
    };
    // After the main process exits or is stopped, anything left in its
    // process group is killed, and the result settles even if a survivor
    // that left the group still holds the output pipes open.
    const armGrace = (): void => {
      grace ??= setTimeout(finish, KILL_GRACE_MS);
    };
    const stop = (outcome: RunOutcome): void => {
      if (forced !== undefined || settled) return;
      forced = outcome;
      killGroup();
      armGrace();
    };
    const onInterrupt = (): void => stop({ kind: "interrupted" });
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, onInterrupt);
    const timer = setTimeout(
      () => stop({ kind: "timed-out" }),
      dependencies.timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      if (forced !== undefined) return;
      total += chunk.length;
      if (head.length < SANDBOX_EXEC_FAILURE_PREFIX.length)
        head = Buffer.concat([head, chunk]).subarray(0, 256);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(-TAIL_BYTES);
      if (total > dependencies.outputLimitBytes) stop({ kind: "output-limit" });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => {
      exited ??= { kind: "not-started" };
      killGroup();
      armGrace();
    });
    child.on("exit", (code, signal) => {
      exited =
        code !== null
          ? { kind: "exited", code }
          : { kind: "signaled", signal: signal ?? "an unknown signal" };
      killGroup();
      armGrace();
    });
    child.on("close", finish);
  });
}

function runEnvironment(temporaryDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: temporaryDirectory,
  };
  for (const name of ["HOME", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function readHeadRef(repositoryRoot: string): Promise<string> {
  try {
    const ref = (
      await executeGit(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"])
    ).trim();
    if (!ref.startsWith("refs/heads/")) throw new Error("unsupported ref");
    return ref;
  } catch {
    throw new VerifyFixError("verify-fix requires a named current branch.");
  }
}

async function resolveBaseRef(
  repositoryRoot: string,
  baseInput: string | undefined,
): Promise<string> {
  if (baseInput !== undefined) return baseInput;
  try {
    const ref = (
      await executeGit(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        DEFAULT_BASE_SYMBOLIC_REF,
      ])
    ).trim();
    if (!ref.startsWith("refs/remotes/origin/"))
      throw new Error("unsupported ref");
    return ref;
  } catch {
    throw new VerifyFixError(
      "Unable to resolve origin/HEAD; pass an explicit base ref.",
    );
  }
}

async function resolveCommit(
  repositoryRoot: string,
  ref: string,
): Promise<string> {
  try {
    const commit = (
      await executeGit(repositoryRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
      throw new Error("invalid commit");
    return commit;
  } catch {
    throw new VerifyFixError("Unable to resolve the base commit.");
  }
}

async function readMergeBase(
  repositoryRoot: string,
  base: string,
  head: string,
): Promise<string> {
  try {
    const mergeBase = (
      await executeGit(repositoryRoot, ["merge-base", base, head])
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase))
      throw new Error("invalid merge base");
    return mergeBase;
  } catch {
    throw new VerifyFixError("The base and HEAD have no merge base.");
  }
}

// Rename detection stays off so a renamed production file is both an added
// path and a deleted path, and checkout A restores the old name.
async function readChangedPaths(
  repositoryRoot: string,
  mergeBase: string,
  head: string,
): Promise<string[]> {
  const raw = await executeGit(repositoryRoot, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    mergeBase,
    head,
    "--",
  ]);
  if (raw.length === 0) return [];
  if (!raw.endsWith("\0"))
    throw new VerifyFixError("Unable to read changed paths.");
  return raw.slice(0, -1).split("\0");
}

function preflightMessage(error: unknown): string {
  if (error instanceof VerifyFixError)
    return escapeTerminalControls(error.message);
  if (error instanceof GitRuntimeError) {
    if (error.code === "GIT_WORKTREE_DIRTY")
      return "Git worktree is not clean; commit or remove local changes before verify-fix.";
    return `Unable to prepare fix verification: ${error.code}.`;
  }
  return "Unable to prepare fix verification.";
}
