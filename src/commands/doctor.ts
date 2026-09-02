/// <reference types="node" />

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { codexContractDigest } from "../app-server/contract-digest.js";
import { buildBundle, type BundleArtifact } from "../bundle/artifact.js";
import {
  inspectInstallState,
  type ActiveInstallMetadata,
  type OwnedFile,
  type InstallInspection,
} from "../bundle/install.js";
import { parseBundleManifest } from "../bundle/manifest.js";
import type { CapabilityInputs } from "../bundle/render.js";
import {
  PRODUCT_VERSION,
  REQUIRED_CODEX_CONTRACT_DIGEST,
  REQUIRED_CODEX_VERSION,
} from "../constants.js";
import { readGitSnapshot, type GitSnapshot } from "../runtime/git.js";
import { inspectProcessLock } from "../runtime/lock.js";
import type { RuntimePaths } from "../runtime/paths.js";

export interface DiagnosticFinding {
  readonly severity: "blocker" | "warning" | "ready";
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

export interface DoctorDependencies {
  readonly productVersion: string;
  readonly platform: NodeJS.Platform;
  readonly platformVersion: string;
  readonly paths: RuntimePaths;
  readonly builderVersion: string;
  readonly requestedCapabilities: readonly "oracle"[];
  readonly capabilityInputs: CapabilityInputs;
  readonly scratchParent: string;
  readonly commandTimeoutMs: number;
}

const findingOrder = [
  "PRODUCT_VERSION",
  "PLATFORM_VERSION",
  "SOURCE_PATH",
  "SOURCE_REVISION",
  "SOURCE_DIRTY",
  "MANIFEST_VALID",
  "CANDIDATE_BUNDLE",
  "ACTIVE_INSTALL",
  "BUNDLE_DIGEST",
  "CODEX_VERSION",
  "SCHEMA_COMPATIBILITY",
  "AUTH_CONFIGURATION",
  "PORTABLE_CONFIG_CLOSURE",
  "HOOK_READINESS",
  "INTERPRETER_READINESS",
  "STRICT_CONFIG",
  "SANDBOX_BOUNDARY",
  "OPTIONAL_ORACLE",
  "OPTIONAL_SHARED_MEMORY",
  "PROCESS_LOCK",
  "INSTALL_JOURNAL",
  "SCRATCH_CLEANUP",
] as const;

type FindingCode = (typeof findingOrder)[number];
type MutableFindings = Map<FindingCode, DiagnosticFinding>;
type CodexVersionState = "compatible" | "wrong-version" | "unavailable";
const severityOrder = { blocker: 0, warning: 1, ready: 2 } as const;
const maxChildOutputBytes = 64 * 1024;
const maxAuthenticationBytes = 64 * 1024;
const authenticationFileName = ["auth", ".json"].join("");
const authenticationKeys = new Set([
  "auth_mode",
  "OPENAI_API_KEY",
  "tokens",
  "last_refresh",
  "agent_identity",
  "personal_access_token",
  "bedrock_api_key",
]);

interface DoctorTestHooks {
  readonly afterScratchMkdtemp?: (scratchRoot: string) => void | Promise<void>;
  readonly beforeScratchCreationCleanup?: (
    scratchRoot: string,
  ) => void | Promise<void>;
  readonly beforeVersionSpawn?: (codexHome: string) => void | Promise<void>;
  readonly beforeContractSpawn?: (codexHome: string) => void | Promise<void>;
  /**
   * Digest the resolved binary must reproduce. A fake generator cannot emit
   * the pinned contract, so tests substitute the digest of what theirs writes.
   * It lives here rather than on DoctorDependencies so no production caller
   * can disable the gate by passing one field.
   */
  readonly contractDigest?: string;
  readonly beforeStrictSpawn?: () => void | Promise<void>;
  readonly beforeMaterialization?: (shadowHome: string) => void | Promise<void>;
  readonly beforeScratchCleanup?: (scratchRoot: string) => void | Promise<void>;
  readonly beforeAuthenticationRead?: (path: string) => void | Promise<void>;
}

export async function runDoctor(dependencies: DoctorDependencies): Promise<{
  readonly exitCode: 0 | 1;
  readonly findings: readonly DiagnosticFinding[];
}> {
  return runDoctorInternal(dependencies, {});
}

/** Test-only invocation-scoped failure injection outside DoctorDependencies. */
export async function __runDoctorForTests(
  dependencies: DoctorDependencies,
  hooks: DoctorTestHooks,
): Promise<{
  readonly exitCode: 0 | 1;
  readonly findings: readonly DiagnosticFinding[];
}> {
  return runDoctorInternal(dependencies, hooks);
}

async function runDoctorInternal(
  dependencies: DoctorDependencies,
  hooks: DoctorTestHooks,
): Promise<{
  readonly exitCode: 0 | 1;
  readonly findings: readonly DiagnosticFinding[];
}> {
  const findings: MutableFindings = new Map();
  let scratchRoot: string | undefined;
  let scratchReady = false;
  let snapshot: GitSnapshot | undefined;
  let candidate: BundleArtifact | undefined;
  let inspection: InstallInspection | undefined;

  classifyProduct(dependencies, findings);
  classifyPlatform(dependencies, findings);
  // Unconditional, like the two above it, and deliberately outside the fallible
  // region below: a statement of the sandbox contract cannot fail, so it must
  // not be able to reach ensureAllFindings unset and be reported as a
  // diagnostic that "could not be completed". No path reaches that today —
  // every diagnostic below catches its own failure — but the placement is what
  // makes the guarantee, not the absence of a caller. The three facts are
  // measured in docs/notes/2026-09-02-sandbox-boundary-measurement.md, and the
  // boundary is named by class because a finding is terminal output and #23
  // step 5 keeps personal paths out of it. Changing the policy in
  // coordinator.ts means changing this sentence.
  setReady(
    findings,
    "SANDBOX_BOUNDARY",
    "A managed turn may write inside the target repository and /tmp, and " +
      "nowhere else; network access is off. TMPDIR is unset in the managed " +
      "child, so a tool that reads it falls back to /tmp, while one that " +
      "resolves the Darwin per-user temporary directory is refused like any " +
      "other path outside the boundary.",
  );

  try {
    scratchRoot = await createScratchRoot(
      dependencies,
      hooks,
      (createdRoot) => {
        scratchRoot = createdRoot;
      },
    );
    scratchReady = true;
  } catch {
    setBlocker(
      findings,
      "SCRATCH_CLEANUP",
      "Doctor scratch space is unavailable.",
      "Choose a safe owner-controlled scratch parent outside protected roots.",
    );
  }

  try {
    try {
      snapshot = await readGitSnapshot(dependencies.paths.sourceRoot);
      if (snapshot.repositoryRoot === dependencies.paths.sourceRoot) {
        setReady(findings, "SOURCE_PATH", "The source path is resolved.");
      } else {
        setBlocker(
          findings,
          "SOURCE_PATH",
          "The source path does not resolve to the expected repository root.",
          "Resolve the source path to the repository root before retrying.",
        );
      }
      setReady(findings, "SOURCE_REVISION", "The source revision is resolved.");
      if (snapshot.clean) {
        setReady(findings, "SOURCE_DIRTY", "The source worktree is clean.");
      } else {
        setBlocker(
          findings,
          "SOURCE_DIRTY",
          "The source worktree has uncommitted changes.",
          "Commit or remove source worktree changes before retrying.",
        );
      }
    } catch {
      setBlocker(
        findings,
        "SOURCE_PATH",
        "The source path cannot be inspected.",
        "Resolve the source repository path before retrying.",
      );
      setBlocker(
        findings,
        "SOURCE_REVISION",
        "The source revision cannot be resolved.",
        "Restore a readable Git revision before retrying.",
      );
      setBlocker(
        findings,
        "SOURCE_DIRTY",
        "Source cleanliness cannot be established.",
        "Restore a readable clean Git worktree before retrying.",
      );
    }

    const manifestReady = await classifyManifest(
      snapshot,
      dependencies,
      findings,
    );
    if (
      scratchReady &&
      scratchRoot !== undefined &&
      snapshot?.clean === true &&
      snapshot.repositoryRoot === dependencies.paths.sourceRoot &&
      manifestReady
    ) {
      candidate = await constructCandidate(dependencies, scratchRoot, findings);
    } else {
      setCandidateDependenciesBlocked(findings);
      classifyOracleWithoutCandidate(dependencies, findings);
    }

    inspection = await classifyInstall(dependencies, findings);
    classifyDigest(candidate, inspection, findings);
    const codexVersionState =
      !scratchReady || scratchRoot === undefined
        ? classifyUnavailableCodexVersion(findings)
        : await classifyCodexVersion(
            dependencies,
            scratchRoot,
            findings,
            hooks,
          );
    await classifyAuthentication(dependencies, findings, hooks);

    if (candidate !== undefined) {
      setReady(
        findings,
        "PORTABLE_CONFIG_CLOSURE",
        "The candidate portable configuration is closed.",
      );
      setReady(
        findings,
        "HOOK_READINESS",
        "Candidate hook dependencies are ready.",
      );
      setReady(
        findings,
        "INTERPRETER_READINESS",
        "Candidate interpreter requirements are ready.",
      );
    }

    if (
      codexVersionState === "compatible" &&
      scratchRoot !== undefined &&
      inspection?.active !== null &&
      inspection !== undefined &&
      inspection.issues.length === 0
    ) {
      await classifyStrictConfig(
        dependencies,
        scratchRoot,
        inspection.active,
        findings,
        hooks,
      );
    } else if (codexVersionState === "wrong-version") {
      setWarning(
        findings,
        "STRICT_CONFIG",
        "Strict Codex configuration validation was not evaluated because the " +
          "pinned Codex version was unavailable.",
        `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
      );
    } else {
      setBlocker(
        findings,
        "STRICT_CONFIG",
        "Strict Codex configuration validation could not run.",
        codexVersionState === "compatible"
          ? "Restore a valid active installation before retrying."
          : `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
      );
    }

    setWarning(
      findings,
      "OPTIONAL_SHARED_MEMORY",
      "Shared memory is unavailable in v0.1.",
      "Continue without shared memory.",
    );
    await classifyProcessLock(dependencies, findings);
  } catch {
    // Any unexpected dependency failure remains bounded by prerequisite blockers.
  } finally {
    if (scratchRoot !== undefined) {
      let cleanupFailed = false;
      try {
        await hooks.beforeScratchCleanup?.(scratchRoot);
      } catch {
        cleanupFailed = true;
      }
      try {
        await rm(scratchRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
      if (await pathExists(scratchRoot)) cleanupFailed = true;
      if (cleanupFailed) {
        setBlocker(
          findings,
          "SCRATCH_CLEANUP",
          "Doctor scratch cleanup failed.",
          "Remove the doctor scratch directory before retrying.",
        );
      } else if (findings.get("SCRATCH_CLEANUP")?.severity !== "blocker") {
        setReady(
          findings,
          "SCRATCH_CLEANUP",
          "Doctor scratch space was removed.",
        );
      }
    }
  }

  ensureAllFindings(findings);
  const sorted = [...findings.values()].sort(compareFindings);
  return {
    exitCode: sorted.some((finding) => finding.severity === "blocker") ? 1 : 0,
    findings: sorted,
  };
}

function classifyProduct(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): void {
  if (dependencies.productVersion === PRODUCT_VERSION) {
    setReady(findings, "PRODUCT_VERSION", "The product version is supported.");
  } else {
    setBlocker(
      findings,
      "PRODUCT_VERSION",
      "The product version is unsupported.",
      `Use andrew-code-agent ${PRODUCT_VERSION}.`,
    );
  }
}

function classifyPlatform(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): void {
  if (
    dependencies.platform === "darwin" &&
    typeof dependencies.platformVersion === "string" &&
    dependencies.platformVersion.length > 0
  ) {
    setReady(findings, "PLATFORM_VERSION", "The macOS platform is supported.");
  } else {
    setBlocker(
      findings,
      "PLATFORM_VERSION",
      "The platform is unsupported.",
      "Run andrew-code-agent on macOS.",
    );
  }
}

async function classifyManifest(
  snapshot: GitSnapshot | undefined,
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): Promise<boolean> {
  if (
    snapshot?.clean !== true ||
    snapshot.repositoryRoot !== dependencies.paths.sourceRoot
  ) {
    setBlocker(
      findings,
      "MANIFEST_VALID",
      "Bundle manifest validity cannot be established.",
      "Restore a clean resolved source repository before retrying.",
    );
    return false;
  }
  try {
    const bytes = await readFile(
      join(dependencies.paths.sourceRoot, "agent-bundle.toml"),
    );
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseBundleManifest(source);
    setReady(findings, "MANIFEST_VALID", "The bundle manifest is valid.");
    return true;
  } catch {
    setBlocker(
      findings,
      "MANIFEST_VALID",
      "The bundle manifest is invalid.",
      "Repair the source bundle manifest before retrying.",
    );
    return false;
  }
}

async function constructCandidate(
  dependencies: DoctorDependencies,
  scratchRoot: string,
  findings: MutableFindings,
): Promise<BundleArtifact | undefined> {
  const artifactsRoot = join(scratchRoot, "artifacts");
  try {
    await mkdir(artifactsRoot, { mode: 0o700 });
    let artifact: BundleArtifact;
    try {
      artifact = await buildBundle({
        sourceRoot: dependencies.paths.sourceRoot,
        artifactsRoot,
        requestedCapabilities: dependencies.requestedCapabilities,
        capabilityInputs: dependencies.capabilityInputs,
        builderVersion: dependencies.builderVersion,
      });
    } catch (error) {
      if (
        dependencies.requestedCapabilities.includes("oracle") &&
        isOptionalOracleFailure(error)
      ) {
        setWarning(
          findings,
          "OPTIONAL_ORACLE",
          "Oracle is unavailable for this candidate.",
          "Continue with the base candidate or provide valid Oracle input.",
        );
        artifact = await buildBundle({
          sourceRoot: dependencies.paths.sourceRoot,
          artifactsRoot,
          requestedCapabilities: [],
          capabilityInputs: {},
          builderVersion: dependencies.builderVersion,
        });
      } else {
        throw error;
      }
    }
    setReady(findings, "CANDIDATE_BUNDLE", "The candidate bundle is valid.");
    if (!findings.has("OPTIONAL_ORACLE")) {
      if (artifact.metadata.enabledCapabilities.includes("oracle")) {
        setReady(
          findings,
          "OPTIONAL_ORACLE",
          "Oracle is ready in the candidate.",
        );
      } else {
        classifyOracleWithoutCandidate(dependencies, findings);
      }
    }
    return artifact;
  } catch {
    setCandidateDependenciesBlocked(findings);
    classifyOracleWithoutCandidate(dependencies, findings);
    return undefined;
  }
}

function isOptionalOracleFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error))
    return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "CAPABILITY_INPUT_INVALID" ||
    code === "ORACLE_INPUT_INVALID" ||
    code === "CAPABILITY_REQUIREMENT_UNAVAILABLE"
  );
}

