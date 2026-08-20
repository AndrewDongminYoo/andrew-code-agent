import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcTransport {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
  notify(method: string, params: unknown): Promise<void>;
  respond(id: string | number, result: unknown): Promise<void>;
  onNotification(listener: (message: unknown) => void): () => void;
  onRequest(listener: (message: unknown) => void): () => void;
  close(): Promise<void>;
}

export type AppServerErrorCode =
  | "CODEX_VERSION_MISMATCH"
  | "APP_SERVER_START_FAILED"
  | "APP_SERVER_HANDSHAKE_TIMEOUT"
  | "APP_SERVER_REQUEST_TIMEOUT"
  | "MALFORMED_PROTOCOL"
  | "DUPLICATE_RESPONSE_ID"
  | "ORPHAN_RESPONSE_ID"
  | "APP_SERVER_REMOTE_ERROR"
  | "APP_SERVER_UNEXPECTED_EXIT"
  | "APP_SERVER_CLOSED"
  | "THREAD_REQUEST_BEFORE_HANDSHAKE";

interface SafeDiagnostics {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrRetainedBytes: number;
  stderrTruncated: boolean;
}

const ERROR_MESSAGES: Record<AppServerErrorCode, string> = {
  CODEX_VERSION_MISMATCH:
    "The resolved Codex version does not match the required version.",
  APP_SERVER_START_FAILED: "The Codex App Server could not be started.",
  APP_SERVER_HANDSHAKE_TIMEOUT: "The Codex App Server handshake timed out.",
  APP_SERVER_REQUEST_TIMEOUT: "A Codex App Server request timed out.",
  MALFORMED_PROTOCOL: "The Codex App Server sent a malformed protocol message.",
  DUPLICATE_RESPONSE_ID:
    "The Codex App Server repeated a completed response identifier.",
  ORPHAN_RESPONSE_ID:
    "The Codex App Server sent an unissued response identifier.",
  APP_SERVER_REMOTE_ERROR: "The Codex App Server rejected the request.",
  APP_SERVER_UNEXPECTED_EXIT: "The Codex App Server exited unexpectedly.",
  APP_SERVER_CLOSED: "The Codex App Server connection is closed.",
  THREAD_REQUEST_BEFORE_HANDSHAKE:
    "Thread requests require a completed App Server handshake.",
};

export class AppServerError extends Error {
  readonly code: AppServerErrorCode;
  private readonly diagnostics: SafeDiagnostics;

  constructor(code: AppServerErrorCode, diagnostics?: SafeDiagnostics) {
    super(ERROR_MESSAGES[code]);
    this.name = "AppServerError";
    this.code = code;
    this.diagnostics = diagnostics ?? {
      stderrRetainedBytes: 0,
      stderrTruncated: false,
    };
  }

  get exitCode(): number | null | undefined {
    return this.diagnostics.exitCode;
  }

  get signal(): NodeJS.Signals | null | undefined {
    return this.diagnostics.signal;
  }

  get stderrRetainedBytes(): number {
    return this.diagnostics.stderrRetainedBytes;
  }

