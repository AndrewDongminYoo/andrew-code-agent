import { isProxy } from "node:util/types";

import {
  escapeTerminalControls,
  fitsEscapedTerminalBytes,
} from "./terminal.js";

export interface ApprovalAuditRecord {
  readonly requestId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly method: string;
  readonly decision: string;
}

export interface ApprovalCorrelation {
  readonly method: string;
  readonly threadId: string;
  readonly turnId: string | null;
}

export type ApprovalOutcome =
  | {
      readonly kind: "response";
      readonly decision: string;
      readonly acceptedForSession: boolean;
      readonly response: unknown;
      readonly audit: ApprovalAuditRecord;
      readonly correlation: ApprovalCorrelation;
    }
  | {
      readonly kind: "failClosed";
      readonly decision: "decline";
      readonly acceptedForSession: false;
      readonly code: "UNKNOWN_SERVER_REQUEST" | "MALFORMED_APPROVAL_REQUEST";
      readonly audit: ApprovalAuditRecord;
    };

export interface ApprovalPromptWriter {
  writePrompt(value: string, signal: AbortSignal): Promise<void>;
}

const MAX_AUDIT_BYTES = 256;
const MAX_FIELD_BYTES = 256;
const MAX_PROMPT_BYTES = 8192;
const MAX_LINE_BYTES = 64;
const MAX_CHOICE_LABEL_BYTES = 96;
const MAX_APPROVAL_LIST_ITEMS = 8;
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
  readonly correlation: ApprovalCorrelation;
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
function boundedBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let result = "";
  for (const part of value) {
    if (Buffer.byteLength(result + part + TRUNCATION_MARKER, "utf8") > limit)
      break;
    result += part;
  }
  return `${result}${TRUNCATION_MARKER}`;
}
function bounded(value: string): string {
  return boundedBytes(value, MAX_FIELD_BYTES);
}
function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function requiredString(value: RecordValue, key: string): boolean {
  return typeof value[key] === "string";
}
function validRequestId(value: unknown): value is string | number {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validCommandAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "read")
    return (
      hasOnlyKeys(value, ["type", "command", "name", "path"]) &&
      requiredString(value, "command") &&
      requiredString(value, "name") &&
      requiredString(value, "path")
    );
  if (value.type === "listFiles")
    return (
      hasOnlyKeys(value, ["type", "command", "path"]) &&
      requiredString(value, "command") &&
      nullableString(value.path)
    );
  if (value.type === "search")
    return (
      hasOnlyKeys(value, ["type", "command", "query", "path"]) &&
      requiredString(value, "command") &&
      nullableString(value.query) &&
      nullableString(value.path)
    );
  return (
    value.type === "unknown" &&
    hasOnlyKeys(value, ["type", "command"]) &&
    requiredString(value, "command")
  );
}

function validJson(
  value: unknown,
  depth = 0,
  active = new WeakSet<object>(),
): boolean {
  try {
    if (depth > 32) return false;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (isProxy(value)) return false;
    const array = Array.isArray(value);
    if (
      (array && Object.getPrototypeOf(value) !== Array.prototype) ||
      (!array &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      active.has(value)
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(value);
    if (
      array
        ? names.length !== value.length + 1 ||
          names.some(
            (name) =>
              name !== "length" &&
              (!Number.isSafeInteger(Number(name)) ||
                Number(name) < 0 ||
                Number(name) >= value.length ||
                String(Number(name)) !== name),
          )
        : names.some((name) => !descriptors[name]?.enumerable)
    )
      return false;
    active.add(value);
    try {
      return names.every((name) => {
        if (name === "length") return true;
        const descriptor = descriptors[name];
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          validJson(descriptor.value, depth + 1, active)
        );
      });
    } finally {
      active.delete(value);
    }
  } catch {
    return false;
  }
}

function boundedSchemaString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_FIELD_BYTES
  );
}

function optionalNullableSchemaString(
  value: RecordValue,
  key: string,
): boolean {
  return (
    !(key in value) || value[key] === null || boundedSchemaString(value[key])
  );
}

function validStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_APPROVAL_LIST_ITEMS &&
    value.every(boundedSchemaString)
  );
}

function validConstOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["const", "title"]) &&
    boundedSchemaString(value.const) &&
    boundedSchemaString(value.title)
  );
}

function validSchemaInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validMcpPrimitiveSchema(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !optionalNullableSchemaString(value, "title") ||
    !optionalNullableSchemaString(value, "description")
  )
    return false;
  if (value.type === "boolean")
    return (
      hasOnlyKeys(value, ["type", "title", "description", "default"]) &&
      (!("default" in value) ||
        value.default === null ||
        typeof value.default === "boolean")
    );
  if (value.type === "number" || value.type === "integer")
    return (
      hasOnlyKeys(value, [
        "type",
        "title",
        "description",
        "minimum",
        "maximum",
        "default",
      ]) &&
      ["minimum", "maximum", "default"].every(
        (key) =>
          !(key in value) ||
          value[key] === null ||
          (typeof value[key] === "number" && Number.isFinite(value[key])),
      )
    );
  if (value.type === "string") {
    if ("oneOf" in value)
      return (
        hasOnlyKeys(value, [
          "type",
          "title",
          "description",
          "oneOf",
          "default",
        ]) &&
        Array.isArray(value.oneOf) &&
        value.oneOf.length <= MAX_APPROVAL_LIST_ITEMS &&
        value.oneOf.every(validConstOption) &&
        (!("default" in value) ||
          value.default === null ||
          boundedSchemaString(value.default))
      );
    if ("enum" in value)
      return (
        hasOnlyKeys(value, [
          "type",
          "title",
          "description",
          "enum",
          "enumNames",
          "default",
        ]) &&
        validStringList(value.enum) &&
        (!("enumNames" in value) ||
          value.enumNames === null ||
          (validStringList(value.enumNames) &&
            value.enumNames.length === value.enum.length)) &&
        (!("default" in value) ||
          value.default === null ||
          boundedSchemaString(value.default))
      );
    return (
      hasOnlyKeys(value, [
        "type",
        "title",
        "description",
        "minLength",
        "maxLength",
        "format",
        "default",
      ]) &&
      (!("minLength" in value) ||
        value.minLength === null ||
        validSchemaInteger(value.minLength)) &&
      (!("maxLength" in value) ||
        value.maxLength === null ||
        validSchemaInteger(value.maxLength)) &&
      (!("format" in value) ||
        value.format === null ||
        ["email", "uri", "date", "date-time"].includes(
          value.format as string,
        )) &&
      (!("default" in value) ||
        value.default === null ||
        boundedSchemaString(value.default))
    );
  }
  if (value.type !== "array") return false;
  if (
    !hasOnlyKeys(value, [
      "type",
      "title",
      "description",
      "minItems",
      "maxItems",
      "items",
      "default",
    ]) ||
    ("minItems" in value &&
      value.minItems !== null &&
      !validSchemaInteger(value.minItems)) ||
    ("maxItems" in value &&
      value.maxItems !== null &&
      !validSchemaInteger(value.maxItems)) ||
    ("default" in value &&
      value.default !== null &&
      !validStringList(value.default)) ||
    !isRecord(value.items)
  )
    return false;
  return (
    (hasOnlyKeys(value.items, ["type", "enum"]) &&
      value.items.type === "string" &&
      validStringList(value.items.enum)) ||
    (hasOnlyKeys(value.items, ["anyOf"]) &&
      Array.isArray(value.items.anyOf) &&
      value.items.anyOf.length <= MAX_APPROVAL_LIST_ITEMS &&
      value.items.anyOf.every(validConstOption))
  );
}

function validMcpElicitationSchema(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["$schema", "type", "properties", "required"]) ||
    value.type !== "object" ||
    !isRecord(value.properties)
  )
    return false;
  const properties = value.properties;
  if (
    Object.keys(properties).length > MAX_APPROVAL_LIST_ITEMS ||
    ("$schema" in value &&
      value.$schema !== null &&
      !boundedSchemaString(value.$schema)) ||
    !Object.entries(properties).every(
      ([key, schema]) =>
        boundedSchemaString(key) && validMcpPrimitiveSchema(schema),
    )
  )
    return false;
  return (
    !("required" in value) ||
    value.required === null ||
    (validStringList(value.required) &&
      new Set(value.required).size === value.required.length &&
      value.required.every((key) => key in properties))
  );
}

function validSpecialPath(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (["root", "minimal", "tmpdir", "slash_tmp"].includes(value.kind))
    return hasOnlyKeys(value, ["kind"]);
  if (value.kind === "project_roots")
    return (
      hasOnlyKeys(value, ["kind", "subpath"]) && nullableString(value.subpath)
    );
  return (
    value.kind === "unknown" &&
    hasOnlyKeys(value, ["kind", "path", "subpath"]) &&
    requiredString(value, "path") &&
    nullableString(value.subpath)
  );
}

function validFileSystemPath(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "path")
    return (
      hasOnlyKeys(value, ["type", "path"]) && requiredString(value, "path")
    );
  if (value.type === "glob_pattern")
    return (
      hasOnlyKeys(value, ["type", "pattern"]) &&
      requiredString(value, "pattern")
    );
  return (
    value.type === "special" &&
    hasOnlyKeys(value, ["type", "value"]) &&
    validSpecialPath(value.value)
  );
}

function validFileSystemEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "access"]) &&
    validFileSystemPath(value.path) &&
    ["read", "write", "deny"].includes(value.access as string)
  );
}