function classifyOracleWithoutCandidate(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): void {
  if (findings.has("OPTIONAL_ORACLE")) return;
  setWarning(
    findings,
    "OPTIONAL_ORACLE",
    dependencies.requestedCapabilities.includes("oracle")
      ? "Oracle readiness could not be established."
      : "Oracle was not requested for this candidate.",
    "Continue without Oracle or provide valid Oracle input.",
  );
}

function setCandidateDependenciesBlocked(findings: MutableFindings): void {
  setBlocker(
    findings,
    "CANDIDATE_BUNDLE",
    "Candidate bundle readiness cannot be established.",
    "Resolve source, manifest, or candidate requirements before retrying.",
  );
  setBlocker(
    findings,
    "PORTABLE_CONFIG_CLOSURE",
    "Portable configuration closure cannot be established.",
    "Build a valid base candidate before retrying.",
  );
  setBlocker(
    findings,
    "HOOK_READINESS",
    "Hook readiness cannot be established.",
    "Build a valid base candidate before retrying.",
  );
  setBlocker(
    findings,
    "INTERPRETER_READINESS",
    "Interpreter readiness cannot be established.",
    "Build a valid base candidate before retrying.",
  );
}

async function classifyInstall(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): Promise<InstallInspection | undefined> {
  try {
    const inspection = await inspectInstallState(dependencies.paths.stateRoot);
    const journalIssue = inspection.issues.some((issue) =>
      [
        "INVALID_INSTALL_JOURNAL",
        "INVALID_RECOVERY_MATERIAL",
        "ORPHAN_TRANSACTION_CONTROL",
      ].includes(issue),
    );
    const activeIssue = inspection.issues.some(
      (issue) =>
        ![
          "INVALID_INSTALL_JOURNAL",
          "INVALID_RECOVERY_MATERIAL",
          "ORPHAN_TRANSACTION_CONTROL",
        ].includes(issue),
    );
    if (inspection.active === null || activeIssue) {
      setBlocker(
        findings,
        "ACTIVE_INSTALL",
        "The active installation is missing or invalid.",
        "Install a valid candidate before retrying.",
      );
    } else {
      setReady(findings, "ACTIVE_INSTALL", "The active installation is valid.");
    }
    if (inspection.journal !== null) {
      setBlocker(
        findings,
        "INSTALL_JOURNAL",
        "An interrupted installation journal is present.",
        "Complete explicit installation recovery before retrying.",
      );
    } else if (journalIssue) {
      setBlocker(
        findings,
        "INSTALL_JOURNAL",
        "The installation journal state is invalid.",
        "Repair the installation control state before retrying.",
      );
    } else {
      setReady(
        findings,
        "INSTALL_JOURNAL",
        "No interrupted installation journal is present.",
      );
    }
    return inspection;
  } catch {
    setBlocker(
      findings,
      "ACTIVE_INSTALL",
      "The active installation cannot be inspected.",
      "Restore readable installation state before retrying.",
    );
    setBlocker(
      findings,
      "INSTALL_JOURNAL",
      "The installation journal cannot be inspected.",
      "Restore readable installation control state before retrying.",
    );
    return undefined;
  }
}

