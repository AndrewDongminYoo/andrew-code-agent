import { spawn } from "node:child_process";

// The probe exits once its stdin closes; leaving the pipe open makes it serve.
export function probeStrictConfig(codexBin, codexHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--strict-config", "--listen", "stdio://"], {
      env: { CODEX_HOME: codexHome, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the strict-config probe did not exit"));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
