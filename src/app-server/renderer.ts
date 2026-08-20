import type { ItemState, TurnState } from "./reducer.js";

const MAX_RENDERED_VALUE = 512;
const TRUNCATION_MARKER = " [truncated]";

function bounded(value: string): string {
  return value.length <= MAX_RENDERED_VALUE
    ? value
    : `${value.slice(0, MAX_RENDERED_VALUE - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function valueText(value: unknown, key: string): string | null {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? bounded(candidate) : null;
}

function renderItem(item: ItemState): string {
  const lifecycle = `${item.id} ${item.type} ${item.phase}`;
  if (item.type === "agentMessage" || item.type === "plan")
    return `${lifecycle}: ${valueText(item.value, "text") ?? ""}`;
  if (item.type === "reasoning") return `${lifecycle}: Reasoning updated`;
  if (item.type === "commandExecution") {
    const command = valueText(item.value, "command") ?? "command";
    const cwd = valueText(item.value, "cwd") ?? "unknown cwd";
    const exitCode = record(item.value)?.exitCode;
    const output = valueText(item.value, "output");
    return `${lifecycle}: ${command} (${cwd}), exit ${typeof exitCode === "number" ? exitCode : "pending"}${output ? `, ${output}` : ""}`;
  }
  if (item.type === "fileChange") {
    const rawFiles = record(item.value)?.files;
    const files = Array.isArray(rawFiles)
      ? rawFiles
          .flatMap((file: unknown) => {
            const safeFile = record(file);
            return typeof safeFile?.path === "string"
              ? [bounded(safeFile.path)]
              : [];
          })
          .join(", ")
      : "files changed";
    return `${lifecycle}: ${files}`;
  }
  if (item.type === "mcpToolCall")
    return `${lifecycle}: ${valueText(item.value, "server") ?? "unknown"}/${valueText(item.value, "tool") ?? "tool"}`;
  if (item.type === "subAgentActivity")
    return `${lifecycle}: ${valueText(item.value, "label") ?? "Subagent activity"}`;
  return `${lifecycle}: ${valueText(item.value, "label") ?? "Item updated"}`;
}

export function renderTurnState(state: TurnState): readonly string[] {
  const lines = [
    `Thread: ${bounded(state.threadId)}`,
    `Turn: ${bounded(state.turnId)}`,
  ];
  for (const item of state.items.values()) lines.push(renderItem(item));
  for (const command of state.observedCommands)
    lines.push(
      `Observed command: ${bounded(command.command)} (${bounded(command.cwd)}), exit ${command.exitCode ?? "pending"}`,
    );
  if (state.diff !== null) lines.push(`Final diff: ${bounded(state.diff)}`);
  for (const warning of state.warnings)
    lines.push(`Warning: ${bounded(warning)}`);
  lines.push(`Terminal status: ${state.terminalStatus}`);
  return lines;
}
