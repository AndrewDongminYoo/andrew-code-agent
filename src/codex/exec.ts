/// <reference types="node" />

import { spawn } from "node:child_process";

const MAX_MODEL_OUTPUT_BYTES = 1024 * 1024;

export interface CodexExecMessages {
  readonly timeout: string;
  readonly outputLimit: string;
  readonly failed: string;
  readonly empty: string;
  readonly unexpectedItem?: string;
}

export interface CodexExecInput {
  readonly binary: string;
  readonly codexHome: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly allowedItemTypes?: readonly string[];
  readonly messages: CodexExecMessages;
}

export async function runCodexExec(input: CodexExecInput): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      detached: true,
      env: {
        CODEX_HOME: input.codexHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let stopped = false;
    let terminationError: Error | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () => terminate(new Error(input.messages.timeout)),
      input.timeoutMs,
    );
    const fail = (error: Error): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      reject(error);
    };
    const succeed = (value: string): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      resolve(value);
    };
    function terminate(error: Error): void {
      if (terminationError !== undefined || stopped) return;
      terminationError = error;
      signalProcessGroup(child.pid, "SIGTERM");
      stopTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
        fail(error);
      }, 500);
    }
    const append = (current: string, chunk: string): string => {
      if (overflow) return current;
      const next = current + chunk;
      if (Buffer.byteLength(next) > MAX_MODEL_OUTPUT_BYTES) {
        overflow = true;
        terminate(new Error(input.messages.outputLimit));
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.stdin.on("error", () => {
      terminate(new Error(input.messages.failed));
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (terminationError !== undefined) {
        signalProcessGroup(child.pid, "SIGKILL");
        return fail(terminationError);
      }
      if (overflow) return fail(new Error(input.messages.outputLimit));
      if (code !== 0) return fail(new Error(input.messages.failed));
      let lastMessage = "";
      let completed = false;
      try {
        for (const line of stdout.split("\n")) {
          if (line === "") continue;
          const event: unknown = JSON.parse(line);
          if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event)
          )
            continue;
          const entry = event as {
            type?: unknown;
            item?: { type?: unknown; text?: unknown };
          };
          if (entry.type === "turn.completed") completed = true;
          if (
            entry.type === "item.completed" &&
            entry.item?.type === "agent_message" &&
            typeof entry.item.text === "string"
          )
            lastMessage = entry.item.text;
          if (
            input.allowedItemTypes !== undefined &&
            (entry.type === "item.started" ||
              entry.type === "item.completed") &&
            !input.allowedItemTypes.includes(String(entry.item?.type))
          )
            throw new Error(
              input.messages.unexpectedItem ?? input.messages.failed,
            );
        }
      } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
      }
      if (!completed || lastMessage === "")
        return fail(new Error(input.messages.empty));
      succeed(lastMessage);
    });
    child.stdin.end(input.prompt);
  });
}

function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The isolated process group may have already exited.
  }
}
