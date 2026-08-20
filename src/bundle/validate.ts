import type { BundleManifest } from "./manifest.js";
import type { ResolvedSourceFile } from "./source-tree.js";

export type ValidationErrorCode =
  | "FORBIDDEN_LITERAL"
  | "FORBIDDEN_PATH_SEGMENT"
  | "TRUSTED_HOOK_HASH"
  | "RUNTIME_IDENTIFIER"
  | "UNRESOLVED_TOKEN"
  | "INVALID_UTF8"
  | "PRIVATE_KEY"
  | "CREDENTIAL_ASSIGNMENT"
  | "GITHUB_TOKEN"
  | "OPENAI_API_KEY";

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;

  constructor(code: ValidationErrorCode, targetPath: string, ruleId: string) {
    super(`Portable file ${targetPath} violates ${ruleId}.`);
    this.name = "ValidationError";
    this.code = code;
  }
}

const trustedHookHash =
  /\b(?:trusted[_-]?hook[_-]?hash|hook[_-]?trust(?:ed)?[_-]?hash)\s*["']?\s*(?:=|:)/iu;
const runtimeIdentifier =
  /\b(?:session|thread|rollout)(?:[_-]?id)?\s*["']?\s*(?:=|:)\s*["']?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9_-]{12,})\b/iu;

export function validatePortableFiles(
  files: readonly ResolvedSourceFile[],
  manifest: BundleManifest,
): void {
  const forbiddenSegments = new Set(
    manifest.forbiddenPathSegments.map(normalizeSegment),
  );
  const allowedTokens = new Set(manifest.allowedTokens);
  const declaredPatterns = new Set(manifest.forbiddenPatternIds);

  for (const file of files) {
    assertSafePath(file.targetPath, forbiddenSegments);
    const content = decodePortableContent(file);
    assertNoForbiddenLiteral(
      file.targetPath,
      content,
      manifest.forbiddenLiterals,
    );
    assertNoForbiddenContentPath(file.targetPath, content, forbiddenSegments);
    assertNoRuntimeState(file.targetPath, content);
    assertResolvedTokens(file.targetPath, content, allowedTokens);
    assertNoSecretPattern(file.targetPath, content, declaredPatterns);
  }
}

function decodePortableContent(file: ResolvedSourceFile): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new ValidationError("INVALID_UTF8", file.targetPath, "invalid-utf8");
  }
}

function assertSafePath(
  targetPath: string,
  forbiddenSegments: ReadonlySet<string>,
): void {
  for (const segment of targetPath.split("/")) {
    if (isForbiddenPathSegment(segment, forbiddenSegments)) {
      throw new ValidationError(
        "FORBIDDEN_PATH_SEGMENT",
        targetPath,
        "forbidden-path-segment",
      );
    }
  }
}

function assertNoForbiddenLiteral(
  targetPath: string,
  content: string,
  forbiddenLiterals: readonly string[],
): void {
  if (
    forbiddenLiterals.some(
      (literal) => literal.length > 0 && content.includes(literal),
    )
  ) {
    throw new ValidationError(
      "FORBIDDEN_LITERAL",
      targetPath,
      "forbidden-literal",
    );
  }
}

function assertNoForbiddenContentPath(
  targetPath: string,
  content: string,
  forbiddenSegments: ReadonlySet<string>,
): void {
  for (const match of content.matchAll(
    /(?:~\/|\/|(?:[A-Za-z0-9._-]+\/)+)[^\s"'`<>),;\]}]*/gu,
  )) {
    const path = match[0];
    const segments = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(normalizeSegment);
    const lastSegment = segments.at(-1);
    if (
      segments.some((segment) =>
        isForbiddenPathSegment(segment, forbiddenSegments),
      ) ||
      (lastSegment !== undefined &&
        isForbiddenPathSegment(lastSegment, forbiddenSegments))
    ) {
      throw new ValidationError(
        "FORBIDDEN_PATH_SEGMENT",
        targetPath,
        "forbidden-path-segment",
      );
    }
  }
}

function isForbiddenPathSegment(
  segment: string,
  forbiddenSegments: ReadonlySet<string>,
): boolean {
  const normalizedSegment = normalizeSegment(segment);
  return (
    forbiddenSegments.has(normalizedSegment) ||
    [...forbiddenSegments].some(
      (marker) => marker.startsWith(".") && normalizedSegment.endsWith(marker),
    )
  );
}

function assertNoRuntimeState(targetPath: string, content: string): void {
  if (trustedHookHash.test(content)) {
    throw new ValidationError(
      "TRUSTED_HOOK_HASH",
      targetPath,
      "trusted-hook-hash",
    );
  }
  if (runtimeIdentifier.test(content)) {
    throw new ValidationError(
      "RUNTIME_IDENTIFIER",
      targetPath,
      "runtime-identifier",
    );
  }
}

function assertResolvedTokens(
  targetPath: string,
  content: string,
  allowedTokens: ReadonlySet<string>,
): void {
  for (const match of content.matchAll(/\$\{([^}\r\n]*)\}/gu)) {
    if (!allowedTokens.has(match[1] ?? "")) {
      throw new ValidationError(
        "UNRESOLVED_TOKEN",
        targetPath,
        "unresolved-token",
      );
    }
  }
  if (content.replace(/\$\{([^}\r\n]*)\}/gu, "").includes("${")) {
    throw new ValidationError(
      "UNRESOLVED_TOKEN",
      targetPath,
      "unresolved-token",
    );
  }
}

function assertNoSecretPattern(
  targetPath: string,
  content: string,
  declaredPatterns: ReadonlySet<string>,
): void {
  for (const pattern of secretPatterns) {
    if (declaredPatterns.has(pattern.id) && pattern.expression.test(content)) {
      throw new ValidationError(pattern.code, targetPath, pattern.id);
    }
  }
}

const secretPatterns: readonly {
  readonly id: string;
  readonly code: ValidationErrorCode;
  readonly expression: RegExp;
}[] = [
  {
    id: "private-key",
    code: "PRIVATE_KEY",
    expression: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u,
  },
  {
    id: "credential-assignment",
    code: "CREDENTIAL_ASSIGNMENT",
    expression:
      /\b(?:(?:[a-z0-9]+[_-])*(?:credential|password|passwd|pwd|secret|token|api[_-]?key)|aws_secret_access_key)\b\s*["']?\s*(?:=|:)\s*["']?[^\s"']{8,}/iu,
  },
  {
    id: "github-token",
    code: "GITHUB_TOKEN",
    expression: /\b(?:gh[psour]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  },
  {
    id: "openai-api-key",
    code: "OPENAI_API_KEY",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
];

function normalizeSegment(segment: string): string {
  return segment.normalize("NFC").toLowerCase();
}
