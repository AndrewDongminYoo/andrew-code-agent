export interface ItemState {
  readonly id: string;
  readonly type: string;
  readonly phase: "started" | "completed";
  readonly value: unknown;
}

export interface TurnState {
  readonly threadId: string;
  readonly turnId: string;
  readonly items: ReadonlyMap<string, ItemState>;
  readonly observedCommands: readonly {
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number | null;
  }[];
  readonly diff: string | null;
  readonly warnings: readonly string[];
  readonly omittedItems: number;
  readonly omittedItemIds: ReadonlySet<string>;
  readonly omittedItemTypes?: ReadonlyMap<string, string>;
  readonly omittedItemStates?: ReadonlyMap<string, ItemState>;
  readonly omittedCommands: number;
  readonly omittedWarnings: number;
  readonly terminalStatus: "running" | "completed" | "failed" | "interrupted";
}

const MAX_TEXT_LENGTH = 512;
const MAX_ITEMS = 64;
const MAX_OMITTED_ITEM_AUTHORITY = 64;
const MAX_WARNINGS = 16;
const MAX_COMMANDS = 32;
const MAX_PROTOCOL_ID_LENGTH = 256;
const TRUNCATION_MARKER = " [truncated]";

export class ReducerError extends Error {
  readonly code: "INVALID_SERVER_EVENT" | "UNKNOWN_SERVER_REQUEST";

