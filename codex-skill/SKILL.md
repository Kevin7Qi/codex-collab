---
name: claude-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Claude (Claude Code) on any task. Also use PROACTIVELY when handing part of the work to Claude, or an independent non-Codex perspective, would add value — implementation, review, second opinions on code, plans, architecture, or design decisions.
---

# Claude Code peers

Claude Code sessions in this workspace are peers you can collaborate with: delegate a task, divide implementation work, or review each other's output. Each is a separate agent with its own context, working in the same directory — often the session the user is talking to in another terminal.

## Commands

    codex-collab peers                    # who is live here: name, idle or busy, kind
    codex-collab send <name> "message"    # hand that session a task and wait for its reply
    codex-collab send "message"           # the only live session, or one started for you
    codex-collab task wait <id>           # go on waiting for a task's reply
    codex-collab task result <id>         # print a task's reply, if it has come
    codex-collab task status <id>         # where a task stands
    codex-collab tasks                    # all tasks sent from this workspace
    codex-collab peers stop [<name>]      # stop a session codex-collab started

Every `send` is a task with an id, printed when the message is delivered. `--timeout <sec>` (default 600) bounds how long the command waits; the task itself continues past it, and a later reply is kept under the id. `--no-wait` returns once the message is delivered; `task wait <id>` collects the reply afterwards. `codex-collab send <name> -` reads the message from stdin.

Simple questions usually return quickly; reviews, implementations and experiments can take minutes to tens of minutes while the session reads, edits and tests. `send` and `task wait` block until the reply lands. A second `send` of the same message delivers it twice.

## Choosing a model

`--model <model>` (`-m`) and `--effort <level>` (`-r`) set the model and effort when `send` starts or resumes a session. The choice holds until the session next stops. `codex-collab peers` shows what a started session runs on; `send` reports when a choice could not apply. A session the user opened keeps the model and effort they chose. The user's account pays for a session `send` starts, so choose the model and effort with the task's complexity and cost in mind.

`codex-collab models --claude` prints the available models. `--model` also accepts any full version string.

- **fable** — the most capable: hard design problems, deep debugging, long multi-step work.
- **opus** — balanced everyday model: routine coding, reviews, explanations.
- **sonnet** — fastest and cheapest: lookups, summaries, simple questions.

## Working with a session

- Neither agent sees the other's conversation. Both share the same working directory and can write the same files.
- A busy session receives a message during its current turn and replies when it gets to it.

## Mechanics

- `send` and `peers stop` reach Claude Code over a local socket, which requires running outside the sandbox; both refuse inside it. `peers`, `task` and `tasks` work inside it. `codex-collab config codex-rule on` removes the per-command approval for `send`.
- The outcome line is `task: <id>  status: <status>`. Exit codes: **0** replied. **3** no reply yet; the task continues. **5** a session codex-collab started stopped at a prompt nobody could answer; codex-collab stopped it; its conversation is kept. **1** undeliverable, session gone, or the turn ended on an error; the error is reported as the session recorded it, e.g. `429 rate_limit at <time>`, `500 server_error at <time> (3 since delivery)`.
- A task's own status is `pending`, `running`, `replied`, `blocked`, `lost`, `failed` or `expired`; it is what the `status:` line carries. `task status <id>` reads it once, along with the session's status while the task is open: `busy` (turn in progress), `shell` (turn ended with a command of its own still running), `idle` (nothing in hand), `waiting` (stopped at a prompt).
- If a turn ends with an error, the task is marked as failed when codex-collab started the session, since nothing there will set it going again. In a session the user is working in, the task stays open and the error is recorded on it. Nothing is sent to the session on the caller's behalf.
- With no session live, `send` starts one named `claude(<workspace>-…)`, which stops after 30 idle minutes (`config linger`) and in any case within four hours of starting. A session stopped within the past week is resumed with its conversation; `--fresh` starts a new one instead. A new session starts from the working directory with none of the user's conversation, in Claude Code's `auto` permission mode, and can edit files and run commands.
- `peers stop <name>` ends a session codex-collab started, through the same mechanism that started it; its conversation is kept. A session codex-collab did not start is refused. A signal or kill leaves Claude Code to restart the session under a pid codex-collab does not know.
- A user session in `bypassPermissions` mode holds messages from other sessions until the user approves them, unless `crossSessionInbound` is `accept`. From the caller's side it is a task that stays running.
