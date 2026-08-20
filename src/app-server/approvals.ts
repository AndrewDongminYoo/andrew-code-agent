export interface ApprovalAuditRecord {
  readonly requestId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly method: string;
  readonly decision: string;
}

export type ApprovalOutcome =
  | {
      readonly kind: "response";
      readonly decision: string;
      readonly acceptedForSession: boolean;
      readonly response: unknown;
      readonly audit: ApprovalAuditRecord;
    }
  | {
      readonly kind: "failClosed";
      readonly decision: "decline";
      readonly acceptedForSession: false;
      readonly code: "UNKNOWN_SERVER_REQUEST" | "MALFORMED_APPROVAL_REQUEST";
      readonly audit: ApprovalAuditRecord;
    };

const MAX_PROMPT_TEXT = 512;
const MAX_LINE_LENGTH = 32;
const TRUNCATION_MARKER = " [truncated]";

type RecordValue = Record<string, unknown>;
type KnownMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "mcpServer/elicitation/request";

interface ValidRequest {
  readonly method: KnownMethod;
  readonly id: string;
  readonly params: RecordValue;
  readonly audit: Omit<ApprovalAuditRecord, "decision">;
}

interface Choice {
  readonly id: string;
  readonly label: string;
  readonly decision: string;
  readonly acceptedForSession: boolean;
  readonly response: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string): string {
  return value.length <= MAX_PROMPT_TEXT
    ? value
    : `${value.slice(0, MAX_PROMPT_TEXT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? bounded(value) : null;
}

function auditFrom(request: unknown, decision: string): ApprovalAuditRecord {
  const envelope = isRecord(request) ? request : {};
  const params = isRecord(envelope.params) ? envelope.params : {};
  return {
    requestId:
      typeof envelope.id === "string" || typeof envelope.id === "number"
        ? bounded(String(envelope.id))
        : "<invalid>",
    threadId: stringOrNull(params.threadId),
    turnId: stringOrNull(params.turnId),
    itemId: stringOrNull(params.itemId),
    method:
      typeof envelope.method === "string"
        ? bounded(envelope.method)
        : "<invalid>",
    decision,
  };
}

function failClosed(
  request: unknown,
  code: "UNKNOWN_SERVER_REQUEST" | "MALFORMED_APPROVAL_REQUEST",
): ApprovalOutcome {
  return {
    kind: "failClosed",
    decision: "decline",
    acceptedForSession: false,
    code,
    audit: auditFrom(request, "decline"),
  };
}

function validate(request: unknown): ValidRequest | ApprovalOutcome {
  if (
    !isRecord(request) ||
    typeof request.method !== "string" ||
    (typeof request.id !== "string" && typeof request.id !== "number")
  )
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  const supported: readonly KnownMethod[] = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
  ];
  if (!supported.includes(request.method as KnownMethod))
    return failClosed(request, "UNKNOWN_SERVER_REQUEST");
  if (!isRecord(request.params))
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  const params = request.params;
  if (typeof params.threadId !== "string")
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  if (
    request.method !== "mcpServer/elicitation/request" &&
    (typeof params.startedAtMs !== "number" ||
      !Number.isFinite(params.startedAtMs))
  )
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  if (request.method === "mcpServer/elicitation/request") {
    if (
      (params.turnId !== null && typeof params.turnId !== "string") ||
      typeof params.serverName !== "string" ||
      typeof params.mode !== "string" ||
      typeof params.message !== "string"
    )
      return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  } else if (
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string"
  ) {
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  } else if (
    request.method === "item/commandExecution/requestApproval" &&
    params.environmentId !== null &&
    typeof params.environmentId !== "string"
  ) {
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  } else if (
    request.method === "item/fileChange/requestApproval" &&
    params.reason !== undefined &&
    params.reason !== null &&
    typeof params.reason !== "string"
  ) {
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  } else if (
    request.method === "item/permissions/requestApproval" &&
    (typeof params.cwd !== "string" ||
      (params.environmentId !== null &&
        typeof params.environmentId !== "string") ||
      (params.reason !== null && typeof params.reason !== "string") ||
      !isRecord(params.permissions))
  ) {
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  }
  return {
    method: request.method as KnownMethod,
    id: bounded(String(request.id)),
    params,
    audit: auditFrom(request, ""),
  };
}

function response(request: ValidRequest, choice: Choice): ApprovalOutcome {
  return {
    kind: "response",
    decision: choice.decision,
    acceptedForSession: choice.acceptedForSession,
    response: choice.response,
    audit: { ...request.audit, decision: choice.decision },
  };
}

function safest(request: ValidRequest): ApprovalOutcome {
  if (request.method === "mcpServer/elicitation/request") {
    return response(request, {
      id: "",
      label: "",
      decision: "decline",
      acceptedForSession: false,
      response: { action: "decline", content: null, _meta: null },
    });
  }
  if (request.method === "item/permissions/requestApproval") {
    return response(request, {
      id: "",
      label: "",
      decision: "decline",
      acceptedForSession: false,
      response: { permissions: {}, scope: "turn" },
    });
  }
  return response(request, {
    id: "",
    label: "",
    decision: "decline",
    acceptedForSession: false,
    response: { decision: "decline" },
  });
}

function choices(request: ValidRequest): readonly Choice[] {
  if (request.method === "item/commandExecution/requestApproval") {
    const values: Choice[] = [
      {
        id: "1",
        label: "Accept",
        decision: "accept",
        acceptedForSession: false,
        response: { decision: "accept" },
      },
      {
        id: "2",
        label: "Accept for session",
        decision: "acceptForSession",
        acceptedForSession: true,
        response: { decision: "acceptForSession" },
      },
      {
        id: "3",
        label: "Decline",
        decision: "decline",
        acceptedForSession: false,
        response: { decision: "decline" },
      },
    ];
    const amendments = Array.isArray(
      request.params.proposedNetworkPolicyAmendments,
    )
      ? request.params.proposedNetworkPolicyAmendments
      : [];
    for (const amendment of amendments.slice(0, 8)) {
      if (
        !isRecord(amendment) ||
        typeof amendment.host !== "string" ||
        (amendment.action !== "allow" && amendment.action !== "deny")
      )
        continue;
      values.push({
        id: String(values.length + 1),
        label: `Apply supplied network policy for ${bounded(amendment.host)}`,
        decision: "applyNetworkPolicyAmendment",
        acceptedForSession: false,
        response: {
          decision: {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: amendment.host,
                action: amendment.action,
              },
            },
          },
        },
      });
    }
    values.push({
      id: String(values.length + 1),
      label: "Cancel",
      decision: "cancel",
      acceptedForSession: false,
      response: { decision: "cancel" },
    });
    return values;
  }
  if (request.method === "item/fileChange/requestApproval") {
    return [
      {
        id: "1",
        label: "Accept",
        decision: "accept",
        acceptedForSession: false,
        response: { decision: "accept" },
      },
      {
        id: "2",
        label: "Accept for session",
        decision: "acceptForSession",
        acceptedForSession: true,
        response: { decision: "acceptForSession" },
      },
      {
        id: "3",
        label: "Decline",
        decision: "decline",
        acceptedForSession: false,
        response: { decision: "decline" },
      },
      {
        id: "4",
        label: "Cancel",
        decision: "cancel",
        acceptedForSession: false,
        response: { decision: "cancel" },
      },
    ];
  }
  if (request.method === "item/permissions/requestApproval") {
    const permissions = request.params.permissions;
    if (!isRecord(permissions)) return [];
    return [
      {
        id: "1",
        label: "Grant requested permissions for turn",
        decision: "accept",
        acceptedForSession: false,
        response: { permissions, scope: "turn" },
      },
      {
        id: "2",
        label: "Grant requested permissions for session",
        decision: "acceptForSession",
        acceptedForSession: true,
        response: { permissions, scope: "session" },
      },
      {
        id: "3",
        label: "Decline",
        decision: "decline",
        acceptedForSession: false,
        response: { permissions: {}, scope: "turn" },
      },
    ];
  }
  return [
    {
      id: "1",
      label: "Decline",
      decision: "decline",
      acceptedForSession: false,
      response: { action: "decline", content: null, _meta: null },
    },
    {
      id: "2",
      label: "Cancel",
      decision: "cancel",
      acceptedForSession: false,
      response: { action: "cancel", content: null, _meta: null },
    },
  ];
}

function prompt(request: ValidRequest, available: readonly Choice[]): string {
  const lines = [
    `Approval: ${request.method}`,
    `Request: ${request.id}`,
    `Thread: ${request.audit.threadId ?? "none"}`,
    `Turn: ${request.audit.turnId ?? "none"}`,
    `Item: ${request.audit.itemId ?? "none"}`,
  ];
  for (const field of [
    "reason",
    "command",
    "cwd",
    "grantRoot",
    "serverName",
    "mode",
    "message",
    "url",
  ] as const) {
    const value = stringOrNull(request.params[field]);
    if (value !== null) lines.push(`${field}: ${value}`);
  }
  lines.push(
    ...available.map((choice) => `${choice.id}. ${choice.label}`),
    "Selection:",
  );
  return `${lines.join("\n")} `;
}

function writePrompt(
  output: NodeJS.WritableStream,
  value: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, retainErrorListener = false) => {
      if (settled) return;
      settled = true;
      if (!retainErrorListener) output.removeListener("error", onError);
      resolve(ok);
    };
    const onError = () => finish(false);
    output.once("error", onError);
    try {
      output.write(value, (error) => finish(!error, Boolean(error)));
    } catch {
      finish(false);
    }
  });
}

function readLine(
  input: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (line: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onEnd);
      resolve(line);
    };
    const onData = (chunk: unknown) => {
      const first = String(chunk).split(/\r?\n/, 1)[0] ?? "";
      finish(first.length <= MAX_LINE_LENGTH ? first : null);
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(
      () => finish(null),
      Math.max(1, Math.min(timeoutMs, 60_000)),
    );
    input.once("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}

export async function answerApproval(
  request: unknown,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  const valid = validate(request);
  if ("kind" in valid) return valid;
  const terminalInput = input as NodeJS.ReadableStream & { isTTY?: boolean };
  const terminalOutput = output as NodeJS.WritableStream & { isTTY?: boolean };
  if (terminalInput.isTTY !== true || terminalOutput.isTTY !== true)
    return safest(valid);
  const available = choices(valid);
  if (available.length === 0) return safest(valid);
  if (!(await writePrompt(output, prompt(valid, available))))
    return safest(valid);
  const selected = await readLine(input, timeoutMs);
  const choice = available.find((candidate) => candidate.id === selected);
  return choice ? response(valid, choice) : safest(valid);
}
