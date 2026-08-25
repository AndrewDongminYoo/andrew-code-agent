#!/usr/bin/env node
/// <reference types="node" />

import { realpath } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  PRODUCT_VERSION,
  SUPPORTED_CAPABILITIES,
  type RequestedCapability,
} from "./constants.js";
import { runDoctor } from "./commands/doctor.js";
import { resumeCommand } from "./commands/resume.js";
import {
  runCommand,
  writeLine,
  type CommandDependencies,
  type CommandIO,
} from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime/paths.js";

const usage = {
  doctor: "andrew-agent doctor",
  run: "andrew-agent run <repository> <prompt>",
  resume: "andrew-agent resume <thread-id> [prompt]",
  status: "andrew-agent status [thread-id]",
} as const;

type PublicCommand = keyof typeof usage;
type ExitCode = number;

// Only `run` and `resume` take the flag. The option region is closed to
// anything dash-prefixed, so the two accepted spellings are matched exactly
// rather than by prefix, which would also admit `--capabilityx`.
// That exactness is defence in depth and is not observable on its own:
// `parseArgs` runs in strict mode behind this guard and rejects an undeclared
// option with the same exit code, so no test can separate the two forms.
const CAPABILITY_FLAG = "--capability";
const CAPABILITY_ASSIGNMENT = `${CAPABILITY_FLAG}=`;

// The handler shapes mirror `runCommand` and `resumeCommand`, whose fourth
// parameter is the dependency-injection seam the integration tests substitute.
// The CLI never supplies one and passes `undefined` so the callee's default
// applies, but the type says what the functions actually accept.
interface CommandHandlers {
  readonly doctor: (io: CommandIO, env: NodeJS.ProcessEnv) => Promise<ExitCode>;
  readonly run: (
    repository: string,
    prompt: string,
    io: CommandIO,
    dependencies: CommandDependencies | undefined,
    capabilities: readonly RequestedCapability[],
  ) => Promise<ExitCode>;
  readonly resume: (
    threadId: string,
    prompt: string | undefined,
    io: CommandIO,
    dependencies: CommandDependencies | undefined,
    capabilities: readonly RequestedCapability[],
  ) => Promise<ExitCode>;
  readonly status: (
    threadId: string | undefined,
    io: CommandIO,
  ) => Promise<ExitCode>;
}

interface MainOptions extends CommandIO {
  readonly handlers?: CommandHandlers;
  readonly env?: NodeJS.ProcessEnv;
}

const defaultHandlers: CommandHandlers = {
  doctor: doctorCommand,
  run: runCommand,
  resume: resumeCommand,
  status: statusCommand,
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  options: MainOptions = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const io: CommandIO = {
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  };
  const handlers = options.handlers ?? defaultHandlers;
  const env = options.env ?? process.env;
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
      await topLevelHelp(io);
      return 0;
    }
    const command = argv[0];
    if (!isPublicCommand(command)) return await usageFailure(io);
    const commandArguments = argv.slice(1);
    const separatorIndex = commandArguments.indexOf("--");
    const optionRegion =
      separatorIndex < 0
        ? commandArguments
        : commandArguments.slice(0, separatorIndex);
    if (optionRegion.some((argument) => !isAllowedOption(argument)))
      return await usageFailure(io);
    let parsed;
    try {
      parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        strict: true,
        options: {
          help: { type: "boolean", short: "h" },
          capability: { type: "string", multiple: true },
        },
      });
    } catch {
      return await usageFailure(io);
    }
    if (parsed.values.help === true) {
      if (parsed.positionals.length !== 0) return await usageFailure(io);
      await writeLine(io.stdout, `Usage: ${usage[command]}`);
      return 0;
    }
    const positionals = parsed.positionals;
    if (!validPositionals(command, positionals)) return await usageFailure(io);
    const capabilities = readCapabilities(command, parsed.values.capability);
    if (capabilities === undefined) return await usageFailure(io);
    const missingInput = missingCapabilityInput(capabilities, env);
    if (missingInput !== undefined) {
      await writeLine(
        io.stderr,
        `Capability preparation failed: ${missingInput}.`,
      );
      return 3;
    }
    if (command === "doctor") return await handlers.doctor(io, env);
    // ponytail: the requested set reaches the handler and is ignored there
    // until step 2 of docs/plans/2026-08-25-v0.2-oracle-capability.md threads
    // it into prepareCandidate. Parsing it is not yet enabling it.
    if (command === "run")
      return await handlers.run(
        positionals[0]!,
        positionals[1]!,
        io,
        undefined,
        capabilities,
      );
    if (command === "resume")
      return await handlers.resume(
        positionals[0]!,
        positionals[1],
        io,
        undefined,
        capabilities,
      );
    return await handlers.status(positionals[0], io);
  } catch {
    try {
      await writeLine(io.stderr, "Command failed.");
    } catch {
      // There is no safe secondary output channel after stderr fails.
    }
    return 1;
  }
}

