/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const maxGitOutputBytes = 16 * 1024 * 1024;

export type GitProcessErrorCode = "GIT_OUTPUT_TOO_LARGE";

export class GitProcessError extends Error {
  readonly code: GitProcessErrorCode;

  constructor(code: GitProcessErrorCode, message: string) {
    super(message);
    this.name = "GitProcessError";
    this.code = code;
  }
}

export async function executeGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      // v0.1 bounds each captured stream; larger output requires future streaming support.
      maxBuffer: maxGitOutputBytes,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        LANG: "C",
        LC_ALL: "C",
      },
    });
    return stdout;
  } catch (error) {
    if (isMaxBufferError(error)) {
      throw new GitProcessError(
        "GIT_OUTPUT_TOO_LARGE",
        "Git command output exceeds the v0.1 limit.",
      );
    }
    throw error;
  }
}

function isMaxBufferError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}
