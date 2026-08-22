const TERMINAL_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function escapeTerminalPart(part: string): string {
  if (!TERMINAL_CONTROL_PATTERN.test(part)) return part;
  const codePoint = part.codePointAt(0);
  if (codePoint === undefined) return "";
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint <= 0xff ? `\\x${hex.padStart(2, "0")}` : `\\u{${hex}}`;
}

export function escapeTerminalControls(value: string): string {
  const result: string[] = [];
  for (const part of value) result.push(escapeTerminalPart(part));
  return result.join("");
}

export function fitsEscapedTerminalBytes(
  value: string,
  limit: number,
): boolean {
  let byteLength = 0;
  for (const part of value) {
    byteLength += Buffer.byteLength(escapeTerminalPart(part), "utf8");
    if (byteLength > limit) return false;
  }
  return true;
}

export function boundedTerminalText(
  value: string,
  limit: number,
  truncationMarker: string,
): string {
  const parts: string[] = [];
  let byteLength = 0;
  for (const part of value) {
    const escaped = escapeTerminalPart(part);
    const escapedBytes = Buffer.byteLength(escaped, "utf8");
    if (byteLength + escapedBytes <= limit) {
      parts.push(escaped);
      byteLength += escapedBytes;
      continue;
    }
    const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
    while (parts.length > 0 && byteLength + markerBytes > limit) {
      byteLength -= Buffer.byteLength(parts.pop() ?? "", "utf8");
    }
    return byteLength + markerBytes <= limit
      ? `${parts.join("")}${truncationMarker}`
      : "";
  }
  return parts.join("");
}