// Doctor reports what a run would get, so it evaluates the capability the
// environment offers rather than assuming none. It must not become harder to
// run than the thing it diagnoses: an Oracle root that cannot be resolved
// leaves the base paths and lets `runDoctor` report the capability as absent,
// instead of failing the whole command.
async function doctorPaths(
  env: NodeJS.ProcessEnv,
  dependencies: DoctorCommandDependencies,
): Promise<{
  paths: RuntimePaths;
  capabilities: readonly RequestedCapability[];
}> {
  if ((env.ANDREW_AGENT_ORACLE_ROOT ?? "") !== "") {
    try {
      return {
        paths: await dependencies.resolveRuntimePaths({
          capabilities: ["oracle"],
        }),
        capabilities: ["oracle"],
      };
    } catch {
      // Fall through to the base paths below and report rather than abort.
    }
  }
  return { paths: await dependencies.resolveRuntimePaths(), capabilities: [] };
}

// The same substitution seam `run` and `resume` take, so the capability
// evaluation above can be exercised without a real state tree.
export interface DoctorCommandDependencies {
  readonly resolveRuntimePaths: typeof resolveRuntimePaths;
  readonly runDoctor: typeof runDoctor;
  readonly realpath: typeof realpath;
}

const defaultDoctorDependencies: DoctorCommandDependencies = {
  resolveRuntimePaths,
  runDoctor,
  realpath,
};

export async function doctorCommand(
  io: CommandIO,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorCommandDependencies = defaultDoctorDependencies,
): Promise<number> {
  try {
    const { paths, capabilities } = await doctorPaths(env, dependencies);
    const result = await dependencies.runDoctor({
      productVersion: PRODUCT_VERSION,
      platform: process.platform,
      platformVersion: release(),
      paths,
      builderVersion: PRODUCT_VERSION,
      requestedCapabilities: capabilities,
      capabilityInputs:
        paths.oracleRoot === undefined
          ? {}
          : { oracle: { llmWikiRoot: paths.oracleRoot } },
      scratchParent: await dependencies.realpath(tmpdir()),
      commandTimeoutMs: 10_000,
    });
    for (const finding of result.findings) {
      await writeLine(
        io.stdout,
        `${finding.severity} ${finding.code}: ${finding.message}`,
      );
      if (finding.remediation !== undefined) {
        await writeLine(io.stdout, `Remediation: ${finding.remediation}`);
      }
    }
    return result.exitCode;
  } catch {
    await writeLine(io.stderr, "Doctor preflight failed.");
    return 3;
  }
}

function isAllowedOption(argument: string): boolean {
  if (!argument.startsWith("-")) return true;
  return (
    argument === "-h" ||
    argument === "--help" ||
    argument === CAPABILITY_FLAG ||
    argument.startsWith(CAPABILITY_ASSIGNMENT)
  );
}

// Returns the sorted unique requested set, or undefined when the request is
// not expressible: an unsupported name, or the flag on a command that takes
// none. Both are grammar failures, so the caller reports the usage code.
//
// `resume` accepts it again now that it has a recorded set to compare against:
// a flag there can only agree with what the thread was granted, never widen
// it. It was refused between steps 1 and 3 precisely because that comparison
// did not exist yet.
function readCapabilities(
  command: PublicCommand,
  requested: readonly string[] | undefined,
): readonly RequestedCapability[] | undefined {
  if (requested === undefined) return [];
  if (command !== "run" && command !== "resume") return undefined;
  if (!requested.every(isSupportedCapability)) return undefined;
  return [...new Set(requested)].sort();
}

function isSupportedCapability(value: string): value is RequestedCapability {
  return (SUPPORTED_CAPABILITIES as readonly string[]).includes(value);
}

// A capability whose declared input is absent fails by name rather than being
// dropped, so an operator never gets a quiet run without what they asked for.
// Only presence is decided here; canonicalizing the root is runtime-path work.
function missingCapabilityInput(
  capabilities: readonly RequestedCapability[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (
    capabilities.includes("oracle") &&
    (env.ANDREW_AGENT_ORACLE_ROOT ?? "") === ""
  ) {
    return "ORACLE_ROOT_UNSET";
  }
  return undefined;
}

function validPositionals(
  command: PublicCommand,
  positionals: readonly string[],
): boolean {
  if (positionals.some((value) => value.length === 0)) return false;
  if (command === "doctor") return positionals.length === 0;
  if (command === "run") return positionals.length === 2;
  if (command === "resume")
    return positionals.length === 1 || positionals.length === 2;
  return positionals.length <= 1;
}

function isPublicCommand(value: string | undefined): value is PublicCommand {
  return value !== undefined && Object.hasOwn(usage, value);
}

async function topLevelHelp(io: CommandIO): Promise<void> {
  await writeLine(io.stdout, "Usage:");
  await writeLine(io.stdout, usage.doctor);
  await writeLine(io.stdout, usage.run);
  await writeLine(io.stdout, usage.resume);
  await writeLine(io.stdout, usage.status);
}

async function usageFailure(io: CommandIO): Promise<2> {
  await writeLine(io.stderr, "Invalid command usage.");
  return 2;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await main();
}