function classifyDigest(
  candidate: BundleArtifact | undefined,
  inspection: InstallInspection | undefined,
  findings: MutableFindings,
): void {
  if (
    candidate === undefined ||
    inspection?.active === null ||
    inspection === undefined ||
    inspection.issues.length > 0
  ) {
    setBlocker(
      findings,
      "BUNDLE_DIGEST",
      "Bundle digest compatibility cannot be established.",
      "Restore valid candidate and active bundles before retrying.",
    );
  } else if (
    candidate.metadata.bundleDigest === inspection.active.bundleDigest
  ) {
    setReady(
      findings,
      "BUNDLE_DIGEST",
      "Candidate and active bundle digests match.",
    );
  } else {
    setWarning(
      findings,
      "BUNDLE_DIGEST",
      "The candidate bundle differs from the active installation.",
      "Install the candidate bundle to make it active.",
    );
  }
}

async function classifyCodexVersion(
  dependencies: DoctorDependencies,
  scratchRoot: string,
  findings: MutableFindings,
  hooks: DoctorTestHooks,
): Promise<CodexVersionState> {
  const expected = `codex-cli ${REQUIRED_CODEX_VERSION}`;
  try {
    const versionHome = await createIsolatedCodexHome(
      scratchRoot,
      "version-codex-home",
    );
    await hooks.beforeVersionSpawn?.(versionHome);
    const result = await runBoundedChild(
      dependencies.paths.codexBin,
      ["--version"],
      versionHome,
      dependencies.commandTimeoutMs,
    );
    const safeVersionResult =
      isSafeProbeResult(result) && result.stderr.length === 0;
    if (safeVersionResult && result.stdout === `${expected}\n`) {
      setReady(
        findings,
        "CODEX_VERSION",
        "The resolved Codex version is supported.",
      );
      await classifyCodexContract(dependencies, scratchRoot, findings, hooks);
      return "compatible";
    }
    if (safeVersionResult && isCodexVersionReport(result.stdout)) {
      setBlocker(
        findings,
        "CODEX_VERSION",
        `Resolved Codex version does not match ${expected}.`,
        `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
      );
      setWarning(
        findings,
        "SCHEMA_COMPATIBILITY",
        "Codex schema compatibility was not evaluated because the pinned " +
          "Codex version was unavailable.",
        `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
      );
      return "wrong-version";
    }
  } catch {
    // The stable findings below intentionally hide child and exception details.
  }
  setBlocker(
    findings,
    "CODEX_VERSION",
    `Resolved Codex version does not match ${expected}.`,
    `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
  );
  setBlocker(
    findings,
    "SCHEMA_COMPATIBILITY",
    "Codex schema compatibility cannot be established.",
    `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
  );
  return "unavailable";
}

