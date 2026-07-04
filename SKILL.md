---
name: codex-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Codex on any task. Also use PROACTIVELY when an independent, non-Claude perspective from Codex would add value — second opinions on code, plans, architecture, or design decisions.
---

# codex-collab

codex-collab is a bridge between Claude and Codex. It communicates with Codex via the `codex app-server` JSON-RPC protocol, giving you structured, event-driven access to Codex's capabilities — prompting, code review, tool use, and file editing. Requires bun and the codex CLI on PATH (`codex-collab health` to verify).

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

# Long or quote-riddled prompt: pass it on stdin with `run -` (no shell-quoting hazards)
cat prompt.md | codex-collab run - --content-only
```

**IMPORTANT — Execution rules for ALL `codex-collab` Bash commands:**
- Always use `dangerouslyDisableSandbox=true` — the tool writes to `~/.codex-collab/` which is outside the sandbox allowlist.
- For `run` and `review`: also use `run_in_background=true` — these take minutes. After launching, tell the user it's running and end your turn. **While running**: do NOT poll, block, wait, or spawn an agent to monitor — you will be notified automatically when the task finishes. If other tasks complete while Codex is running, handle them normally without checking on Codex. **When notified**: surface the result per Context Efficiency & Result Visibility below.
- `run --detach` returns in seconds — run it in the **foreground**.
- `follow` on a live run blocks until that run completes, and `follow --watch` never exits: both are primarily the **user's** view for their own terminal pane — don't run `--watch` yourself. The one agent-facing use: `follow <id>` in background Bash is the completion signal for a detached run (see Detached Runs below). `follow` on an already-finished run is a quick foreground replay.
- All other commands (`kill`, `threads`, `progress`, `output`, `peek`, `approve`, `decline`, `clean`, `delete`, `config`, `models`, `templates`, `health`, `version`): run in the **foreground** — they complete in seconds.

If the user asks about progress mid-task, use `TaskOutput(block=false)` to read the background output stream, or `codex-collab progress <id>` for just the log tail. `<id>` is the codex-collab thread short ID (8-char hex), not the Claude Code task ID — it appears in the first progress line (`[codex] Thread a1b2c3d4 started`); `codex-collab threads` lists them. Progress lines stream in real time:

```
[codex] Thread a1b2c3d4 started (gpt-5.4, workspace-write)
[codex] Running: npm test
[codex] Edited: src/auth.ts (update)
[codex] Turn completed (2m 14s, 1 file changed)
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

## Context Efficiency & Result Visibility

- **Use `--content-only`** when reading output — result text only, no progress lines.
- **`run` and `review` print results on completion**; a background task's result lands in its output file.
- **Read results with Bash, not the Read tool**: `cat` the background output file, or `codex-collab output <id> --last` for a finished thread (`--last`: latest turn only). Bash output appears in the transcript where the user sees it; Read-tool content stays in your context and never reaches them.
- **Then add only synthesis** — the result is already on screen, so repeat nothing: say what you verified, where you disagree, what you'd add.

## Resuming Threads

When consecutive tasks relate to the same project, resume the existing thread. Codex retains the conversation history, so follow-ups like "now fix what you found" or "check the tests too" work better when Codex already has context from the previous exchange. Start a fresh thread when the task is unrelated or targets a different project.

**If the user asks to continue or follow up on a prior task but you don't have the thread ID in context**, follow this discovery flow:

1. `codex-collab threads --discover` — see top 5 recent threads (server + local). If the thread was started earlier in this session, `codex-collab threads --session` narrows the list to exactly those.
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

## Detached Runs and Following

**When to detach:** default to background `run` — it survives your turn ending and gives you a completion notification for free. Reach for `--detach` in exactly two situations: (1) the turn must outlive this Claude session — background tasks are killed when the session exits or restarts, which interrupts an in-flight turn, while a detached run keeps going and its result is retrievable later with `output <id> --last`; (2) the user is driving from their own terminal and wants the turn independent of that shell. Don't detach routine tasks: you lose the automatic completion notification (see below for how to get it back).

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