function validPermissions(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["network", "fileSystem"]) ||
    !("network" in value) ||
    !("fileSystem" in value)
  )
    return false;
  if (
    value.network !== null &&
    (!isRecord(value.network) ||
      !hasOnlyKeys(value.network, ["enabled"]) ||
      !("enabled" in value.network) ||
      (value.network.enabled !== null &&
        typeof value.network.enabled !== "boolean"))
  )
    return false;
  if (value.fileSystem === null) return true;
  const fileSystem = value.fileSystem;
  return (
    isRecord(fileSystem) &&
    hasOnlyKeys(fileSystem, ["read", "write", "globScanMaxDepth", "entries"]) &&
    "read" in fileSystem &&
    "write" in fileSystem &&
    (fileSystem.read === null ||
      (Array.isArray(fileSystem.read) &&
        fileSystem.read.every((entry) => typeof entry === "string"))) &&
    (fileSystem.write === null ||
      (Array.isArray(fileSystem.write) &&
        fileSystem.write.every((entry) => typeof entry === "string"))) &&
    (!("globScanMaxDepth" in fileSystem) ||
      fileSystem.globScanMaxDepth === null ||
      (typeof fileSystem.globScanMaxDepth === "number" &&
        Number.isSafeInteger(fileSystem.globScanMaxDepth) &&
        fileSystem.globScanMaxDepth >= 1)) &&
    (!("entries" in fileSystem) ||
      fileSystem.entries === null ||
      (Array.isArray(fileSystem.entries) &&
        fileSystem.entries.every(validFileSystemEntry)))
  );
}

function validCommandParams(params: RecordValue): boolean {
  if (
    !hasOnlyKeys(params, [
      // Added by codex 0.152.1, which declares it required: it separates a
      // command from input written into an already-running terminal. Absent
      // stays valid, because the field's own documentation says older servers
      // default it to `command`, and this list is an allowlist rather than an
      // exact set.
      "kind",
      "threadId",
      "turnId",
      "itemId",
      "startedAtMs",
      "approvalId",
      "environmentId",
      "reason",
      "networkApprovalContext",
      "command",
      "cwd",
      "commandActions",
      "proposedExecpolicyAmendment",
      "proposedNetworkPolicyAmendments",
      // Sent by the pinned binary and absent from the generated params type,
      // measured against codex 0.148.0 on 2026-08-26. It names a set of
      // decisions, and that set does not bind the answer: the server accepted
      // `decline` against a set of accept, acceptWithExecpolicyAmendment and
      // cancel that omitted it, and the turn continued. So the key is allowed
      // and nothing reads it.
      "availableDecisions",
    ]) ||
    !requiredString(params, "threadId") ||
    !requiredString(params, "turnId") ||
    !requiredString(params, "itemId") ||
    !Number.isSafeInteger(params.startedAtMs) ||
    !nullableString(params.environmentId)
  )
    return false;
  // An unrecognised kind is a shape this build does not understand, and the
  // approval path answers those by refusing rather than by guessing which of
  // the two it resembles.
  if (
    params.kind !== undefined &&
    params.kind !== "command" &&
    params.kind !== "writeStdin"
  )
    return false;
  if (
    ("approvalId" in params && !nullableString(params.approvalId)) ||
    ("reason" in params && !nullableString(params.reason)) ||
    ("command" in params && !nullableString(params.command)) ||
    ("cwd" in params && !nullableString(params.cwd))
  )
    return false;
  if (
    params.networkApprovalContext !== undefined &&
    params.networkApprovalContext !== null &&
    (!isRecord(params.networkApprovalContext) ||
      !hasOnlyKeys(params.networkApprovalContext, ["host", "protocol"]) ||
      !requiredString(params.networkApprovalContext, "host") ||
      !["http", "https", "socks5Tcp", "socks5Udp"].includes(
        params.networkApprovalContext.protocol as string,
      ))
  )
    return false;
  if (
    "proposedExecpolicyAmendment" in params &&
    params.proposedExecpolicyAmendment !== null &&
    (!Array.isArray(params.proposedExecpolicyAmendment) ||
      !params.proposedExecpolicyAmendment.every(
        (token) => typeof token === "string",
      ))
  )
    return false;
  if (
    params.commandActions !== undefined &&
    params.commandActions !== null &&
    (!Array.isArray(params.commandActions) ||
      !params.commandActions.every(validCommandAction))
  )
    return false;
  return (
    params.proposedNetworkPolicyAmendments === undefined ||
    params.proposedNetworkPolicyAmendments === null ||
    (Array.isArray(params.proposedNetworkPolicyAmendments) &&
      params.proposedNetworkPolicyAmendments.every(
        (amendment) =>
          isRecord(amendment) &&
          hasOnlyKeys(amendment, ["host", "action"]) &&
          requiredString(amendment, "host") &&
          (amendment.action === "allow" || amendment.action === "deny"),
      ))
  );
}