function isCodexVersionReport(value: string): boolean {
  return /^codex-cli \d+\.\d+\.\d+\n$/.test(value);
}

/**
 * Regenerates the app-server contract from the resolved binary and compares it
 * against the digest the product was built against. The version string alone
 * cannot carry this: a rebuilt binary reporting the pinned version can still
 * add a required field, which the typed callers would then meet at runtime.
 *
 * Only reached once the version probe matched exactly, so a binary without the
 * generator subcommands is already blocked by `CODEX_VERSION`. Never throws.
 */
async function classifyCodexContract(
  dependencies: DoctorDependencies,
  scratchRoot: string,
  findings: MutableFindings,
  hooks: DoctorTestHooks,
): Promise<void> {
  const expected = hooks.contractDigest ?? REQUIRED_CODEX_CONTRACT_DIGEST;
  try {
    const contractHome = await createIsolatedCodexHome(
      scratchRoot,
      "contract-codex-home",
    );
    const roots = {
      generated: join(scratchRoot, "contract-generated"),
      schemas: join(scratchRoot, "contract-schemas"),
    };
    await hooks.beforeContractSpawn?.(contractHome);
    for (const [subcommand, out] of [
      ["generate-ts", roots.generated],
      ["generate-json-schema", roots.schemas],
    ] as const) {
      const result = await runBoundedChild(
        dependencies.paths.codexBin,
        ["app-server", subcommand, "--out", out],
        contractHome,
        dependencies.commandTimeoutMs,
      );
      if (!isSafeProbeResult(result) || result.stderr.length !== 0) {
        throw new Error("contract generation failed");
      }
    }
    if ((await codexContractDigest(roots)) === expected) {
      setReady(
        findings,
        "SCHEMA_COMPATIBILITY",
        "The generated Codex app-server contract matches the pinned one.",
      );
      return;
    }
    setBlocker(
      findings,
      "SCHEMA_COMPATIBILITY",
      "The resolved Codex binary generates a different app-server contract " +
        "than the pinned one.",
      `Reinstall codex-cli ${REQUIRED_CODEX_VERSION} from a trusted source ` +
        "and retry.",
    );
    return;
  } catch {
    // The stable finding below intentionally hides child and exception details.
  }
  setBlocker(
    findings,
    "SCHEMA_COMPATIBILITY",
    "Codex schema compatibility cannot be established.",
    `Reinstall codex-cli ${REQUIRED_CODEX_VERSION} from a trusted source and ` +
      "retry.",
  );
}

