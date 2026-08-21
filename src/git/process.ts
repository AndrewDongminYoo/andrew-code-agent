/// <reference types="node" />

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function executeGit(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
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
}