function validParams(method: KnownMethod, params: RecordValue): boolean {
  if (method === "item/commandExecution/requestApproval")
    return validCommandParams(params);
  if (method === "item/fileChange/requestApproval")
    return (
      hasOnlyKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "startedAtMs",
        "reason",
        "grantRoot",
      ]) &&
      requiredString(params, "threadId") &&
      requiredString(params, "turnId") &&
      requiredString(params, "itemId") &&
      Number.isSafeInteger(params.startedAtMs) &&
      (!("reason" in params) || nullableString(params.reason)) &&
      (!("grantRoot" in params) || nullableString(params.grantRoot))
    );
  if (method === "item/permissions/requestApproval")
    return (
      hasOnlyKeys(params, [
        "threadId",
        "turnId",
        "itemId",
        "environmentId",
        "startedAtMs",
        "cwd",
        "reason",
        "permissions",
      ]) &&
      requiredString(params, "threadId") &&
      requiredString(params, "turnId") &&
      requiredString(params, "itemId") &&
      nullableString(params.environmentId) &&
      Number.isSafeInteger(params.startedAtMs) &&
      requiredString(params, "cwd") &&
      nullableString(params.reason) &&
      validPermissions(params.permissions)
    );
  if (
    !hasOnlyKeys(params, [
      "threadId",
      "turnId",
      "serverName",
      "mode",
      "_meta",
      "message",
      "requestedSchema",
      "url",
      "elicitationId",
    ]) ||
    !requiredString(params, "threadId") ||
    !nullableString(params.turnId) ||
    !requiredString(params, "serverName") ||
    !requiredString(params, "mode") ||
    !requiredString(params, "message") ||
    !("_meta" in params) ||
    !validJson(params._meta)
  )
    return false;
  // Only `form` and `url` are answered. codex 0.152.1 adds `openaiForm` to
  // this union, alongside the `openai/form` 0.148.0 already carried, and
  // neither is accepted. That is the posture rather than an oversight: a mode
  // this build cannot render is answered by refusing, not by being treated as
  // whichever of the two it most resembles.
  if (params.mode === "form")
    return (
      hasOnlyKeys(params, [
        "threadId",
        "turnId",
        "serverName",
        "mode",
        "_meta",
        "message",
        "requestedSchema",
      ]) &&
      "requestedSchema" in params &&
      validMcpElicitationSchema(params.requestedSchema)
    );
  return (
    params.mode === "url" &&
    hasOnlyKeys(params, [
      "threadId",
      "turnId",
      "serverName",
      "mode",
      "_meta",
      "message",
      "url",
      "elicitationId",
    ]) &&
    requiredString(params, "url") &&
    requiredString(params, "elicitationId")
  );
}

