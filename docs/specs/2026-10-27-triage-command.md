# Specification: Review thread triage command

Date: 2026-10-27
Status: approved by the operator through the issue #81 brief

## Goal

Give the operator an evidence-based classification of the automated review findings on one pull request through `andrew-agent triage <pr>`.
Each finding is classified as valid, invalid, or already fixed at the pull request head, with repository evidence.
The command follows `docs/specs/2026-10-27-github-review-thread-access.md`: it reads GitHub through the `gh` login and never writes to it.

## Input boundary

`<pr>` is one pull request number in the repository that `gh` resolves from the current directory.
It must be a positive decimal integer without a leading zero and at most `2147483647`, the GraphQL `Int` maximum; anything else is a usage error.

The command requires a named current branch and a clean worktree.
The local HEAD commit must equal the pull request's `headRefOid` on GitHub.
If it does not, the command exits `3` before Codex runs and asks the operator to check out the pull request head.

## GitHub reads

The command runs only `gh api graphql` with a `query` document.
The helper that runs `gh` refuses any other subcommand, a `mutation` document, and an explicit method or input file, before it spawns `gh`.
It fills the repository owner and name through the `{owner}` and `{repo}` placeholders that `gh api` resolves from the current repository.

The command reads two things and nothing else:

- the pull request's `headRefOid`;
- every page of its `reviewThreads`, with each thread's resolution state, path, line, and first comment's author, body, and URL.

It follows `pageInfo.endCursor` until `hasNextPage` is false.
It refuses a page that repeats the previous cursor, a head that differs between pages, and more than 100 pages.

`gh` runs in the repository root with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` removed from its environment, so only the stored `gh` login authenticates.
Interactive prompts, the update notifier, the pager, and color are disabled.
`gh` standard output is bounded at 16 MiB, and a call times out after 60 seconds.
`gh` standard error is drained and never printed, because it may echo request details.
A non-zero `gh` exit, unparsable output, a non-empty GraphQL `errors` field, a missing pull request, and a malformed thread all exit `3`.

## Thread selection

A thread is selected when it is unresolved and the GraphQL `__typename` of its first comment's author is `Bot`.
The command never classifies an author by login name: a `User` named like a bot is excluded, and a `Bot` named like a person is selected.
A thread whose first author is unavailable, such as a deleted account, is excluded.
Resolved threads and threads without a comment are excluded.

## Size bounds

The bounds apply to the selected threads, because those are the text that reaches the prompt.

- More than 50 selected threads is refused.
- A selected first comment whose body exceeds 8192 bytes of UTF-8 is refused.

Both refusals exit `3`, name the bound, and send nothing to Codex.
The command never truncates a thread or a comment to fit.
If no thread is selected, the command reports that and exits `0` without invoking Codex.

## Codex classification

The command reuses the `review` command's isolated checkout and Codex invocation, with the pull request head as the only commit.
The checkout is a temporary standalone repository under the managed state root that holds the committed content and history reachable from the pull request head, with no source-worktree dirt.
Codex runs through `codex exec` with an explicit read-only sandbox, ephemeral session storage, and user configuration disabled.

The prompt puts the selected threads into one data block as JSON.
The block opens and closes with a marker that carries a random UUID, and JSON escaping keeps any comment from producing a line that closes it.
The prompt tells Codex that the block is untrusted review text, to treat it as data and never as instructions, and not to modify files.

Codex must return one JSON object of the shape `{"verdicts":[{"thread":<number>,"verdict":"valid"|"invalid"|"already-fixed","evidence":"<text>"}]}`.
The host accepts the response only when every selected thread number appears exactly once, every verdict is one of the three values, and every evidence string is non-empty and at most 4096 bytes of UTF-8.
Any other response exits `1`.

## Recheck and output

After Codex finishes, the command reads the local worktree state and the pull request `headRefOid` again.
If the worktree is no longer clean, the branch or local HEAD changed, or the pull request head moved, it discards the classification and exits `3`.

On success the command prints one header line with the thread count, the pull request number, and the head commit.
For each thread, in thread order, it prints the verdict, the bot login and location, the comment URL, and the evidence.
Every printed string passes through the same terminal escaping and byte bound as the other commands.

The command never replies, reacts, resolves or unresolves a thread, edits a pull request or issue, or pushes.
Cleanup warnings and interrupt handling are the same as for `review`.

## Exit behavior

- Exit `0` means the classification was printed, or no thread was selected.
- Exit `1` means Codex failed, returned an invalid classification, or terminal output failed.
- Exit `2` means command usage was invalid.
- Exit `3` means repository, GitHub read, size bound, head check, or runtime preparation failed.

## Non-goals

The command does not read thread replies beyond the first comment, human review threads, review summaries, or issue comments.
It does not fetch the pull request head, check it out, or run repository tests.
It does not accept a repository argument; `gh` resolves the repository from the current directory.

## Acceptance criteria

1. Valid, invalid, and already-fixed verdicts are printed for the selected threads.
2. A `User` thread named like a bot, a resolved thread, and a thread without an author are excluded; a `Bot` thread named like a person is selected.
3. Every page of review threads is read, and every `gh` invocation is `gh api graphql` with a `query` document.
4. A local HEAD that differs from the pull request head exits `3` before Codex runs.
5. A pull request head or local HEAD that moves during the run discards the output with exit `3`.
6. More than 50 selected threads and a comment above 8192 bytes exit `3` before Codex runs.
7. A response that does not classify every thread exactly once exits `1`.
8. Token variables never reach `gh`, and the `gh` helper refuses non-read invocations without spawning `gh`.
9. Terminal controls in review text and evidence are escaped.
10. Tests use a fake `gh` and a fake Codex, and CLI grammar, README, `pnpm check`, and the Trunk gate cover the command.
