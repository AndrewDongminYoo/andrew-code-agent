# Specification: Fix verification command

Date: 2026-10-29 Status: approved by the operator on 2026-10-29 through the `/pr-loop` plan gate

## Goal

Show that the tests on the current branch catch its fix through `andrew-agent verify-fix [base] [--with <path>]... [--test <path>]... -- <command> [args...]` (issue #83).
The command runs the operator's test command twice: once with the production changes reverted and once at HEAD.
It follows the boundary in `docs/specs/2026-10-27-repository-test-command-boundary.md` and does not widen it.

## Input

The command runs in the current Git repository and requires a named current branch and a clean worktree.
With no positional argument, it resolves the symbolic `refs/remotes/origin/HEAD` reference as the base, as `review` and `pr` do; one positional argument selects another base ref.
It resolves the exact HEAD, branch ref, base commit, and merge base, and reads only the committed three-dot changes between the merge base and HEAD.
Rename detection is off, so a renamed path counts as one deleted path and one added path.

The test command is everything after the first `--`, passed as an argument vector without a shell.
The command does not read a test command from the repository or from any configuration file, and Codex never chooses or changes it.
Without `--`, or with nothing after it, the usage is invalid.

## Classification

Each changed path is a test path or a production path.

- By default, a path is a test path when a directory above it is named `test`, `tests`, `__tests__`, or `spec`, or when its file name contains `.test.`, `.spec.`, or `_test.`.
- Any `--test <path>` replaces the defaults: a changed path is a test path only when it equals a named path or lies under it.
  A named path must be relative and must not contain a `..` segment.
- The command refuses with exit `3` when the test set or the production set is empty.

## Checkouts

The command creates one private temporary directory under the real path of the system temporary directory and removes it at the end.
It does not use the managed runtime state, because this command never runs Codex.
Inside it, two isolated checkouts are built the same way `review` builds its checkout: a standalone repository, only the exact commits fetched, system and global Git configuration ignored, and tracked symlinks written as plain files.

- Checkout A is HEAD with every production path restored to its merge-base state in the index and the worktree.
  Modified files are reverted, added files are removed, and deleted files come back.
  The command then checks that the index differs from the merge base only in the test paths and that the worktree matches the index.
- Checkout B is HEAD unchanged.

Each `--with <path>` is cloned from the source worktree into both checkouts with APFS copy-on-write (`cp -c -R`), which is how a dependency directory such as `node_modules` reaches the runs.
The command refuses, with exit `3`, a path that is absolute, empty, the worktree root, contains a `..` segment, names a `.git` directory, does not exist, resolves outside the source worktree, is tracked or contains tracked files under its own name or under the path it resolves to, overlaps another `--with` path, or already exists in a checkout.
Copy-on-write cloning works only inside one APFS volume; if `cp -c` fails, the command refuses and never falls back to a full copy.

## Sandbox

Each run executes under `/usr/bin/sandbox-exec` with this profile:

```plaintext
(version 1)
(allow default)
(deny network*)
(deny file-read* (subpath (param "SOURCE")))
(deny file-write*)
(allow file-write* (subpath (param "CHECKOUT")) (subpath (param "TMPDIR")) (literal "/dev/null"))
```

`SOURCE` is the real path of the source worktree, `CHECKOUT` is that run's checkout, and `TMPDIR` is a dedicated temporary directory for that run, all passed with `-D` so a path never becomes profile text.
All network access is denied, loopback and DNS included.
File writes are allowed only inside the run's checkout and its temporary directory, plus `/dev/null`, which discards what is written and keeps shell redirections working; writes to `/dev/tty` are refused.
Reads of the source worktree are denied, so a symbolic link in a `--with` clone that points back into the source worktree, at any depth, cannot show a run the source worktree's files; other reads are not restricted.
The command runs with the checkout as its working directory, no standard input, and an environment of only `PATH`, `HOME`, `LANG`, and `LC_ALL` from the caller plus `TMPDIR` set to the run's temporary directory.

Before the first run, the command runs `/usr/bin/true` under the same profile and parameters.
If `sandbox-exec` is missing or not executable, or that probe does not exit `0`, the command refuses with exit `3` and does not run the test command.

Measured on macOS 27.0.1 with Git 2.54.0 on 2026-10-29: under this profile, `curl https://github.com` exited `6`, a TCP connection to `127.0.0.1` failed with `EPERM`, and a write outside the allowed paths failed with `Operation not permitted`.
Creating a hard link inside the checkout to a file outside it, writing through a symbolic link that points outside, and renaming an outside file into the checkout were each refused with `Operation not permitted`, and the outside file stayed unchanged.
Under the same profile, `node --test` ran and wrote inside the checkout and `TMPDIR`.
With the source read deny and without the `/dev/tty` and `/dev/dtracehelper` write allowances, measured on the same day: `cat` through an absolute symbolic link from the checkout into `SOURCE`, `ls`, and `stat` of `SOURCE` each failed with `Operation not permitted`, a write to `/dev/tty` was refused, a write to `/dev/null` succeeded, and `node --test` still ran.
A first attempt that allowed only loopback also let `github.com` through, which is why the operator chose to deny all network access.

## Limits

Each run has a limit of 10 minutes and 1 MiB of combined standard output and standard error.
The command starts each run in its own process group.
On a timeout it kills the whole process group and reports the run as timed out; on the output limit it does the same and reports that the limit was exceeded.
After the main process exits, anything left in its process group is killed as well.
A timeout, an exceeded output limit, a termination by a signal the command did not send, and a command that `sandbox-exec` could not start are neither a pass nor a fail.

## Verdict

Run A runs first and run B second; both run even when run A did not fail.
An interrupt (`SIGINT`), a termination (`SIGTERM`), or a hangup (`SIGHUP`) during preparation or a run stops the current run's process group, starts no further run, removes the checkouts, and exits `1` without a verdict.

- Exit `0` only when run A exited with a nonzero status and run B exited with status `0`.
- Exit `1` for every other combination, with one line for each expectation that did not hold.
- Exit `2` for invalid usage.
- Exit `3` for any preparation failure: repository state, comparison, classification, `--with` validation, checkout construction, the sandbox probe, or the recheck below.

The output shows the comparison identities, the number of test and production paths, each run's status, and the last 2 KiB of each run's combined output with every terminal control character escaped.

After both runs, the command rechecks HEAD, the branch ref, the base commit, the merge base, the classified paths, and worktree cleanliness.
If any of them moved, it discards the verdict with exit `3`.
It never edits the source worktree.
It removes both checkouts before reporting and prints a redacted warning if that cleanup fails, without changing the exit code.

## Acceptance criteria

1. A test that fails without the fix and passes with it exits `0`.
2. A test that passes without the fix, or fails with it, exits `1` and names the expectation that failed.
3. Checkout A restores modified, added, deleted, and renamed production paths to the merge base.
4. A network call from the test command fails under the sandbox, proven against a local listener that the same command reaches without the sandbox.
5. A write outside the checkout is refused, directly, through a hard link, and through a symbolic link, and a read of the source worktree is refused, directly and through a symbolic link in a `--with` clone.
6. A timeout kills the process group, including a background grandchild, and an exceeded output limit stops the run; neither counts as a pass or a fail.
7. `--with` clones an ignored path into both checkouts and refuses the paths listed above.
8. An empty test set or production set, a missing sandbox, a sandbox that cannot be applied, and a comparison that moved during the runs exit `3`.
9. An interrupt, a termination, or a hangup during a run removes the checkouts and exits `1` without a verdict.
10. CLI grammar, README, focused integration tests, `pnpm check`, and the Trunk gate cover the command.
