---
name: codex-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Codex on any task. Also use PROACTIVELY when an independent, non-Claude perspective from Codex would add value — second opinions on code, plans, architecture, or design decisions.
---

# codex-collab

codex-collab is a bridge between Claude and Codex. It communicates with Codex via the `codex app-server` JSON-RPC protocol, giving you structured, event-driven access to Codex's capabilities — prompting, code review, tool use, and file editing.

## Collaboration Modes

- **Run** — Single-command `run` for any prompted task (research, analysis, implementation). Starts a thread, sends prompt, waits for completion, returns output.
- **Code review** — Single-command `review` for PR-style, uncommitted, or commit-level review.
- **Parallel work** — You and Codex work on different parts simultaneously. Start multiple threads.
- **Research** — Spin up a read-only Codex session to investigate something while you continue other work.

## Run Command (Recommended for Prompted Tasks)

The `run` command handles prompted tasks in one call: starts a thread, sends the prompt, waits for the turn to complete, and prints output.

```bash
# Research task
codex-collab run "what does this project do?" -s read-only --content-only

# Implementation task
codex-collab run "add input validation to the login form" --content-only

# Resume an existing thread (preserves conversation context)
codex-collab run --resume <id> "now check the error handling" --content-only

# Specify working directory (omit -d if already in the project dir)
codex-collab run "investigate the auth module" -d /path/to/project --content-only
```

**IMPORTANT — Execution rules for ALL `codex-collab` Bash commands:**
- Always use `dangerouslyDisableSandbox=true` — the tool writes to `~/.codex-collab/` which is outside the sandbox allowlist.
- For `run` and `review`: also use `run_in_background=true` — these take minutes. After launching, tell the user it's running and end your turn. **While running**: do NOT poll, block, wait, or spawn an agent to monitor — you will be notified automatically when the task finishes. If other tasks complete while Codex is running, handle them normally without checking on Codex. **When notified**: read the completed task's output (the notification includes it or use `Read` on the output file), then present the results to the user.
- For all other commands (`kill`, `threads`, `progress`, `output`, `approve`, `decline`, `clean`, `delete`, `models`, `health`): run in the **foreground** — they complete in seconds.

If the user asks about progress mid-task, use `TaskOutput(block=false)` to read the background output stream, or:

```bash
codex-collab progress <id>
```

## Code Review

**For a standard PR review, call `review` with NO prompt string.** The default `pr` mode runs the built-in structured diff workflow against the default branch:

```bash
# PR-style review against default branch (default — NO prompt)
codex-collab review -d /path/to/project --content-only

# Review uncommitted changes
codex-collab review --mode uncommitted -d /path/to/project --content-only

# Review a specific commit
codex-collab review --mode commit --ref abc1234 -d /path/to/project --content-only
```

**Passing a prompt string flips to `custom` mode** — it sends your text as free-form instructions and bypasses the built-in diff workflow. Use this when a focused or targeted review fits better than the default diff workflow (e.g., "review this for security issues", "check the error handling only"). Default to `pr` mode for general PR reviews:

```bash
codex-collab review "Focus on security issues in auth" -d /path/to/project --content-only
```

**Reviews are one-shot.** Each `review` call runs a single review inside a transient review sub-thread and exits — you cannot continue the review itself or ask the reviewer follow-up questions. For follow-ups on findings, use `run --resume <id>` with the relevant review output in the prompt.

`review --resume <id>` is useful for running a review with context from a task thread Codex has already been working in. It forks that context into an ephemeral read-only review thread, so the original task thread is not reconfigured or mutated. `review` with no `--resume` creates an ephemeral thread that disappears after the review — use this for standalone reviews with no prior context.

Review modes: `pr` (default), `uncommitted`, `commit`, `custom`

## Context Efficiency

- **Use `--content-only`** when reading output — prints only the result text, suppressing progress lines.
- **`run` and `review` print results on completion** — no separate `output` call needed.
- **Use `output <id>`** only to re-read the full log for a previously completed thread.

## Resuming Threads

When consecutive tasks relate to the same project, resume the existing thread. Codex retains the conversation history, so follow-ups like "now fix what you found" or "check the tests too" work better when Codex already has context from the previous exchange. Start a fresh thread when the task is unrelated or targets a different project.

**If the user asks to continue or follow up on a prior task but you don't have the thread ID in context**, follow this discovery flow:

1. `codex-collab threads --discover` — see top 5 recent threads (server + local).
2. If unsure which thread is right, `codex-collab peek <id>` to see the last exchange of a candidate.
3. For very long threads where peek alone isn't enough, spawn a subagent with `codex-collab peek <id> --limit 100 --full` and ask it to summarize. This keeps the firehose out of your own context.
4. `codex-collab run --resume <id> "..."` to continue.

Only run `--discover` when a resume is actually wanted — it's a lookup performed on demand.

The `--resume` flag accepts both ID formats:
- `--resume <short-id>` — 8-char hex short ID (supports prefix matching, e.g., `a1b2`)
- `--resume <thread-id>` — Full Codex thread ID (UUID, e.g., `019d680c-7b23-7f22-ab99-6584214a2bed`)

| Situation | Action |
|-----------|--------|
| Same project, new prompt | `codex-collab run --resume <id> "prompt"` |
| Same project, want review | `codex-collab review --resume <id>` |
| Different project | Start new thread |
| Thread stuck / errored | `codex-collab kill <id>` then start new |

If you've lost track of the thread ID, use `codex-collab threads` to find active threads.

## Checking Progress

If the user asks about a running task, use `TaskOutput(block=false)` (with the background task ID returned when launching the command) to read the output stream. The codex-collab thread short ID appears in the first progress line (e.g., `[codex] Thread a1b2c3d4 started`) — handy when you need it but don't have it. If you need just the tail of the log without the full stream:

