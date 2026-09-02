import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Total file bytes the walk will read from one pair of trees. The committed
 * trees measure about 3.7 MB at the pinned Codex version, and the freshly
 * generated pair doctor compares against them is written by a spawned child,
 * so each file's size is checked before it is read.
 */
const maxContractBytes = 32 * 1024 * 1024;

/** Files one pair of trees may hold. The committed pair holds 1003. */
const maxContractFiles = 100_000;

export interface CodexContractRoots {
  /** Root that `codex app-server generate-ts` writes. */
  readonly generated: string;
  /** Root that `codex app-server generate-json-schema` writes. */
  readonly schemas: string;
}

/**
 * Digests the two trees the Codex app-server generator owns, so a binary that
 * reports the pinned version while emitting a different contract can be told
 * apart from the pinned one.
 *
 * File modes are deliberately excluded. Git records only the executable bit,
 * so the same tree materializes at 0644 or 0600 depending on the checkout's
 * umask; the contract is the paths and their bytes.
 *
 * Throws when either root is not an ordinary directory, when a tree holds
 * anything but directories and regular files, or when the pair exceeds the
 * file-count or byte budget. A symlinked root is refused rather than followed,
 * so a child that links the committed trees into its output directory instead
 * of generating them cannot pass.
 */
export async function codexContractDigest(
  roots: CodexContractRoots,
): Promise<string> {
  const hash = createHash("sha256");
  updateFrame(hash, "andrew-code-agent.codex-contract.v1");
  let remainingBytes = maxContractBytes;
  let remainingFiles = maxContractFiles;
  for (const [label, root] of [
    ["generated", roots.generated],
    ["schemas", roots.schemas],
  ] as const) {
    await requireOrdinaryDirectory(root);
    const files: string[] = [];
    await collectFiles(root, "", files, () => {
      remainingFiles -= 1;
      if (remainingFiles < 0)
        throw new Error("contract tree holds too many files");
    });
    updateFrame(hash, label);
    updateFrame(hash, files.length.toString());
    for (const path of files) {
      const absolute = join(root, path);
      remainingBytes -= (await stat(absolute)).size;
      if (remainingBytes < 0) throw new Error("contract tree too large");
      updateFrame(hash, path);
      updateFrame(hash, await readFile(absolute));
    }
  }
  return hash.digest("hex");
}

async function requireOrdinaryDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("contract tree root is not an ordinary directory");
  }
}

/** Appends the relative paths of every regular file, in sorted tree order. */
async function collectFiles(
  root: string,
  prefix: string,
  files: string[],
  count: () => void,
): Promise<void> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(root, path, files, count);
    } else if (entry.isFile()) {
      count();
      files.push(path);
    } else {
      throw new Error("unsupported contract tree entry");
    }
  }
}

function updateFrame(
  hash: ReturnType<typeof createHash>,
  value: string | Uint8Array,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}
