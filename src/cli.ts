#!/usr/bin/env node
/// <reference types="node" />

import { realpath } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { PRODUCT_VERSION } from "./constants.js";
import { runDoctor } from "./commands/doctor.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand, writeLine, type CommandIO } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { resolveRuntimePaths } from "./runtime/paths.js";

const usage = {
  doctor: "andrew-agent doctor",
  run: "andrew-agent run <repository> <prompt>",
  resume: "andrew-agent resume <thread-id> [prompt]",
  status: "andrew-agent status [thread-id]",
} as const;

type PublicCommand = keyof typeof usage;
type ExitCode = number;

interface CommandHandlers {
  readonly doctor: (io: CommandIO) => Promise<ExitCode>;
  readonly run: (
    repository: string,
    prompt: string,
    io: CommandIO,
  ) => Promise<ExitCode>;
  readonly resume: (
    threadId: string,
    prompt: string | undefined,
    io: CommandIO,
  ) => Promise<ExitCode>;
  readonly status: (
    threadId: string | undefined,
    io: CommandIO,
  ) => Promise<ExitCode>;
}

interface MainOptions extends CommandIO {
  readonly handlers?: CommandHandlers;
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
    if (
      optionRegion.some(
        (argument) =>
          argument.startsWith("-") &&
          argument !== "-h" &&
          argument !== "--help",
      )
    )
      return await usageFailure(io);
    let parsed;
    try {
      parsed = parseArgs({
        args: [...commandArguments],
        allowPositionals: true,
        strict: true,
        options: { help: { type: "boolean", short: "h" } },
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
    if (command === "doctor") return await handlers.doctor(io);
    if (command === "run")
      return await handlers.run(positionals[0]!, positionals[1]!, io);
    if (command === "resume")
      return await handlers.resume(positionals[0]!, positionals[1], io);
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

async function doctorCommand(io: CommandIO): Promise<number> {
  try {
    const paths = await resolveRuntimePaths();
    const result = await runDoctor({
      productVersion: PRODUCT_VERSION,
      platform: process.platform,
      platformVersion: release(),
      paths,
      builderVersion: PRODUCT_VERSION,
      requestedCapabilities: [],
      capabilityInputs: {},
      scratchParent: await realpath(tmpdir()),
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