  constructor(code: ReducerError["code"]) {
    super(code);
    this.name = "ReducerError";
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVALID_JSON_DATA = Symbol("INVALID_JSON_DATA");

function descriptorSafeJsonData(
  value: unknown,
  depth = 0,
  active = new WeakSet<object>(),
): unknown | typeof INVALID_JSON_DATA {
  try {
    if (depth > 32) return INVALID_JSON_DATA;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : INVALID_JSON_DATA;
    if (typeof value !== "object") return INVALID_JSON_DATA;
    const array = Array.isArray(value);
    if (
      (array && Object.getPrototypeOf(value) !== Array.prototype) ||
      (!array &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      active.has(value)
    )
      return INVALID_JSON_DATA;
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
      return INVALID_JSON_DATA;
    active.add(value);
    try {
      const result: unknown[] | RecordValue = array ? [] : Object.create(null);
      for (const name of names) {
        if (name === "length") continue;
        const descriptor = descriptors[name];
        if (descriptor === undefined || !("value" in descriptor))
          return INVALID_JSON_DATA;
        const child = descriptorSafeJsonData(
          descriptor.value,
          depth + 1,
          active,
        );
        if (child === INVALID_JSON_DATA) return INVALID_JSON_DATA;
        if (array) (result as unknown[])[Number(name)] = child;
        else (result as RecordValue)[name] = child;
      }
      return result;
    } finally {
      active.delete(value);
    }
  } catch {
    return INVALID_JSON_DATA;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bounded(value: string): string {
  return value.length <= MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_TEXT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function structurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (
    depth > 32 ||
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const leftDescriptors = Object.getOwnPropertyDescriptors(left);
  const rightDescriptors = Object.getOwnPropertyDescriptors(right);
  const leftNames = Object.getOwnPropertyNames(left).filter(
    (name) => name !== "length",
  );
  const rightNames = Object.getOwnPropertyNames(right).filter(
    (name) => name !== "length",
  );
  if (
    leftNames.length !== rightNames.length ||
    leftNames.some((name, index) => name !== rightNames[index])
  )
    return false;
  return leftNames.every((name) => {
    const leftDescriptor = leftDescriptors[name];
    const rightDescriptor = rightDescriptors[name];
    return (
      leftDescriptor !== undefined &&
      rightDescriptor !== undefined &&
      "value" in leftDescriptor &&
      "value" in rightDescriptor &&
      structurallyEqual(leftDescriptor.value, rightDescriptor.value, depth + 1)
    );
  });
}

function requireIdentity(state: TurnState, params: RecordValue): void {
  if (params.threadId !== state.threadId || params.turnId !== state.turnId)
    throw new ReducerError("INVALID_SERVER_EVENT");
}

function requireProtocolId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_PROTOCOL_ID_LENGTH
  );
}

function appendWarning(state: TurnState, warning: string): TurnState {
  if (state.warnings.length < MAX_WARNINGS)
    return { ...state, warnings: [...state.warnings, bounded(warning)] };
  return { ...state, omittedWarnings: state.omittedWarnings + 1 };
}

function requireItem(item: unknown): RecordValue {
  if (
    !isRecord(item) ||
    !requireProtocolId(item.id) ||
    !requireProtocolId(item.type)
  )
    throw new ReducerError("INVALID_SERVER_EVENT");
  return item;
}

function safeItem(item: unknown, phase: ItemState["phase"]): ItemState {
  const raw = requireItem(item);
  const id = text(raw.id)!;
  const type = text(raw.type)!;
  let value: unknown = { label: bounded(type) };

  if (type === "agentMessage" || type === "plan") {
    value = { text: bounded(text(raw.text) ?? "") };
  } else if (type === "reasoning") {
    value = { label: "Reasoning updated" };
  } else if (type === "commandExecution") {
    const command = text(raw.command);
    const cwd = text(raw.cwd);
    if (command === null || cwd === null)
      throw new ReducerError("INVALID_SERVER_EVENT");
    value = {
      command: bounded(command),
      cwd: bounded(cwd),
      exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
      output:
        typeof raw.aggregatedOutput === "string"
          ? bounded(raw.aggregatedOutput)
          : null,
    };
  } else if (type === "fileChange") {
    const changes = Array.isArray(raw.changes) ? raw.changes : [];
    value = {
      files: changes.slice(0, MAX_ITEMS).flatMap((change) => {
        if (!isRecord(change) || text(change.path) === null) return [];
        return [
          {
            path: bounded(text(change.path)!),
            kind: bounded(text(change.kind) ?? "changed"),
          },
        ];
      }),
      omittedFiles: Math.max(0, changes.length - MAX_ITEMS),
      status: bounded(text(raw.status) ?? "unknown"),
    };
  } else if (type === "mcpToolCall") {
    value = {
      server: bounded(text(raw.server) ?? "unknown"),
      tool: bounded(text(raw.tool) ?? "unknown"),
      status: bounded(text(raw.status) ?? "unknown"),
    };
  } else if (type === "subAgentActivity") {
    value = {
      label: `Subagent ${bounded(text(raw.kind) ?? "activity")}: ${bounded(text(raw.agentPath) ?? text(raw.agentThreadId) ?? "unknown")}`,
    };
  }

  return { id, type, phase, value };
}

function replaceItem(state: TurnState, item: ItemState): TurnState {
  const items = new Map(state.items);
  const omitted = state.omittedItemStates?.get(item.id);
  if (omitted !== undefined) {
    if (omitted.type !== item.type)
      throw new ReducerError("INVALID_SERVER_EVENT");
    if (omitted.phase === "completed") {
      if (item.phase === "started") return state;
      if (structurallyEqual(omitted, item)) return state;
      throw new ReducerError("INVALID_SERVER_EVENT");
    }
    const omittedItemStates = new Map(state.omittedItemStates);
    omittedItemStates.set(item.id, item);
    return { ...state, omittedItemStates };
  }
  if (!items.has(item.id) && items.size >= MAX_ITEMS) {
    const omittedType = state.omittedItemTypes?.get(item.id);
    if (omittedType !== undefined) {
      if (omittedType !== item.type)
        throw new ReducerError("INVALID_SERVER_EVENT");
      return state;
    }
    if ((state.omittedItemStates?.size ?? 0) >= MAX_OMITTED_ITEM_AUTHORITY)
      throw new ReducerError("INVALID_SERVER_EVENT");
    const omittedItemIds = new Set(state.omittedItemIds);
    const omittedItemTypes = new Map(state.omittedItemTypes ?? []);
    const omittedItemStates = new Map(state.omittedItemStates ?? []);
    omittedItemIds.add(item.id);
    omittedItemTypes.set(item.id, item.type);
    omittedItemStates.set(item.id, item);
    return {
      ...state,
      omittedItems: omittedItemIds.size,
      omittedItemIds,
      omittedItemTypes,
      omittedItemStates,
    };
  }
  items.set(item.id, item);
  return { ...state, items };
}

function isKnownOmittedItem(
  state: TurnState,
  itemId: string,
  expectedType: string,
): boolean {
  const omittedType = state.omittedItemTypes?.get(itemId);
  if (omittedType === undefined) return false;
  if (omittedType !== expectedType)
    throw new ReducerError("INVALID_SERVER_EVENT");
  return true;
}

function knownOmittedItem(
  state: TurnState,
  itemId: string,
  expectedType: string,
): ItemState | undefined {
  if (!isKnownOmittedItem(state, itemId, expectedType)) return undefined;
  const item = state.omittedItemStates?.get(itemId);
  if (!item || item.type !== expectedType)
    throw new ReducerError("INVALID_SERVER_EVENT");
  return item;
}

function updateDelta(
  state: TurnState,
  params: RecordValue,
  expectedType: string,
  update: (item: ItemState) => ItemState,
): TurnState {
  requireIdentity(state, params);
  const itemId = text(params.itemId);
  if (itemId === null) throw new ReducerError("INVALID_SERVER_EVENT");
  const omitted = knownOmittedItem(state, itemId, expectedType);
  if (omitted) {
    if (omitted.phase === "completed") return state;
    return replaceItem(state, update(omitted));
  }
  const item = state.items.get(itemId);
  if (!item || item.type !== expectedType)
    throw new ReducerError("INVALID_SERVER_EVENT");
  if (item.phase === "completed") return state;
  return replaceItem(state, update(item));
}

function terminalDelta(
  state: TurnState,
  params: RecordValue,
  expectedType: string,
): TurnState | null {
  if (state.terminalStatus === "running") return null;
  requireIdentity(state, params);
  const itemId = text(params.itemId);
  if (itemId === null) throw new ReducerError("INVALID_SERVER_EVENT");
  if (isKnownOmittedItem(state, itemId, expectedType)) return state;
  const item = state.items.get(itemId);
  if (!item || item.type !== expectedType)
    throw new ReducerError("INVALID_SERVER_EVENT");
  return state;
}

function withTextDelta(item: ItemState, delta: unknown): ItemState {
  const current =
    isRecord(item.value) && typeof item.value.text === "string"
      ? item.value.text
      : "";
  if (typeof delta !== "string") throw new ReducerError("INVALID_SERVER_EVENT");
  return { ...item, value: { text: bounded(`${current}${delta}`) } };
}

export function createTurnState(threadId: string, turnId: string): TurnState {
  if (!requireProtocolId(threadId) || !requireProtocolId(turnId))
    throw new ReducerError("INVALID_SERVER_EVENT");
  return {
    threadId,
    turnId,
    items: new Map(),
    observedCommands: [],
    diff: null,
    warnings: [],
    omittedItems: 0,
    omittedItemIds: new Set(),
    omittedItemTypes: new Map(),
    omittedItemStates: new Map(),
    omittedCommands: 0,
    omittedWarnings: 0,
    terminalStatus: "running",
  };
}

export function reduceServerMessage(
  state: TurnState,
  message: unknown,
): TurnState {
  message = descriptorSafeJsonData(message);
  if (message === INVALID_JSON_DATA)
    throw new ReducerError("INVALID_SERVER_EVENT");
  if (!isRecord(message) || typeof message.method !== "string")
    throw new ReducerError("INVALID_SERVER_EVENT");
  if (Object.hasOwn(message, "id"))
    throw new ReducerError("UNKNOWN_SERVER_REQUEST");
  const params = isRecord(message.params) ? message.params : null;

  if (message.method === "item/started") {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    requireIdentity(state, params);
    const next = safeItem(params.item, "started");
    const previous =
      state.items.get(next.id) ?? state.omittedItemStates?.get(next.id);
    if (previous?.phase === "completed") {
      if (previous.type !== next.type)
        throw new ReducerError("INVALID_SERVER_EVENT");
      return state;
    }
    if (state.terminalStatus !== "running") return state;
    return replaceItem(state, next);
  }
  if (message.method === "item/completed") {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    requireIdentity(state, params);
    const next = safeItem(params.item, "completed");
    const previous =
      state.items.get(next.id) ?? state.omittedItemStates?.get(next.id);
    if (state.terminalStatus !== "running") {
      if (previous?.type !== next.type || !structurallyEqual(previous, next))
        throw new ReducerError("INVALID_SERVER_EVENT");
      return state;
    }
    if (previous?.phase === "completed") {
      if (structurallyEqual(previous, next)) return state;
      throw new ReducerError("INVALID_SERVER_EVENT");
    }
    return replaceItem(state, next);
  }
  if (message.method === "item/agentMessage/delta") {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "agentMessage");
    if (terminal) return terminal;
    return updateDelta(state, params, "agentMessage", (item) =>
      withTextDelta(item, params.delta),
    );
  }
  if (message.method === "item/plan/delta") {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "plan");
    if (terminal) return terminal;
    return updateDelta(state, params, "plan", (item) =>
      withTextDelta(item, params.delta),
    );
  }
  if (message.method === "item/commandExecution/outputDelta") {
    if (!params || typeof params.delta !== "string")
      throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "commandExecution");
    if (terminal) return terminal;
    return updateDelta(state, params, "commandExecution", (item) => {
      const value = isRecord(item.value) ? item.value : {};
      const previous = typeof value.output === "string" ? value.output : "";
      return {
        ...item,
        value: { ...value, output: bounded(`${previous}${params.delta}`) },
      };
    });
  }
  if (
    message.method === "item/fileChange/outputDelta" ||
    message.method === "item/fileChange/patchUpdated"
  ) {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "fileChange");
    if (terminal) return terminal;
    if (message.method === "item/fileChange/patchUpdated") {
      if (!Array.isArray(params.changes))
        throw new ReducerError("INVALID_SERVER_EVENT");
      return updateDelta(state, params, "fileChange", (item) =>
        safeItem(
          {
            id: item.id,
            type: "fileChange",
            changes: params.changes,
            status:
              isRecord(item.value) && typeof item.value.status === "string"
                ? item.value.status
                : "inProgress",
          },
          item.phase,
        ),
      );
    }
    return updateDelta(state, params, "fileChange", (item) => item);
  }
  if (
    message.method === "item/reasoning/summaryTextDelta" ||
    message.method === "item/reasoning/summaryPartAdded" ||
    message.method === "item/reasoning/textDelta"
  ) {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    if (
      (message.method === "item/reasoning/summaryTextDelta" &&
        (typeof params.delta !== "string" ||
          typeof params.summaryIndex !== "number")) ||
      (message.method === "item/reasoning/summaryPartAdded" &&
        typeof params.summaryIndex !== "number") ||
      (message.method === "item/reasoning/textDelta" &&
        (typeof params.contentIndex !== "number" ||
          typeof params.delta !== "string"))
    )
      throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "reasoning");
    if (terminal) return terminal;
    return updateDelta(state, params, "reasoning", (item) => ({
      ...item,
      value: { label: "Reasoning updated" },
    }));
  }
  if (message.method === "item/mcpToolCall/progress") {
    if (!params || typeof params.message !== "string")
      throw new ReducerError("INVALID_SERVER_EVENT");
    const terminal = terminalDelta(state, params, "mcpToolCall");
    if (terminal) return terminal;
    return updateDelta(state, params, "mcpToolCall", (item) => {
      const value = isRecord(item.value) ? item.value : {};
      return { ...item, value: { ...value, progress: "MCP progress updated" } };
    });
  }
  if (message.method === "turn/diff/updated") {
    if (!params || typeof params.diff !== "string")
      throw new ReducerError("INVALID_SERVER_EVENT");
    requireIdentity(state, params);
    if (state.terminalStatus !== "running") return state;
    return { ...state, diff: bounded(params.diff) };
  }
  if (message.method === "warning") {
    if (!params || typeof params.message !== "string")
      throw new ReducerError("INVALID_SERVER_EVENT");
    if (params.threadId !== null && params.threadId !== state.threadId)
      throw new ReducerError("INVALID_SERVER_EVENT");
    return appendWarning(state, params.message);
  }
  if (message.method === "error") {
    if (!params) throw new ReducerError("INVALID_SERVER_EVENT");
    requireIdentity(state, params);
    return appendWarning(state, "Turn error");
  }
  if (message.method === "turn/completed") {
    if (!params || params.threadId !== state.threadId || !isRecord(params.turn))
      throw new ReducerError("INVALID_SERVER_EVENT");
    const turn = params.turn;
    if (
      turn.id !== state.turnId ||
      turn.itemsView !== "full" ||
      !Array.isArray(turn.items)
    )
      throw new ReducerError("INVALID_SERVER_EVENT");
    const statuses: Record<string, TurnState["terminalStatus"]> = {
      completed: "completed",
      failed: "failed",
      interrupted: "interrupted",
    };
    if (
      typeof turn.status !== "string" ||
      !Object.hasOwn(statuses, turn.status)
    )
      throw new ReducerError("INVALID_SERVER_EVENT");
    const items = new Map<string, ItemState>();
    const seenIds = new Set<string>();
    const observedCommands: {
      command: string;
      cwd: string;
      exitCode: number | null;
    }[] = [];
    let omittedCommands = 0;
    let omittedItems = 0;
    const omittedItemIds = new Set<string>();
    const omittedItemTypes = new Map<string, string>();
    const omittedItemStates = new Map<string, ItemState>();
    for (const raw of turn.items) {
      const safe = safeItem(raw, "completed");
      if (seenIds.has(safe.id)) throw new ReducerError("INVALID_SERVER_EVENT");
      seenIds.add(safe.id);
      if (safe.type === "commandExecution" && isRecord(safe.value)) {
        if (observedCommands.length >= MAX_COMMANDS) omittedCommands += 1;
        else if (
          typeof safe.value.command === "string" &&
          typeof safe.value.cwd === "string"
        )
          observedCommands.push({
            command: safe.value.command,
            cwd: safe.value.cwd,
            exitCode:
              typeof safe.value.exitCode === "number"
                ? safe.value.exitCode
                : null,
          });
      }
      if (items.size >= MAX_ITEMS) {
        if (omittedItemStates.size >= MAX_OMITTED_ITEM_AUTHORITY)
          throw new ReducerError("INVALID_SERVER_EVENT");
        omittedItemIds.add(safe.id);
        omittedItemTypes.set(safe.id, safe.type);
        omittedItemStates.set(safe.id, safe);
        omittedItems = omittedItemIds.size;
        continue;
      }
      items.set(safe.id, safe);
    }
    const next: TurnState = {
      ...state,
      items,
      observedCommands,
      omittedItems,
      omittedItemIds,
      omittedItemTypes,
      omittedItemStates,
      omittedCommands,
      terminalStatus: statuses[turn.status]!,
    };
    if (state.terminalStatus === "running") return next;
    if (
      state.terminalStatus === next.terminalStatus &&
      structurallyEqual([...state.items], [...next.items]) &&
      structurallyEqual(state.observedCommands, next.observedCommands) &&
      state.omittedItems === next.omittedItems &&
      structurallyEqual([...state.omittedItemIds], [...next.omittedItemIds]) &&
      structurallyEqual(
        [...(state.omittedItemTypes ?? [])],
        [...(next.omittedItemTypes ?? [])],
      ) &&
      structurallyEqual(
        [...(state.omittedItemStates ?? [])],
        [...(next.omittedItemStates ?? [])],
      ) &&
      state.omittedCommands === next.omittedCommands
    )
      return state;
    throw new ReducerError("INVALID_SERVER_EVENT");
  }
  if (message.method === "turn/started") {
    if (
      !params ||
      params.threadId !== state.threadId ||
      !isRecord(params.turn) ||
      params.turn.id !== state.turnId ||
      params.turn.status !== "inProgress"
    )
      throw new ReducerError("INVALID_SERVER_EVENT");
    return state;
  }
  return state;
}