function auditFrom(request: unknown, decision: string): ApprovalAuditRecord {
  const envelope = isRecord(request) ? request : {};
  const params = isRecord(envelope.params) ? envelope.params : {};
  return {
    requestId: validRequestId(envelope.id)
      ? boundedBytes(String(envelope.id), MAX_AUDIT_BYTES)
      : "<invalid>",
    threadId:
      typeof params.threadId === "string"
        ? boundedBytes(params.threadId, MAX_AUDIT_BYTES)
        : null,
    turnId:
      typeof params.turnId === "string"
        ? boundedBytes(params.turnId, MAX_AUDIT_BYTES)
        : null,
    itemId:
      typeof params.itemId === "string"
        ? boundedBytes(params.itemId, MAX_AUDIT_BYTES)
        : null,
    method:
      typeof envelope.method === "string"
        ? boundedBytes(envelope.method, MAX_AUDIT_BYTES)
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
function malformedApprovalRequest(): ApprovalOutcome {
  return {
    kind: "failClosed",
    decision: "decline",
    acceptedForSession: false,
    code: "MALFORMED_APPROVAL_REQUEST",
    audit: {
      requestId: "<invalid>",
      threadId: null,
      turnId: null,
      itemId: null,
      method: "<invalid>",
      decision: "decline",
    },
  };
}
function validate(request: unknown): ValidRequest | ApprovalOutcome {
  if (!validJson(request)) return malformedApprovalRequest();
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, ["method", "id", "params"]) ||
    typeof request.method !== "string" ||
    !validRequestId(request.id) ||
    !isRecord(request.params)
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
  const method = request.method as KnownMethod;
  const params = request.params;
  if (!validParams(method, params))
    return failClosed(request, "MALFORMED_APPROVAL_REQUEST");
  const correlation = Object.freeze({
    method,
    threadId: params.threadId as string,
    turnId: params.turnId as string | null,
  });
  return {
    method,
    id: String(request.id),
    params,
    audit: auditFrom(request, ""),
    correlation,
  };
}
function response(request: ValidRequest, choice: Choice): ApprovalOutcome {
  return {
    kind: "response",
    decision: choice.decision,
    acceptedForSession: choice.acceptedForSession,
    response: choice.response,
    audit: { ...request.audit, decision: choice.decision },
    correlation: request.correlation,
  };
}
function safest(request: ValidRequest): ApprovalOutcome {
  if (request.method === "mcpServer/elicitation/request")
    return response(request, {
      id: "",
      label: "",
      decision: "decline",
      acceptedForSession: false,
      response: { action: "decline", content: null, _meta: null },
    });
  if (request.method === "item/permissions/requestApproval")
    return response(request, {
      id: "",
      label: "",
      decision: "decline",
      acceptedForSession: false,
      response: { permissions: {}, scope: "turn" },
    });
  return response(request, {
    id: "",
    label: "",
    decision: "decline",
    acceptedForSession: false,
    response: { decision: "decline" },
  });
}
function grantedPermissions(params: RecordValue): RecordValue {
  const requested = params.permissions as RecordValue;
  const granted: RecordValue = {};
  if (requested.network !== null)
    granted.network = { enabled: (requested.network as RecordValue).enabled };
  if (requested.fileSystem !== null) {
    const fileSystem = requested.fileSystem as RecordValue;
    const result: RecordValue = {
      read: fileSystem.read,
      write: fileSystem.write,
    };
    if ("globScanMaxDepth" in fileSystem)
      result.globScanMaxDepth = fileSystem.globScanMaxDepth;
    if ("entries" in fileSystem) result.entries = fileSystem.entries;
    granted.fileSystem = result;
  }
  return granted;
}
function choices(request: ValidRequest): readonly Choice[] {
  if (request.method === "item/permissions/requestApproval") {
    const permissions = grantedPermissions(request.params);
    return [
      {
        id: "1",
        label: "Grant requested permissions (scope: turn)",
        decision: "accept",
        acceptedForSession: false,
        response: { permissions, scope: "turn" },
      },
      {
        id: "2",
        label: "Grant requested permissions (scope: session)",
        decision: "acceptForSession",
        acceptedForSession: true,
        response: { permissions, scope: "session" },
      },
      {
        id: "3",
        label: "Decline (scope: turn)",
        decision: "decline",
        acceptedForSession: false,
        response: { permissions: {}, scope: "turn" },
      },
    ];
  }
  if (request.method === "mcpServer/elicitation/request")
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
  if (request.method === "item/commandExecution/requestApproval") {
    for (const amendment of (
      (request.params.proposedNetworkPolicyAmendments as unknown[]) ?? []
    ).slice(0, MAX_APPROVAL_LIST_ITEMS)) {
      const value = amendment as RecordValue;
      // Selecting this changes policy for later requests, not only this one:
      // the generated params type documents the field as amendments "for
      // future requests". The label has no room to say so beside a host, so
      // the context block states it next to each amendment (see `prompt`).
      values.push({
        id: String(values.length + 1),
        label: `Apply supplied network policy for ${boundedBytes(value.host as string, 64)}`,
        decision: "applyNetworkPolicyAmendment",
        acceptedForSession: false,
        response: {
          decision: {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: value.host,
                action: value.action,
              },
            },
          },
        },
      });
    }
    // The server can also propose a narrower exec policy, and supplies the argv
    // to grant. Offered whenever the field is present and non-empty;
    // `availableDecisions` is deliberately not consulted, because it is
    // undeclared by the schema this build is pinned to and was measured
    // advisory rather than binding.
    //
    // The label names the scope because the scope is not this request: the
    // generated params type documents the field as allowing similar commands
    // WITHOUT prompting, so accepting it changes policy for later commands.
    // `acceptedForSession` does not constrain that and cannot — nothing outside
    // this file reads it, and the coordinator forwards `response` alone. The
    // prompt is the only place the operator learns what they are granting.
    const execpolicyAmendment = request.params.proposedExecpolicyAmendment;
    if (Array.isArray(execpolicyAmendment) && execpolicyAmendment.length > 0) {
      values.push({
        id: String(values.length + 1),
        label:
          "Apply supplied execpolicy amendment (allows similar commands without prompting)",
        decision: "acceptWithExecpolicyAmendment",
        acceptedForSession: false,
        response: {
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: execpolicyAmendment,
            },
          },
        },
      });
    }
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

function hasPromptableListSizes(request: ValidRequest): boolean {
  if (request.method === "item/commandExecution/requestApproval")
    return (
      (!Array.isArray(request.params.commandActions) ||
        request.params.commandActions.length <= MAX_APPROVAL_LIST_ITEMS) &&
      (!Array.isArray(request.params.proposedNetworkPolicyAmendments) ||
        request.params.proposedNetworkPolicyAmendments.length <=
          MAX_APPROVAL_LIST_ITEMS)
    );
  if (request.method !== "item/permissions/requestApproval") return true;
  const permissions = request.params.permissions as RecordValue;
  if (!isRecord(permissions.fileSystem)) return true;
  return (
    (!Array.isArray(permissions.fileSystem.read) ||
      permissions.fileSystem.read.length <= MAX_APPROVAL_LIST_ITEMS) &&
    (!Array.isArray(permissions.fileSystem.write) ||
      permissions.fileSystem.write.length <= MAX_APPROVAL_LIST_ITEMS) &&
    (!Array.isArray(permissions.fileSystem.entries) ||
      permissions.fileSystem.entries.length <= MAX_APPROVAL_LIST_ITEMS)
  );
}