```bash
codex-collab progress <thread-id>
```

Note: `<thread-id>` is the codex-collab thread short ID (8-char hex from the output), not the Claude Code background task ID. If you don't have it, run `codex-collab threads`.

Progress lines stream in real-time during execution:
```
[codex] Thread a1b2c3d4 started (gpt-5.4, workspace-write)
[codex] Turn started
[codex] Running: npm test
[codex] Edited: src/auth.ts (update)
[codex] Turn completed (2m 14s, 1 file changed)
```

## Approvals

By default, Codex auto-approves all actions (`--approval never`). For stricter control:

```bash
# Require approval for Codex-initiated actions
codex-collab run "refactor the auth module" --approval on-request --content-only
```

When an approval is needed, the progress output will show:
```
[codex] APPROVAL NEEDED
[codex]   Command: rm -rf node_modules
[codex]   Approve: codex-collab approve <approval-id>
[codex]   Decline: codex-collab decline <approval-id>
```

Respond with `approve` or `decline`:
```bash
codex-collab approve <approval-id>
codex-collab decline <approval-id>
```

## CLI Reference

### Run

```bash
codex-collab run "prompt" [options]               # New thread, send prompt, wait, print output
codex-collab run --resume <id> "prompt" [options]  # Resume existing thread
codex-collab run "prompt" -s read-only             # Read-only sandbox
```

### Review

```bash
codex-collab review [options]                      # PR-style (default)
codex-collab review --mode uncommitted [options]   # Uncommitted changes
codex-collab review --mode commit [options]        # Latest commit
codex-collab review --mode commit --ref <hash>     # Specific commit
codex-collab review "instructions" [options]       # Custom review
codex-collab review --resume <id> [options]        # Resume existing thread
```

### Reading Output

```bash
codex-collab output <id>                # Full log for thread
codex-collab progress <id>              # Recent activity (tail of log)
```

### Thread Management

```bash
codex-collab threads                    # List threads (current session)
codex-collab threads --all              # List all threads (no display limit)
codex-collab threads --discover         # Discover threads from Codex server (top 5 by default)
codex-collab peek <id>                  # Show last exchange (default) from server
codex-collab peek <id> --limit 10 --full  # Show 10 items including non-message types
codex-collab kill <id>                  # Stop a running thread
codex-collab delete <id>               # Archive thread, delete local files
codex-collab clean                      # Delete old logs and stale mappings
```

Note: `jobs` still works as a deprecated alias for `threads`.

### Utility

```bash
codex-collab config                     # Show persistent defaults
codex-collab config model gpt-5.3-codex # Set default model
codex-collab config model --unset       # Unset a key (return to auto)
codex-collab config --unset             # Unset all keys (return to auto)
codex-collab models                     # List available models
codex-collab approve <id>              # Approve a pending request
codex-collab decline <id>              # Decline a pending request
codex-collab health                     # Check prerequisites
```

### Options

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Model name (default: auto — latest available) |
| `-r, --reasoning <level>` | Reasoning effort: low, medium, high, xhigh (default: auto — highest for model) |
| `-s, --sandbox <mode>` | Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `-d, --dir <path>` | Working directory (default: cwd) |
| `--resume <id>` | Resume existing thread (run and review) |
| `--timeout <sec>` | Turn timeout in seconds (default: 1200). Do not lower this — Codex tasks routinely take 5-15 minutes. Increase for large reviews or complex tasks. |
| `--approval <policy>` | Approval policy: never, on-request, on-failure, untrusted (default: never) |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for --mode commit |
| `--all` | List all threads with no display limit (threads command) |
| `--discover` | Query Codex server for threads not in local index (threads command) |
| `--json` | JSON output (threads, peek commands) |
| `--full` | Include all item types in peek output (default shows messages only) |
| `--template <name>` | Prompt template for run command (checks `~/.codex-collab/templates/` first, then built-in) |
| `--content-only` | Print only result text (no progress lines) |
| `--limit <n>` | Limit items shown |

## Templates

Use `--template <name>` with the `run` command to wrap your prompt in a structured template.

<!-- TEMPLATES -->

Custom templates: place `.md` files with frontmatter in `~/.codex-collab/templates/`, then re-run the installer.

## TUI Handoff

To hand off a thread to the Codex TUI, look up the full thread ID with `codex-collab threads --json` and then run `codex resume <full-thread-id>` in the terminal.

## Tips

- **`run --resume` requires a prompt.** `review --resume` works without one (it uses the review workflow), but `run --resume <id>` will error if no prompt is given.
- **Omit `-d` if already in the project directory** — it defaults to cwd. Only pass `-d` when the target project differs from your current directory.
- **Multiple concurrent threads** are supported. Threads share a per-workspace broker for efficient resource usage.
- **Validate Codex's findings.** After reading Codex's review or analysis output, verify each finding against the actual source code before presenting to the user. Drop false positives, note which findings you verified.
- **Per-workspace scoping.** Threads and state are scoped per workspace (git repo root). Different repos have independent thread lists.
- **First invocation per workspace** may take slightly longer to initialize; subsequent calls in the same session reuse the connection context.

## Error Recovery

| Symptom | Fix |
|---------|-----|
| "codex CLI not found" | Install: `npm install -g @openai/codex` |
| Turn timed out | Increase `--timeout` (e.g., `--timeout 1800` for 30 min). Large reviews and complex tasks often need more than the 20-min default. |
| Thread not found | Use `codex-collab threads` to list active threads |
| Process crashed mid-task | Resume with `--resume <id>` — thread state is persisted |
| Approval request hanging | Run `codex-collab approve <id>` or `codex-collab decline <id>` |

## Prerequisites

Requires bun and codex CLI on PATH. Run `codex-collab health` to verify.
