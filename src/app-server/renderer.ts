import type { ItemState, TurnState } from "./reducer.js";
import { boundedTerminalText, escapeTerminalPart } from "./terminal.js";

// Escaped bytes, not characters: boundedTerminalText counts what reaches the
// terminal, and a Korean character costs three while a newline costs the four
// of a literal \x0A. Every rendered line stays within this bound.
const MAX_RENDERED_VALUE = 512;
// A completed message is emitted across as many bounded lines as it needs. The
// cap exists for a value handed straight to the renderer, not for one the
// reducer produced, so it has to clear anything the reducer retains: 4096
// UTF-16 code units, at most 8 escaped bytes each (`\u{2028}` is the worst
// measured), against the smallest chunk budget a maximal lifecycle prefix
// leaves. A smaller cap would discard a message the product deliberately kept.
const MAX_RETAINED_TEXT_BYTES = 4096 * 8;
const MIN_CHUNK_BUDGET = 64;
const MAX_MESSAGE_LINES =
  Math.ceil(MAX_RETAINED_TEXT_BYTES / MIN_CHUNK_BUDGET) + 1;
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

// The whole message reaches the operator, but never as one unbounded write:
// it is split on character boundaries into lines that each satisfy the same
// byte bound as every other rendered line. Escaping happens per part and the
// walk stops at the line cap, so a hostile value is never materialised — the
// property `boundedTerminalText` exists to hold.
function messageLines(lifecycle: string, text: string): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  const budget = Math.max(
    MIN_CHUNK_BUDGET,
    MAX_RENDERED_VALUE - Buffer.byteLength(lifecycle, "utf8") - 16,
  );
  for (const part of text) {
    const escaped = escapeTerminalPart(part);
    const size = Buffer.byteLength(escaped, "utf8");
    if (bytes + size > budget) {
      if (chunks.length + 1 === MAX_MESSAGE_LINES) {
        chunks.push(`${current}${TRUNCATION_MARKER}`);
        current = "";
        break;
      }
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += escaped;
    bytes += size;
  }
  if (current !== "") chunks.push(current);
  if (chunks.length <= 1) return [bounded(`${lifecycle}: ${chunks[0] ?? ""}`)];
  // Every line repeats the lifecycle and carries its own ordinal, because
  // reportTurnState skips a line it has already written keyed on the whole
  // string: two chunks that happened to be identical would be dropped and the
  // answer silently corrupted.
  return chunks.map((chunk, index) =>
    bounded(`${lifecycle} [${index + 1}/${chunks.length}]: ${chunk}`),
  );
}

function renderItem(item: ItemState): readonly string[] {
  const lifecycle = `${bounded(item.id, 128)} ${bounded(item.type, 128)} ${item.phase}`;
  // While a text item is still streaming its own value is a growing prefix of
  // the final one, and rendering it produced a near-identical line per delta.
  // `reasoning` below already renders a constant in flight; these do the same,
  // and the text arrives once, whole, when the item completes.
  if (item.type === "agentMessage" || item.type === "plan") {
    if (item.phase !== "completed")
      return [
        bounded(
          `${lifecycle}: ${item.type === "plan" ? "Plan" : "Message"} updated`,
        ),
      ];
    const text = record(item.value)?.text;
    return messageLines(lifecycle, typeof text === "string" ? text : "");
  }
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