  get stderrTruncated(): boolean {
    return this.diagnostics.stderrTruncated;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppServerError) => void;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isRemoteError(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly completed = new Set<string | number>();
  private readonly inboundPending = new Set<string | number>();
  private readonly inboundCompleted = new Set<string | number>();
  private readonly notificationListeners = new Set<
    (message: unknown) => void
  >();
  private readonly requestListeners = new Set<(message: unknown) => void>();
  private readonly diagnostics: SafeDiagnostics = {
    stderrRetainedBytes: 0,
    stderrTruncated: false,
  };
  private nextId = 1;
  private stdoutBuffer = "";
  private ready = false;
  private firstFailure: AppServerError | undefined;
  private closePromise: Promise<void> | undefined;
  private childExited = false;
  private resolveChildExited!: () => void;
  private readonly childExitedPromise: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams, requestTimeoutMs: number) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.childExitedPromise = new Promise((resolve) => {
      this.resolveChildExited = resolve;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) =>
      this.accountStderr(chunk.length),
    );
    child.once("error", () => {
      this.markChildExited();
      this.fail(
        new AppServerError("APP_SERVER_START_FAILED", this.diagnostics),
      );
    });
    child.once("exit", (exitCode, signal) => {
      this.diagnostics.exitCode = exitCode;
      this.diagnostics.signal = signal;
      this.markChildExited();
      if (this.stdoutBuffer.length > 0 && !this.firstFailure) {
        this.fail(new AppServerError("MALFORMED_PROTOCOL", this.diagnostics));
      } else if (!this.closePromise && !this.firstFailure) {
        this.fail(
          new AppServerError("APP_SERVER_UNEXPECTED_EXIT", this.diagnostics),
        );
      }
    });
  }

  markReady(): void {
    if (!this.firstFailure && !this.closePromise) this.ready = true;
  }

  request<TResult>(method: string, params: unknown): Promise<TResult> {
    return this.requestWithTimeout<TResult>(
      method,
      params,
      this.requestTimeoutMs,
      "APP_SERVER_REQUEST_TIMEOUT",
    );
  }

  requestWithTimeout<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutCode: AppServerErrorCode,
  ): Promise<TResult> {
    if (this.firstFailure) return Promise.reject(this.firstFailure);
    if (this.closePromise)
      return Promise.reject(
        new AppServerError("APP_SERVER_CLOSED", this.diagnostics),
      );
    if (!this.ready && method !== "initialize") {
      return Promise.reject(
        new AppServerError("THREAD_REQUEST_BEFORE_HANDSHAKE", this.diagnostics),
      );
    }
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new AppServerError(timeoutCode, this.diagnostics));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
      this.write({ method, id, params }).catch(() => {
        this.fail(
          new AppServerError("APP_SERVER_START_FAILED", this.diagnostics),
        );
      });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.firstFailure) throw this.firstFailure;
    if (this.closePromise)
      throw new AppServerError("APP_SERVER_CLOSED", this.diagnostics);
    if (!this.ready && method !== "initialized") {
      throw new AppServerError(
        "THREAD_REQUEST_BEFORE_HANDSHAKE",
        this.diagnostics,
      );
    }
    const message = params === undefined ? { method } : { method, params };
    await this.writeOrFail(message);
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    if (this.firstFailure) throw this.firstFailure;
    if (this.closePromise)
      throw new AppServerError("APP_SERVER_CLOSED", this.diagnostics);
    if (this.inboundCompleted.has(id)) {
      throw new AppServerError("DUPLICATE_RESPONSE_ID", this.diagnostics);
    }
    if (!this.inboundPending.has(id)) {
      throw new AppServerError("ORPHAN_RESPONSE_ID", this.diagnostics);
    }
    let serialized: string;
    try {
      const candidate = JSON.stringify({ id, result });
      if (candidate === undefined) throw new Error();
      const envelope: unknown = JSON.parse(candidate);
      if (!isRecord(envelope) || !Object.hasOwn(envelope, "result"))
        throw new Error();
      serialized = candidate;
    } catch {
      throw new AppServerError("MALFORMED_PROTOCOL", this.diagnostics);
    }
    this.inboundPending.delete(id);
    this.inboundCompleted.add(id);
    try {
      await this.writeSerialized(serialized);
    } catch {
      const error = new AppServerError(
        "APP_SERVER_START_FAILED",
        this.diagnostics,
      );
      this.fail(error);
      throw this.firstFailure ?? error;
    }
  }

  onNotification(listener: (message: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (message: unknown) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closed = new AppServerError("APP_SERVER_CLOSED", this.diagnostics);
    this.closePromise = this.shutdown();
    this.rejectPending(closed);
    return this.closePromise;
  }

  private accountStderr(byteLength: number): void {
    const remaining = 65_536 - this.diagnostics.stderrRetainedBytes;
    this.diagnostics.stderrRetainedBytes += Math.min(remaining, byteLength);
    if (byteLength > remaining) this.diagnostics.stderrTruncated = true;
  }

  private consumeStdout(chunk: string): void {
    if (this.firstFailure || this.closePromise) return;
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new AppServerError("MALFORMED_PROTOCOL", this.diagnostics));
        return;
      }
      if (!this.handleMessage(message)) return;
    }
  }

  private handleMessage(message: unknown): boolean {
    if (!isRecord(message)) return this.protocolFailure("MALFORMED_PROTOCOL");
    if (Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) {
      if (
        !isRequestId(message.id) ||
        typeof message.method !== "string" ||
        !Object.hasOwn(message, "params")
      ) {
        return this.protocolFailure("MALFORMED_PROTOCOL");
      }
      if (this.requestListeners.size === 0)
        return this.protocolFailure("MALFORMED_PROTOCOL");
      if (
        this.inboundPending.has(message.id) ||
        this.inboundCompleted.has(message.id)
      ) {
        return this.protocolFailure("DUPLICATE_RESPONSE_ID");
      }
      this.inboundPending.add(message.id);
      return this.dispatch(this.requestListeners, message);
    }
    if (Object.hasOwn(message, "id")) return this.handleResponse(message);
    if (
      typeof message.method === "string" &&
      !Object.hasOwn(message, "result") &&
      !Object.hasOwn(message, "error")
    ) {
      return this.dispatch(this.notificationListeners, message);
    }
    return this.protocolFailure("MALFORMED_PROTOCOL");
  }

  private handleResponse(message: Record<string, unknown>): boolean {
    const id = message.id;
    if (!isRequestId(id)) return this.protocolFailure("MALFORMED_PROTOCOL");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError || (hasError && !isRemoteError(message.error))) {
      return this.protocolFailure("MALFORMED_PROTOCOL");
    }
    if (this.completed.has(id))
      return this.protocolFailure("DUPLICATE_RESPONSE_ID");
    const pending = this.pending.get(id);
    if (!pending) return this.protocolFailure("ORPHAN_RESPONSE_ID");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.completed.add(id);
    if (hasError)
      pending.reject(
        new AppServerError("APP_SERVER_REMOTE_ERROR", this.diagnostics),
      );
    else pending.resolve(message.result);
    return true;
  }

  private dispatch(
    listeners: Set<(message: unknown) => void>,
    message: unknown,
  ): boolean {
    try {
      for (const listener of listeners) {
        const result: unknown = listener(message);
        void Promise.resolve(result).catch(() => {
          this.fail(new AppServerError("MALFORMED_PROTOCOL", this.diagnostics));
        });
      }
      return true;
    } catch {
      return this.protocolFailure("MALFORMED_PROTOCOL");
    }
  }

  private protocolFailure(code: AppServerErrorCode): false {
    this.fail(new AppServerError(code, this.diagnostics));
    return false;
  }

  private fail(error: AppServerError): void {
    if (this.firstFailure || this.closePromise) return;
    this.firstFailure = error;
    this.closePromise = this.shutdown();
    this.rejectPending(error);
  }

  private rejectPending(error: AppServerError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(message: unknown): Promise<void> {
    return this.writeSerialized(JSON.stringify(message));
  }

  private writeSerialized(serialized: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${serialized}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async writeOrFail(message: unknown): Promise<void> {
    try {
      await this.write(message);
    } catch {
      const error = new AppServerError(
        "APP_SERVER_START_FAILED",
        this.diagnostics,
      );
      this.fail(error);
      throw this.firstFailure ?? error;
    }
  }

  private markChildExited(): void {
    if (this.childExited) return;
    this.childExited = true;
    this.resolveChildExited();
  }

  private async shutdown(): Promise<void> {
    if (this.childExited) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const terminated = await Promise.race([
      this.childExitedPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    if (!terminated && !this.childExited) this.child.kill("SIGKILL");
    await this.childExitedPromise;
  }
}