function fitsDisplayed(value: string, limit = MAX_FIELD_BYTES): boolean {
  return fitsEscapedTerminalBytes(value, limit);
}

function commandActionFields(action: RecordValue): readonly string[] {
  return ["type", "command", "name", "query", "path"].flatMap((key) =>
    key in action ? [`${key}=${String(action[key])}`] : [],
  );
}

function fileSystemEntryFields(entry: RecordValue): readonly string[] {
  const path = entry.path as RecordValue;
  const fields = [
    `access=${String(entry.access)}`,
    `type=${String(path.type)}`,
  ];
  if (path.type === "path") return [...fields, `path=${String(path.path)}`];
  if (path.type === "glob_pattern")
    return [...fields, `pattern=${String(path.pattern)}`];
  const special = path.value as RecordValue;
  const specialFields = [...fields, `kind=${String(special.kind)}`];
  if (special.kind === "project_roots")
    return [...specialFields, `subpath=${String(special.subpath)}`];
  if (special.kind === "unknown")
    return [
      ...specialFields,
      `path=${String(special.path)}`,
      `subpath=${String(special.subpath)}`,
    ];
  return specialFields;
}

function fileSystemEntryDestination(entry: RecordValue): string {
  const path = entry.path as RecordValue;
  if (path.type === "path") return String(path.path);
  if (path.type === "glob_pattern") return String(path.pattern);
  return fileSystemEntryFields(entry).slice(1).join("; ");
}

