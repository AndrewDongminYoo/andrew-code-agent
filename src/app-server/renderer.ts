import type { ItemState, TurnState } from "./reducer.js";
import { boundedTerminalText } from "./terminal.js";

const MAX_RENDERED_VALUE = 512;
const TRUNCATION_MARKER = " [truncated]";

function bounded(value: string, limit = MAX_RENDERED_VALUE): string {
  return boundedTerminalText(value, limit, TRUNCATION_MARKER);
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

function renderItem(item: ItemState): readonly string[] {
  const lifecycle = `${bounded(item.id, 128)} ${bounded(item.type, 128)} ${item.phase}`;
  if (item.type === "agentMessage" || item.type === "plan")
    return [bounded(`${lifecycle}: ${valueText(item.value, "text") ?? ""}`)];
  if (item.type === "reasoning")
    return [bounded(`${lifecycle}: Reasoning updated`)];
  if (item.type === "commandExecution") {
    const command = valueText(item.value, "command") ?? "command";
    const cwd = valueText(item.value, "cwd") ?? "unknown cwd";
    const exitCode = record(item.value)?.exitCode;
    const output = valueText(item.value, "output");
    const lines = [
      bounded(
        `${lifecycle}: ${command} (${cwd}), exit ${typeof exitCode === "number" ? exitCode : "pending"}`,
      ),
    ];
    if (output) lines.push(bounded(`Command output: ${output}`));
    return lines;
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
    const omittedFiles = record(item.value)?.omittedFiles;
    return [
      bounded(
        `${lifecycle}: ${files}${typeof omittedFiles === "number" && omittedFiles > 0 ? `; ${omittedFiles} file(s) omitted` : ""}`,
      ),
    ];
  }
  if (item.type === "mcpToolCall") {
    return [
      bounded(
        `${lifecycle}: ${valueText(item.value, "server") ?? "unknown"}/${valueText(item.value, "tool") ?? "tool"} (MCP status updated)`,
      ),
    ];
  }
  if (item.type === "subAgentActivity")
    return [
      bounded(
        `${lifecycle}: ${valueText(item.value, "label") ?? "Subagent activity"}`,
      ),
    ];
  return [
    bounded(
      `${lifecycle}: ${valueText(item.value, "label") ?? "Item updated"}`,
    ),
  ];
}

export function renderTurnState(state: TurnState): readonly string[] {
  const lines = [
    `Thread: ${bounded(state.threadId, 504)}`,
    `Turn: ${bounded(state.turnId, 506)}`,
  ];
  for (const item of state.items.values()) lines.push(...renderItem(item));
  for (const command of state.observedCommands)
    lines.push(
      bounded(
        `Observed command: ${bounded(command.command)} (${bounded(command.cwd)}), exit ${command.exitCode ?? "pending"}`,
      ),
    );
  if (state.diff !== null) lines.push(bounded(`Final diff: ${state.diff}`));
  for (const warning of state.warnings)
    lines.push(bounded(`Warning: ${warning}`));
  const omissions = state as TurnState & {
    readonly omittedItems?: number;
    readonly omittedItemsComplete?: boolean;
    readonly omittedCommands?: number;
    readonly omittedWarnings?: number;
  };
  if (typeof omissions.omittedItems === "number" && omissions.omittedItems > 0)
    lines.push(
      `${omissions.omittedItemsComplete === false ? "At least " : ""}${omissions.omittedItems} item(s) omitted`,
    );
  if (
    typeof omissions.omittedCommands === "number" &&
    omissions.omittedCommands > 0
  )
    lines.push(`${omissions.omittedCommands} command(s) omitted`);
  if (
    typeof omissions.omittedWarnings === "number" &&
    omissions.omittedWarnings > 0
  )
    lines.push(`${omissions.omittedWarnings} warning(s) omitted`);
  lines.push(bounded(`Terminal status: ${state.terminalStatus}`));
  return lines;
}
