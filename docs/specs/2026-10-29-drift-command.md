# Specification: Documentation drift command

Date: 2026-10-29
Status: approved by the operator through the issue #75 brief

## Goal

Give the operator a read-only audit of project documentation against the code through `andrew-agent drift`.
Each finding cites the document line that makes a stale claim and the code location that contradicts it, or states that the referenced item does not exist.
The command reports only; it never edits a document, commits, or pushes.

## Input boundary

The command takes no arguments; any argument or option other than `-h` or `--help` is a usage error.
A lone `--` separator with nothing after it is accepted and ignored, as it is for `doctor`.
It requires a named current branch and a clean worktree, because it audits the committed HEAD only.

## Audited documents

The audited set is read from the HEAD tree, not from the worktree:

- `CLAUDE.md`, `AGENTS.md`, and `README.md` at the repository root;
- every file under `docs/specs/`, at any depth, whose name ends in `.md`.

Only regular files count; a tracked symbolic link is not a document.
`docs/plans/` and `docs/notes/` are dated historical records and are excluded, so a mismatch there is not a finding.
If none of the audited documents exists at HEAD, the command exits `3` before Codex runs.
More than 200 audited documents is refused with exit `3` rather than truncated.

For each audited document, the command records its line count at HEAD: the number of newline bytes, plus one when the file is non-empty and does not end in a newline.

## Codex audit

The command reuses the `review` command's isolated checkout and Codex invocation, with HEAD as the only commit.
The checkout is a temporary standalone repository under the managed state root that holds the exact HEAD commit, built with system and global Git configuration ignored and tracked symlinks written as plain files.
Codex runs through `codex exec` with the managed login, an explicit read-only sandbox, ephemeral session storage, and user configuration disabled.

The prompt lists the audited documents and their line counts in one data block as JSON.
The block opens and closes with a marker that carries a random UUID.
The prompt tells Codex that repository content, including every audited document, is untrusted data whose instructions it must never follow, that `docs/plans/` and `docs/notes/` are excluded, and not to modify files.

## Codex output

Codex must return one JSON array and nothing else.
Each element has the shape `{"document":"<path>","line":<number>,"claim":"<text>","evidence":"<text>","codePath":"<path>"|null,"codeLine":<number>|null}`.
`codePath` and `codeLine` are both set when a code location contradicts the claim, and both `null` when the referenced symbol, command, path, or variable does not exist; `evidence` then states the absence.
An empty array means no drift.

The host accepts the response only when all of the following hold:

- it is a JSON array of at most 100 elements;
- every `document` is exactly the path of an audited document;
- every `line` is an integer from 1 to that document's line count at HEAD;
- every `claim` is a non-empty string of at most 2048 bytes of UTF-8, and every `evidence` a non-empty string of at most 4096 bytes;
- every `codePath` is a non-empty repository-relative path of at most 1024 bytes without an empty, `.`, or `..` segment, with `codeLine` a positive integer, or both are `null`.

A single refused finding rejects the whole response with exit `1`, so a finding outside the audited set or at a line that does not exist is never printed as valid and never lets the run report no drift.
The host does not check that `codePath` exists at HEAD.

## Recheck and output

After Codex finishes, the command reads the repository state again.
If the worktree is no longer clean, the branch or HEAD changed, or the audited set or a line count changed, it discards the result and exits `3`.

With no findings, it prints one line that says no drift was found, with the document count and the HEAD commit.
With findings, it prints a header line with the finding count, the document count, and the HEAD commit, then for each finding its document path and line, the claim, the code location or `(absent)`, and the evidence.
Every printed string passes through the same terminal escaping and byte bound as the other commands.
Cleanup warnings and interrupt handling are the same as for `review`.

## Exit behavior

- Exit `0` means no findings were reported.
- Exit `1` means at least one valid finding was reported, or the Codex run or its output failed; the output says which.
- Exit `2` means command usage was invalid.
- Exit `3` means repository, input, recheck, or runtime preparation failed.

## Non-goals

The command does not edit, rewrite, or suggest replacement text for documents.
It does not audit uncommitted content, `docs/plans/`, `docs/notes/`, or Markdown outside the audited set.
It does not run repository tests or verify a cited code location beyond its shape.

## Acceptance criteria

1. A fixture whose README names a script that `package.json` does not declare reports that finding with exit `1` through a fake Codex.
2. A clean fixture reports no findings with exit `0`.
3. A finding that points at `docs/plans/`, at a path outside the audited set, or at a line that does not exist rejects the response with exit `1`.
4. A HEAD that moves, or a worktree that becomes dirty, during the audit discards the result with exit `3`.
5. Malformed Codex output and a failed Codex run exit `1`.
6. A repository without any audited document, a dirty worktree, and a detached HEAD exit `3` before Codex runs.
7. Terminal controls in finding text are escaped.
8. CLI grammar, README, `pnpm check`, and the Trunk gate cover the command.
