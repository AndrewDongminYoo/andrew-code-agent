import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REQUIRED_CODEX_VERSION } from "../constants.js";
import type { RequestId } from "../generated/codex-app-server/RequestId.js";
import type { ServerNotification } from "../generated/codex-app-server/ServerNotification.js";
import type { ServerRequest } from "../generated/codex-app-server/ServerRequest.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "../generated/codex-app-server/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../generated/codex-app-server/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../generated/codex-app-server/v2/TurnStartResponse.js";
import { AppServerError, StdioJsonRpcTransport } from "./transport.js";

const execFileAsync = promisify(execFile);

export interface StartAppServerInput {
  readonly codexBinary: string;
  readonly codexHome: string;
  readonly productVersion: string;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface AppServerClient {
  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  respond(id: RequestId, result: unknown): Promise<void>;
  onNotification(listener: (message: ServerNotification) => void): () => void;
  onRequest(listener: (message: ServerRequest) => void): () => void;
  close(): Promise<void>;
}

interface InitializeResponse {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  return (
    isRecord(value) &&
    typeof value.userAgent === "string" &&
    typeof value.codexHome === "string" &&
    typeof value.platformFamily === "string" &&
    typeof value.platformOs === "string"
  );
}

export async function startAppServer(
  input: StartAppServerInput,
): Promise<AppServerClient> {
  let version: string;
  try {
    const result = await execFileAsync(input.codexBinary, ["--version"], {
      env: {},
      encoding: "utf8",
      maxBuffer: 1024,
    });
    version = result.stdout.trim();
  } catch {
    throw new AppServerError("APP_SERVER_START_FAILED");
  }
  if (version !== `codex-cli ${REQUIRED_CODEX_VERSION}`)
    throw new AppServerError("CODEX_VERSION_MISMATCH");

  const { spawn } = await import("node:child_process");
  const child = spawn(
    input.codexBinary,
    ["app-server", "--strict-config", "--stdio"],
    {
      env: { CODEX_HOME: input.codexHome },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const transport = new StdioJsonRpcTransport(child, input.requestTimeoutMs);
  try {
    const initialize = await transport.requestWithTimeout<unknown>(
      "initialize",
      {
        clientInfo: {
          name: "andrew-code-agent",
          title: "Andrew Code Agent",
          version: input.productVersion,
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
      input.handshakeTimeoutMs,
      "APP_SERVER_HANDSHAKE_TIMEOUT",
    );
    if (!isInitializeResponse(initialize))
      throw new AppServerError("MALFORMED_PROTOCOL");
    await transport.notify("initialized", undefined);
    transport.markReady();
  } catch (error) {
    await transport.close();
    throw error;
  }

  return {
    threadStart: (params) =>
      transport.request<ThreadStartResponse>("thread/start", params),
    threadResume: (params) =>
      transport.request<ThreadResumeResponse>("thread/resume", params),
    turnStart: (params) =>
      transport.request<TurnStartResponse>("turn/start", params),
    respond: (id, result) => transport.respond(id, result),
    onNotification: (listener) =>
      transport.onNotification((message) =>
        listener(message as ServerNotification),
      ),
    onRequest: (listener) =>
      transport.onRequest((message) => listener(message as ServerRequest)),
    close: () => transport.close(),
  };
}