function hasCompletePromptContext(
  request: ValidRequest,
  available: readonly Choice[],
): boolean {
  if (
    !fitsDisplayed(request.id, MAX_AUDIT_BYTES) ||
    [request.params.threadId, request.params.turnId, request.params.itemId]
      .filter((value): value is string => typeof value === "string")
      .some((value) => !fitsDisplayed(value, MAX_AUDIT_BYTES)) ||
    available.some(
      (choice) => !fitsDisplayed(choice.label, MAX_CHOICE_LABEL_BYTES),
    )
  )
    return false;
  const params = request.params;
  for (const key of [
    "kind",
    "command",
    "cwd",
    "grantRoot",
    "serverName",
    "mode",
    "url",
    "reason",
    "message",
  ] as const)
    if (typeof params[key] === "string" && !fitsDisplayed(params[key]))
      return false;
  if (
    isRecord(params.networkApprovalContext) &&
    [params.networkApprovalContext.protocol, params.networkApprovalContext.host]
      .filter((value): value is string => typeof value === "string")
      .some((value) => !fitsDisplayed(value))
  )
    return false;
  if (
    Array.isArray(params.commandActions) &&
    params.commandActions.some((action) => {
      if (!isRecord(action)) return true;
      return commandActionFields(action).some((field) => !fitsDisplayed(field));
    })
  )
    return false;
  if (
    Array.isArray(params.proposedNetworkPolicyAmendments) &&
    params.proposedNetworkPolicyAmendments.some(
      (amendment) =>
        !isRecord(amendment) ||
        [amendment.host, amendment.action]
          .filter((value): value is string => typeof value === "string")
          .some((value) => !fitsDisplayed(value)),
    )
  )
    return false;
  // The amendment is granted in full while the prompt shows it bounded, so
  // without this the operator would authorize argv bytes the display had cut.
  // Every other displayed field is gated here rather than trusted to
  // `bounded()`, and refusing is what makes the truncation unreachable: a
  // `command` too long to render already declines without prompting, and this
  // makes the amendment behave the same way. It also bounds the array's size,
  // which is otherwise unbounded, since an argv with too many tokens cannot
  // fit the display budget either.
  if (
    Array.isArray(params.proposedExecpolicyAmendment) &&
    !fitsDisplayed(
      JSON.stringify(params.proposedExecpolicyAmendment.map(String)),
    )
  )
    return false;
  const permissions = isRecord(params.permissions) ? params.permissions : null;
  const fileSystem =
    permissions && isRecord(permissions.fileSystem)
      ? permissions.fileSystem
      : null;
  if (
    fileSystem &&
    [fileSystem.read, fileSystem.write]
      .filter(Array.isArray)
      .flat()
      .some((value) => typeof value === "string" && !fitsDisplayed(value))
  )
    return false;
  if (fileSystem && Array.isArray(fileSystem.entries))
    for (const entry of fileSystem.entries) {
      if (!isRecord(entry) || !isRecord(entry.path)) return false;
      if (fileSystemEntryFields(entry).some((field) => !fitsDisplayed(field)))
        return false;
    }
  if (
    fileSystem &&
    "globScanMaxDepth" in fileSystem &&
    !fitsDisplayed(String(fileSystem.globScanMaxDepth))
  )
    return false;
  return true;
}
function prompt(
  request: ValidRequest,
  available: readonly Choice[],
): string | null {
  const lines = [
    `Approval: ${request.method}`,
    `Request: ${escapeTerminalControls(request.id)}`,
    `Thread: ${escapeTerminalControls(request.audit.threadId ?? "none")}`,
    `Turn: ${escapeTerminalControls(request.audit.turnId ?? "none")}`,
    `Item: ${escapeTerminalControls(request.audit.itemId ?? "none")}`,
  ];
  const context: string[] = [];
  const params = request.params;
  for (const key of [
    "kind",
    "command",
    "cwd",
    "grantRoot",
    "serverName",
    "mode",
    "url",
    "reason",
    "message",
  ] as const)
    if (typeof params[key] === "string")
      context.push(`${key}: ${bounded(params[key])}`);
  // Without this the operator would be offered the amendment choice above with
  // no sight of the argv it grants. Two ways to display it wrongly, both of
  // which authorize something other than what was shown, and both rejected:
  // slicing the tokens drops the tail silently, and joining them on a space
  // erases the argument boundaries, so ["bash", "-c", "echo safe"] renders
  // identically to ["bash", "-c", "echo", "safe"] and an empty argument
  // vanishes. JSON keeps every boundary, quotes whitespace, and shows an empty
  // argument as "". An amendment too long to render is refused by
  // `hasCompletePromptContext` before this runs, exactly as an over-long
  // `command` is, so the bound here never silently cuts a granted argv.
  if (
    Array.isArray(params.proposedExecpolicyAmendment) &&
    params.proposedExecpolicyAmendment.length > 0
  )
    context.push(
      `execpolicy amendment: ${bounded(
        JSON.stringify(params.proposedExecpolicyAmendment.map(String)),
      )}`,
    );
  if (isRecord(params.networkApprovalContext))
    context.push(
      `network: ${bounded(String(params.networkApprovalContext.protocol))}://${bounded(String(params.networkApprovalContext.host))}`,
    );
  if (Array.isArray(params.commandActions))
    for (const action of params.commandActions.slice(
      0,
      MAX_APPROVAL_LIST_ITEMS,
    )) {
      const value = action as RecordValue;
      context.push(
        `command action: ${String(value.type)} ${commandActionFields(value).slice(1).join("; ")}`,
      );
    }
  if (Array.isArray(params.proposedNetworkPolicyAmendments))
    for (const amendment of params.proposedNetworkPolicyAmendments.slice(
      0,
      MAX_APPROVAL_LIST_ITEMS,
    )) {
      const value = amendment as RecordValue;
      // The scope is disclosed here and not in the choice label. The label
      // must keep the host, because the host is what tells two amendments
      // apart, and `Apply supplied network policy for ` plus a host already
      // meets MAX_CHOICE_LABEL_BYTES; a clause there would turn hosts that
      // prompt today into declines. This line has the prompt budget instead,
      // and a line that does not fit refuses the whole prompt below rather
      // than dropping the clause, so the disclosure is never silently cut.
      context.push(
        `network amendment (applies to future requests): ${String(value.action)} ${String(value.host)}`,
      );
    }
  const requestedPermissions = isRecord(params.permissions)
    ? params.permissions
    : null;
  if (requestedPermissions) {
    if (isRecord(requestedPermissions.network))
      context.push(
        `network: enabled ${String(requestedPermissions.network.enabled)}`,
      );
    if (isRecord(requestedPermissions.fileSystem))
      context.push(
        `fileSystem: read ${Array.isArray(requestedPermissions.fileSystem.read) ? requestedPermissions.fileSystem.read.map(String).map(bounded).join(", ") : "null"}; write ${Array.isArray(requestedPermissions.fileSystem.write) ? requestedPermissions.fileSystem.write.map(String).map(bounded).join(", ") : "null"}`,
      );
    if (
      isRecord(requestedPermissions.fileSystem) &&
      "globScanMaxDepth" in requestedPermissions.fileSystem
    )
      context.push(
        requestedPermissions.fileSystem.globScanMaxDepth === null
          ? "globScanMaxDepth null"
          : `globScanMaxDepth: ${String(requestedPermissions.fileSystem.globScanMaxDepth)}`,
      );
  }
  if (
    requestedPermissions &&
    isRecord(requestedPermissions.fileSystem) &&
    "entries" in requestedPermissions.fileSystem
  )
    if (requestedPermissions.fileSystem.entries === null)
      context.push("entries null");
    else if (Array.isArray(requestedPermissions.fileSystem.entries))
      for (const entry of requestedPermissions.fileSystem.entries.slice(
        0,
        MAX_APPROVAL_LIST_ITEMS,
      )) {
        const value = entry as RecordValue;
        context.push(
          `fileSystem entry: ${String(value.access)} ${fileSystemEntryDestination(value)}; ${fileSystemEntryFields(value).join("; ")}`,
        );
      }
  const choiceLines = available.map(
    (choice) =>
      `${choice.id}. ${boundedBytes(escapeTerminalControls(choice.label), MAX_CHOICE_LABEL_BYTES)}`,
  );
  const choiceBlock = [...choiceLines, "Selection:"].join("\n");
  if (Buffer.byteLength(choiceBlock, "utf8") + 1 > MAX_PROMPT_BYTES)
    return null;
  const visibleContext = context.map(escapeTerminalControls);
  const boundedContext = visibleContext.map((line) =>
    boundedBytes(line, MAX_PROMPT_BYTES),
  );
  if (boundedContext.some((line, index) => line !== visibleContext[index]))
    return null;
  for (const line of boundedContext) {
    if (
      Buffer.byteLength([...lines, line, choiceBlock].join("\n"), "utf8") + 1 >
      MAX_PROMPT_BYTES
    )
      return null;
    lines.push(line);
  }
  return `${[...lines, choiceBlock].join("\n")} `;
}
function writePrompt(
  writer: ApprovalPromptWriter,
  value: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      controller.abort(signal?.reason);
      finish(false);
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    timer = setTimeout(
      () => {
        controller.abort();
        finish(false);
      },
      Math.max(1, Math.min(timeoutMs, 60_000)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      writer.writePrompt(value, controller.signal).then(
        () => finish(true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
function readLine(
  input: NodeJS.ReadableStream,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    const readable = input as NodeJS.ReadableStream & {
      readonly readableFlowing?: boolean | null;
      pause: () => unknown;
      unshift?: (chunk: Buffer) => void;
    };
    const wasFlowing = readable.readableFlowing === true;
    const restoreState = () => {
      if (wasFlowing) input.resume();
      else readable.pause();
    };
    const onAbort = () => finish(null);
    const finish = (line: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onEnd);
      signal?.removeEventListener("abort", onAbort);
      restoreState();
      resolve(line);
    };
    const onData = (chunk: unknown) => {
      if (
        typeof chunk !== "string" &&
        !Buffer.isBuffer(chunk) &&
        !(chunk instanceof Uint8Array)
      )
        return finish(null);
      const chunkBytes =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, "utf8")
          : chunk.byteLength;
      if (chunkBytes > MAX_LINE_BYTES - buffered.length) return finish(null);
      const chunkBuffer =
        typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Buffer.from(chunk);
      const newlineInChunk = chunkBuffer.indexOf(10);
      const lineChunk =
        newlineInChunk < 0
          ? chunkBuffer
          : chunkBuffer.subarray(0, newlineInChunk + 1);
      if (
        lineChunk.length >
        MAX_LINE_BYTES - buffered.length + (newlineInChunk < 0 ? 0 : 1)
      )
        return finish(null);
      buffered = Buffer.concat([buffered, lineChunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      if (newlineInChunk >= 0 && newlineInChunk + 1 < chunkBuffer.length) {
        readable.pause();
        readable.unshift?.(chunkBuffer.subarray(newlineInChunk + 1));
      }
      const line = buffered
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      finish(Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES ? line : null);
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(
      () => finish(null),
      Math.max(1, Math.min(timeoutMs, 60_000)),
    );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    input.resume();
  });
}
export async function answerApproval(
  request: unknown,
  input: NodeJS.ReadableStream,
  writer: ApprovalPromptWriter,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  try {
    const valid = validate(request);
    if ("kind" in valid) return valid;
    const terminalInput = input as NodeJS.ReadableStream & { isTTY?: boolean };
    if (terminalInput.isTTY !== true) return safest(valid);
    const available = choices(valid);
    if (!hasPromptableListSizes(valid)) return safest(valid);
    if (!hasCompletePromptContext(valid, available)) return safest(valid);
    if (signal?.aborted) return safest(valid);
    const rendered = prompt(valid, available);
    if (
      rendered === null ||
      !(await writePrompt(writer, rendered, timeoutMs, signal)) ||
      terminalInput.isTTY !== true
    )
      return safest(valid);
    const selected = await readLine(input, timeoutMs, signal);
    if (terminalInput.isTTY !== true) return safest(valid);
    const choice = available.find((candidate) => candidate.id === selected);
    return choice ? response(valid, choice) : safest(valid);
  } catch {
    return {
      kind: "failClosed",
      decision: "decline",
      acceptedForSession: false,
      code: "MALFORMED_APPROVAL_REQUEST",
      audit: {
        requestId: "<invalid>",
        threadId: null,
        turnId: null,
        itemId: null,
        method: "<invalid>",
        decision: "decline",
      },
    };
  }
}