When Guardian denies an action the run keeps going (the agent works around it), and the denial is saved locally with a progress hint (`Override available: codex-collab approve --guardian <review-id>`). If the user decides the action was actually fine:

```bash
codex-collab approve --guardian               # list pending denials
codex-collab approve --guardian <review-id>   # override one (prefix ok)
```

The override records a user approval for that exact action inside the thread — nothing executes immediately; the agent retries it on the thread's next run (`codex-collab run --resume <short-id> "continue"`). It authorizes only that specific action, not similar ones.

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

Usage examples for `run`, `review`, `--detach`, and `follow` live in their sections above; this is the remaining command surface:

```bash
codex-collab output <id> [--last]       # Full log for thread (--last: only the latest turn's output)
codex-collab progress <id>              # Recent activity (tail of log)
codex-collab threads [--all|--discover] # List threads (--discover: include server-side, top 5)
codex-collab threads --session          # Only threads the current session has run
codex-collab peek <id> [--limit N --full] # Recent conversation slice from server
codex-collab kill <id>                  # Stop a running thread
codex-collab delete <id>                # Archive thread (recoverable via `codex unarchive`), delete local files
codex-collab delete <id> --purge        # Permanently delete server-side instead — NOT recoverable; needs explicit user intent
codex-collab clean                      # Delete old logs and stale mappings
codex-collab approve <id> | decline <id> # Answer a pending approval
codex-collab config [key] [value] [--unset] # Show/set/unset persistent defaults (model, reasoning, sandbox, approval, timeout, memory)
codex-collab models | templates | health | version
```

Note: `jobs` still works as a deprecated alias for `threads`.

### Options

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Model name (default: auto — latest available) |
| `-r, --reasoning <level>` | Reasoning effort: none, minimal, low, medium, high, xhigh (default: auto — highest for model) |
| `-s, --sandbox <mode>` | Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `-d, --dir <path>` | Working directory (default: cwd) |
| `--resume <id>` | Resume existing thread (run and review) |
| `--timeout <sec>` | Turn timeout in seconds (default: 1200). Do not lower this — Codex tasks routinely take 5-15 minutes. Increase for large reviews or complex tasks. |
| `--approval <policy>` | never, on-request, on-failure, untrusted, auto (default: never) — see Approvals |
| `--memory` | Let Codex's memory feature learn from threads this run creates (default: created threads are excluded so agent-driven sessions don't shape Codex's picture of the user) |
| `--detach` | (run) Return once the turn is running — see Detached Runs |
| `-w, --watch` | (follow) Keep following each new run instead of exiting — see Detached Runs |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for --mode commit |
| `--base <branch>` | Base branch for PR review (default: auto-detected default branch) |
| `--all` | List all threads with no display limit (threads command) |
| `--discover` | Query Codex server for threads not in local index (threads command) |
| `--json` | JSON output (threads, peek commands) |
| `--full` | Include all item types in peek output (default shows messages only) |
| `--template <name>` | Prompt template for run command (checks `~/.codex-collab/templates/` first, then built-in) |
| `--content-only` | Print only result text (no progress lines) |
| `--last` | (output) Only the latest turn's output, not the whole thread history (implies `--content-only`) |
| `--session` | (threads) Only threads the current session has run |
| `--limit <n>` | Limit items shown |
| `--` | End of options; remaining arguments are treated as prompt text |
| `-` | (run) Read the prompt from stdin — for long or quote-riddled prompts |

### Exit codes (run, review)

`0` completed · `1` failed · `3` timed out · `4` interrupted (kill) · `5` died blocked on an approval — the request is void, so don't try to answer it; resume with a longer `--timeout` or `--approval auto` · `6` broker busy and fallback unavailable — transient, retry. For backgrounded runs, branch on the exit code instead of text-sniffing the output.

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
