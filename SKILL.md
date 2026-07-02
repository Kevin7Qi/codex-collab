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
- `run --detach` returns in seconds — run it in the **foreground**.
- `follow` on a live run blocks until that run completes, and `follow --watch` never exits: both are primarily the **user's** view for their own terminal pane — don't run `--watch` yourself. The one agent-facing use: `follow <id>` in background Bash is the completion signal for a detached run (see Detached Runs below). `follow` on an already-finished run is a quick foreground replay.
- All other commands (`kill`, `threads`, `progress`, `output`, `peek`, `approve`, `decline`, `clean`, `delete`, `config`, `models`, `templates`, `health`, `version`): run in the **foreground** — they complete in seconds.

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

## Detached Runs and Following

**When to detach:** default to background `run` — it survives your turn ending and gives you a completion notification for free. Reach for `--detach` in exactly two situations: (1) the turn must outlive this Claude session — background tasks are killed when the session exits or restarts, which interrupts an in-flight turn, while a detached run keeps going and its result is retrievable later with `output <id>`; (2) the user is driving from their own terminal and wants the turn independent of that shell. Don't detach routine tasks: you lose the automatic completion notification (see below for how to get it back).

`run --detach` hands the turn to a detached runner and returns as soon as the turn is actually running — the turn's lifetime is decoupled from the invoking shell, so nothing kills it if the shell or session goes away:

```bash
codex-collab run "large refactor task" --detach --approval auto
# [codex] Detached: thread a1b2c3d4 running (gpt-5.4)
# [codex]   Follow:   codex-collab follow a1b2c3d4
```

`follow [id]` is a live view of a running thread: it replays the current run so far, then streams events (commands with exit codes, file edits, Guardian decisions, approval prompts) until the run finishes, and exits with the final status (exit 0 = completed). Without an ID it attaches to the workspace's active run (or replays the most recent one), so the user can just type `codex-collab follow`. On an already-finished run it replays that run and exits, so it's also a quick way to review what happened.

**For a multi-turn Claude ⇄ Codex conversation, suggest the user keep `codex-collab follow --watch` open in a separate terminal pane** — it doesn't exit between turns: each new run is picked up automatically (every run shown exactly once, in start order, even across concurrent threads; runs that finished while another was displayed appear as quick replays). It renders a purpose-built, color-coded view, costs zero model context, and stops with Ctrl-C. Scope it to one thread with `follow <id> --watch` when multiple threads run in parallel and the user wants a dedicated pane per thread.

**Completion signal for detached runs (agent-facing):** the detach parent exits when the turn *starts*, not when it finishes — so backgrounding `run --detach` gives you no completion notification. When you need one, run `codex-collab follow <id>` in background Bash: it exits exactly when the run reaches a terminal state (exit 0 = completed), and that exit is your notification.

### Watching for approvals without polling (Monitor pattern)

**Only arm this when the approval mode can actually block**: `on-request`, `on-failure`, or `untrusted`. Under the default `never` there are no approval requests, and under `auto` Guardian decides everything autonomously (approve or deny — it never blocks on a human), so a watcher there is waste.

When you run codex-collab in background Bash, you're notified when the *process exits* — but an approval request blocks mid-run without exiting. Watch on-disk state instead; both signals below appear regardless of which process owns the run:

- an approval request file appears at `~/.codex-collab/workspaces/*/approvals/<id>.json` while a request is pending (and disappears when answered); its JSON carries the command, reason, and `workspaceDir`
- the run record (`workspaces/*/runs/<runId>.json`) carries `"pendingApproval": {id, kind, summary, requestedAt}` while blocked, `null` otherwise

Arm a single-shot watcher alongside the background run and keep working — approval appears → notification → `codex-collab approve <id>` → the run continues (no kill/resume cycle, no polling in your context). With the Monitor tool, this is the command; without it, run the same loop as a second background Bash command and its *exit* becomes your notification:

```bash
until [ -n "$(ls ~/.codex-collab/workspaces/*/approvals/*.json 2>/dev/null)" ]; do sleep 2; done; cat ~/.codex-collab/workspaces/*/approvals/*.json
```

## Approvals

By default, Codex auto-approves all actions (`--approval never`). For stricter control:

```bash
# Require approval for Codex-initiated actions
codex-collab run "refactor the auth module" --approval on-request --content-only

# Guardian decides each request autonomously — approve or deny, never blocking on a human
codex-collab run "refactor the auth module" --approval auto --content-only
```

With `--approval auto`, Guardian approves or **denies** each request on its own — it does not escalate to the interactive flow, so auto runs never block. Its decisions appear in the progress stream (`Guardian approved (low risk): …`) with full payloads in the thread log; judgment calls and denials additionally surface as `Guardian warning: …` lines carrying the risk level, the user-authorization assessment, and the rationale. Note Guardian weighs whether the *user* asked for the action — explicitly user-requested commands get high authorization and are usually approved; it exists to catch the model acting beyond its mandate.

Under the interactive policies (`on-request`, `on-failure`, `untrusted`), an approval request shows:
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

### Run (detached)

```bash
codex-collab run "prompt" --detach [options]  # Return once the turn is running
codex-collab follow                           # Live view of the active run; exits on completion
codex-collab follow <id>                      # Same, for a specific thread
codex-collab follow --watch                   # Keep the pane open across runs (Ctrl-C to stop)
```

### Reading Output

```bash
codex-collab output <id>                # Full log for thread
codex-collab progress <id>              # Recent activity (tail of log)
codex-collab follow <id>                # Live view of a running thread (or replay of the last run)
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
| `-r, --reasoning <level>` | Reasoning effort: none, minimal, low, medium, high, xhigh (default: auto — highest for model) |
| `-s, --sandbox <mode>` | Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `-d, --dir <path>` | Working directory (default: cwd) |
| `--resume <id>` | Resume existing thread (run and review) |
| `--timeout <sec>` | Turn timeout in seconds (default: 1200). Do not lower this — Codex tasks routinely take 5-15 minutes. Increase for large reviews or complex tasks. |
| `--approval <policy>` | Approval policy: never, on-request, on-failure, untrusted, auto (default: never). `auto`: Codex's Guardian reviewer approves or denies each request autonomously — never blocks on a human; decisions and denial rationales stream as Guardian lines |
| `--memory` | Let Codex's memory feature learn from threads this run creates (default: created threads are excluded so agent-driven sessions don't shape Codex's picture of the user) |
| `--detach` | (run) Return once the turn is running; watch with `follow <id>`, stop with `kill <id>`. Decouples turn lifetime from the invoking shell |
| `-w, --watch` | (follow) Don't exit when the run finishes — keep following each new run, every run shown once in start order (Ctrl-C to stop). For the user's pane, not for agents |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for --mode commit |
| `--base <branch>` | Base branch for PR review (default: auto-detected default branch) |
| `--all` | List all threads with no display limit (threads command) |
| `--discover` | Query Codex server for threads not in local index (threads command) |
| `--json` | JSON output (threads, peek commands) |
| `--full` | Include all item types in peek output (default shows messages only) |
| `--template <name>` | Prompt template for run command (checks `~/.codex-collab/templates/` first, then built-in) |
| `--content-only` | Print only result text (no progress lines) |
| `--limit <n>` | Limit items shown |
| `--` | End of options; remaining arguments are treated as prompt text |

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