/** Owner-only scratch `CODEX_HOME` for one probe, rejected if it is not one. */
async function createIsolatedCodexHome(
  scratchRoot: string,
  name: string,
): Promise<string> {
  const home = join(scratchRoot, name);
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const metadata = await lstat(home);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("unsafe probe home");
  }
  return home;
}

function isSafeProbeResult(result: ChildResult): boolean {
  return (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.outputExceeded &&
    !result.residualDescendants &&
    !result.groupCleanupFailed
  );
}

function classifyUnavailableCodexVersion(
  findings: MutableFindings,
): CodexVersionState {
  const expected = `codex-cli ${REQUIRED_CODEX_VERSION}`;
  setBlocker(
    findings,
    "CODEX_VERSION",
    `Resolved Codex version does not match ${expected}.`,
    `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
  );
  setBlocker(
    findings,
    "SCHEMA_COMPATIBILITY",
    "Codex schema compatibility cannot be established.",
    `Install codex-cli ${REQUIRED_CODEX_VERSION} and retry.`,
  );
  return "unavailable";
}

async function classifyAuthentication(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
  hooks: DoctorTestHooks,
): Promise<void> {
  try {
    if (await hasSafeAuthentication(dependencies.paths.codexHome, hooks)) {
      setReady(
        findings,
        "AUTH_CONFIGURATION",
        "Codex authentication material is safely configured.",
      );
      return;
    }
  } catch {
    // The bounded finding below intentionally hides authentication details.
  }
  setBlocker(
    findings,
    "AUTH_CONFIGURATION",
    "Codex authentication is not safely configured.",
    `CODEX_HOME=${JSON.stringify(dependencies.paths.codexHome)} codex login`,
  );
}

async function hasSafeAuthentication(
  codexHome: string,
  hooks: DoctorTestHooks,
): Promise<boolean> {
  const path = resolve(codexHome, authenticationFileName);
  if (!isContained(codexHome, path)) return false;
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > maxAuthenticationBytes
    ) {
      return false;
    }
    await hooks.beforeAuthenticationRead?.(path);
    const buffer = Buffer.alloc(maxAuthenticationBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxAuthenticationBytes) return false;
    const bytes = buffer.subarray(0, bytesRead);
    const after = await file.stat();
    const pathMetadata = await lstat(path);
    if (
      !sameFileIdentity(metadata, after) ||
      !sameFileIdentity(after, pathMetadata) ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.uid !== currentUid() ||
      (pathMetadata.mode & 0o777) !== 0o600
    ) {
      return false;
    }
    const document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    return isSupportedAuthentication(document);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function isSupportedAuthentication(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).some((key) => !authenticationKeys.has(key)))
    return false;
  if (!validOptionalRefresh(value.last_refresh)) return false;
  if (!validOptionalAgentIdentity(value.agent_identity)) return false;
  if (!validOptionalString(value.personal_access_token)) return false;
  if (!validOptionalBedrockKey(value.bedrock_api_key)) return false;
  if (!validOptionalTokens(value.tokens)) return false;

  const mode = value.auth_mode;
  if (mode !== undefined && mode !== "apikey" && mode !== "chatgpt") {
    return false;
  }
  const apiKey = value.OPENAI_API_KEY;
  const apiKeyPresent = apiKey !== undefined && apiKey !== null;
  if (apiKeyPresent && (typeof apiKey !== "string" || apiKey.length === 0)) {
    return false;
  }
  const tokensPresent = value.tokens !== undefined && value.tokens !== null;
  if (mode === "apikey") return apiKeyPresent && !tokensPresent;
  if (mode === "chatgpt") {
    return !apiKeyPresent && isCompleteTokens(value.tokens);
  }
  if (
    value.personal_access_token !== undefined &&
    value.personal_access_token !== null
  ) {
    return false;
  }
  if (value.bedrock_api_key !== undefined && value.bedrock_api_key !== null) {
    return false;
  }
  if (apiKeyPresent) return !tokensPresent;
  return isCompleteTokens(value.tokens);
}

function validOptionalTokens(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  if (!isCompleteTokens(value)) return false;
  return (
    value.account_id === undefined ||
    value.account_id === null ||
    typeof value.account_id === "string"
  );
}

function isCompleteTokens(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  if (
    !Object.hasOwn(value, "id_token") ||
    !Object.hasOwn(value, "access_token") ||
    !Object.hasOwn(value, "refresh_token")
  ) {
    return false;
  }
  return [value.id_token, value.access_token, value.refresh_token].every(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
}

function validOptionalRefresh(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validOptionalAgentIdentity(value: unknown): boolean {
  if (value === undefined || value === null || typeof value === "string") {
    return true;
  }
  if (!isPlainObject(value)) return false;
  return (
    [
      value.agent_runtime_id,
      value.agent_private_key,
      value.account_id,
      value.chatgpt_user_id,
      value.plan_type,
    ].every((entry) => typeof entry === "string") &&
    typeof value.chatgpt_account_is_fedramp === "boolean" &&
    validOptionalString(value.email) &&
    validOptionalString(value.task_id)
  );
}

function validOptionalBedrockKey(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    isPlainObject(value) &&
    typeof value.api_key === "string" &&
    typeof value.region === "string"
  );
}

async function classifyStrictConfig(
  dependencies: DoctorDependencies,
  scratchRoot: string,
  active: ActiveInstallMetadata,
  findings: MutableFindings,
  hooks: DoctorTestHooks,
): Promise<void> {
  const shadowHome = join(scratchRoot, "strict-codex-home");
  try {
    await materializeActiveInventory(
      dependencies.paths.codexHome,
      shadowHome,
      active,
      hooks,
    );
    await hooks.beforeStrictSpawn?.();
    const result = await runBoundedChild(
      dependencies.paths.codexBin,
      ["app-server", "--strict-config", "--listen", "stdio://"],
      shadowHome,
      dependencies.commandTimeoutMs,
    );
    const boundedResult =
      !result.timedOut &&
      !result.outputExceeded &&
      !result.residualDescendants &&
      !result.groupCleanupFailed;
    if (boundedResult && result.exitCode === 0) {
      setReady(
        findings,
        "STRICT_CONFIG",
        "Strict Codex configuration validation passed.",
      );
      return;
    }
    if (boundedResult && result.exitCode !== null) {
      const diagnostic = parseStrictConfigDiagnostic(result.stderr);
      if (diagnostic !== undefined) {
        setBlocker(
          findings,
          "STRICT_CONFIG",
          `Strict Codex configuration validation failed at ${diagnostic}.`,
          "Resolve the managed portable configuration before retrying.",
        );
        return;
      }
    }
  } catch {
    // The stable finding below intentionally hides config and child details.
  }
  setBlocker(
    findings,
    "STRICT_CONFIG",
    "Strict Codex configuration validation failed.",
    "Resolve the managed portable configuration before retrying.",
  );
}

function parseStrictConfigDiagnostic(stderr: string): string | undefined {
  const matches = [
    ...stderr.matchAll(
      /^config\.toml:([1-9]\d{0,5}):([1-9]\d{0,5}): duplicate key$/gm,
    ),
  ];
  if (matches.length !== 1) return undefined;
  const [, line, column] = matches[0]!;
  return `config.toml:${line!}:${column!} (duplicate key)`;
}

async function materializeActiveInventory(
  managedHome: string,
  shadowHome: string,
  active: ActiveInstallMetadata,
  hooks: DoctorTestHooks,
): Promise<void> {
  if (
    !isAbsolute(managedHome) ||
    !isContained(dirname(shadowHome), shadowHome)
  ) {
    throw new Error("unsafe roots");
  }
  await mkdir(shadowHome, { mode: 0o700 });
  await chmod(shadowHome, 0o700);
  await hooks.beforeMaterialization?.(shadowHome);
  const canonicalManagedHome = await realpath(managedHome);
  if (canonicalManagedHome !== managedHome)
    throw new Error("managed home drift");
  for (const entry of active.files) {
    const source = resolve(managedHome, entry.path);
    const target = resolve(shadowHome, entry.path);
    if (!isContained(managedHome, source) || !isContained(shadowHome, target)) {
      throw new Error("containment");
    }
    if ((await realpath(source)) !== source) throw new Error("source symlink");
    const sourceDirectories = await inspectDirectoryChain(
      managedHome,
      dirname(source),
    );
    const { bytes, mode } = await readOwnedFile(source, entry);
    await revalidateDirectoryChain(sourceDirectories);
    const targetDirectories = await ensureTargetDirectories(
      shadowHome,
      dirname(target),
    );
    await writeExclusiveOwnedFile(target, bytes, mode);
    await revalidateDirectoryChain(targetDirectories);
  }
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

async function inspectDirectoryChain(
  root: string,
  target: string,
): Promise<readonly DirectoryIdentity[]> {
  const relativeTarget = relative(root, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error("directory containment");
  }
  const paths = [root];
  let current = root;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("unsafe directory ancestor");
    }
    if ((await realpath(path)) !== path) throw new Error("directory drift");
    identities.push({ path, dev: metadata.dev, ino: metadata.ino });
  }
  return identities;
}

async function ensureTargetDirectories(
  root: string,
  target: string,
): Promise<readonly DirectoryIdentity[]> {
  const relativeTarget = relative(root, target);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error("target containment");
  }
  let current = root;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
  return inspectDirectoryChain(root, target);
}

async function revalidateDirectoryChain(
  identities: readonly DirectoryIdentity[],
): Promise<void> {
  for (const identity of identities) {
    const metadata = await lstat(identity.path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino ||
      (await realpath(identity.path)) !== identity.path
    ) {
      throw new Error("directory identity drift");
    }
  }
}

async function writeExclusiveOwnedFile(
  path: string,
  bytes: Uint8Array,
  mode: 0o600 | 0o644 | 0o755,
): Promise<void> {
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    await file.writeFile(bytes);
    await file.chmod(mode);
    const descriptor = await file.stat();
    const pathMetadata = await lstat(path);
    if (
      !descriptor.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      !sameFileIdentity(descriptor, pathMetadata) ||
      (pathMetadata.mode & 0o777) !== mode
    ) {
      throw new Error("target identity drift");
    }
  } finally {
    await file?.close().catch(() => undefined);
  }
}

interface ChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
  readonly residualDescendants: boolean;
  readonly groupCleanupFailed: boolean;
}

async function runBoundedChild(
  executable: string,
  arguments_: readonly string[],
  codexHome: string,
  timeoutMs: number,
): Promise<ChildResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeout");
  const child = spawn(executable, arguments_, {
    detached: true,
    env: {
      CODEX_HOME: codexHome,
      PATH: dirname(process.execPath),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let totalBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  let terminationPromise: Promise<boolean> | undefined;
  const terminate = (): void => {
    terminationPromise ??= terminateProcessGroup(child.pid);
  };
  const consume = (destination: Buffer[], chunk: Buffer): void => {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxChildOutputBytes) {
      outputExceeded = true;
      terminate();
      return;
    }
    destination.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveClose(code));
  }).finally(() => clearTimeout(timer));
  let residualDescendants = false;
  let groupCleanupFailed = false;
  if (terminationPromise !== undefined) {
    groupCleanupFailed = !(await terminationPromise);
  } else if (child.pid !== undefined && processGroupExists(child.pid)) {
    residualDescendants = true;
    groupCleanupFailed = !(await terminateProcessGroup(child.pid));
  }
  return {
    exitCode,
    stdout: new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(stdout),
    ),
    stderr: new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(stderr),
    ),
    timedOut,
    outputExceeded,
    residualDescendants,
    groupCleanupFailed,
  };
}

async function terminateProcessGroup(
  pid: number | undefined,
): Promise<boolean> {
  if (pid === undefined || !processGroupExists(pid)) return true;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupAbsence(pid, 100)) return true;
  if (!processGroupExists(pid)) return true;
  signalProcessGroup(pid, "SIGKILL");
  return waitForProcessGroupAbsence(pid, 500);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The isolated group may already have exited.
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

async function waitForProcessGroupAbsence(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return true;
}

async function classifyProcessLock(
  dependencies: DoctorDependencies,
  findings: MutableFindings,
): Promise<void> {
  try {
    const diagnosis = await inspectProcessLock(dependencies.paths.stateRoot);
    if (diagnosis.status === "absent") {
      setReady(findings, "PROCESS_LOCK", "No process lock is present.");
    } else if (diagnosis.status === "live") {
      setWarning(
        findings,
        "PROCESS_LOCK",
        "A live local process lock is present.",
        "Wait for the managed process to finish before making changes.",
      );
    } else if (diagnosis.status === "stale") {
      setBlocker(
        findings,
        "PROCESS_LOCK",
        "A stale process lock is present.",
        "Confirm no managed process is running, then remove the stale lock.",
      );
    } else if (diagnosis.status === "unknown") {
      setBlocker(
        findings,
        "PROCESS_LOCK",
        "The process lock owner cannot be verified.",
        "Verify the lock owner before changing the lock.",
      );
    } else {
      setBlocker(
        findings,
        "PROCESS_LOCK",
        "The process lock is malformed.",
        "Inspect the malformed lock before changing it.",
      );
    }
  } catch {
    setBlocker(
      findings,
      "PROCESS_LOCK",
      "The process lock cannot be inspected.",
      "Restore readable process lock state before retrying.",
    );
  }
}

async function createScratchRoot(
  dependencies: DoctorDependencies,
  hooks: DoctorTestHooks,
  publishCreatedRoot: (scratchRoot: string) => void,
): Promise<string> {
  if (
    !isAbsolute(dependencies.scratchParent) ||
    isContained(dependencies.paths.sourceRoot, dependencies.scratchParent) ||
    isContained(dependencies.paths.stateRoot, dependencies.scratchParent)
  ) {
    throw new Error("unsafe scratch parent");
  }
  const parent = await realpath(dependencies.scratchParent);
  if (parent !== dependencies.scratchParent) throw new Error("scratch drift");
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe scratch parent");
  }
  const scratchRoot = await mkdtemp(join(parent, "andrew-agent-doctor-"));
  publishCreatedRoot(scratchRoot);
  try {
    await hooks.afterScratchMkdtemp?.(scratchRoot);
    await chmod(scratchRoot, 0o700);
    const scratchMetadata = await lstat(scratchRoot);
    if (
      !scratchMetadata.isDirectory() ||
      scratchMetadata.isSymbolicLink() ||
      scratchMetadata.uid !== currentUid() ||
      (scratchMetadata.mode & 0o777) !== 0o700
    ) {
      throw new Error("unsafe scratch root");
    }
    return scratchRoot;
  } catch (error) {
    try {
      await hooks.beforeScratchCreationCleanup?.(scratchRoot);
      await rm(scratchRoot, { recursive: true, force: true });
    } catch {
      // The outer finally block owns the mandatory retry and absence check.
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    return true;
  }
}

// An immutable entry is pinned to its recorded mode and digest. A
// reset-before-run entry is read as installed, because Codex rewrites it
// between runs and the next run resets it from the bundle; pinning it here
// would report an expected rewrite as a configuration failure. Every other
// guarantee is unchanged: a regular file, never a symlink, with a stable
// identity across the read.
async function readOwnedFile(
  path: string,
  entry: OwnedFile,
): Promise<{ bytes: Buffer; mode: 0o600 | 0o644 | 0o755 }> {
  const pinned = entry.lifecycle === "immutable";
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat();
    const mode = normalizeMode(before.mode);
    if (!before.isFile() || (pinned && mode !== entry.mode)) {
      throw new Error("source type");
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    const pathMetadata = await lstat(path);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathMetadata) ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      normalizeMode(pathMetadata.mode) !== mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (pinned && sha256(bytes) !== entry.sha256)
    ) {
      throw new Error("source drift");
    }
    return {
      bytes,
      mode: mode === "0600" ? 0o600 : mode === "0755" ? 0o755 : 0o644,
    };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function ensureAllFindings(findings: MutableFindings): void {
  for (const code of findingOrder) {
    if (!findings.has(code)) {
      setBlocker(
        findings,
        code,
        "This diagnostic could not be completed.",
        "Resolve earlier diagnostic blockers before retrying.",
      );
    }
  }
}

function compareFindings(
  left: DiagnosticFinding,
  right: DiagnosticFinding,
): number {
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    findingOrder.indexOf(left.code as FindingCode) -
      findingOrder.indexOf(right.code as FindingCode)
  );
}

function setReady(
  findings: MutableFindings,
  code: FindingCode,
  message: string,
): void {
  findings.set(code, { severity: "ready", code, message });
}

function setWarning(
  findings: MutableFindings,
  code: FindingCode,
  message: string,
  remediation: string,
): void {
  findings.set(code, { severity: "warning", code, message, remediation });
}

function setBlocker(
  findings: MutableFindings,
  code: FindingCode,
  message: string,
  remediation: string,
): void {
  findings.set(code, { severity: "blocker", code, message, remediation });
}

function isContained(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("uid unavailable");
  return uid;
}

function normalizeMode(mode: number): "0600" | "0644" | "0755" {
  const normalized = mode & 0o777;
  if (normalized === 0o600) return "0600";
  if (normalized === 0o644) return "0644";
  if (normalized === 0o755) return "0755";
  throw new Error("invalid mode");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
