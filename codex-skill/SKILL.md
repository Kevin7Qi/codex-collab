---
name: claude-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Claude (Claude Code) on any task. Also use PROACTIVELY when handing part of the work to Claude, or an independent non-Codex perspective, would add value — implementation, review, second opinions on code, plans, architecture, or design decisions.
---

# Claude Code peers

Claude Code sessions in this workspace are peers you can work with: hand one a task, split work with it, or ask it for a review or a second opinion. Each is a separate agent with its own context, working in the same directory as you — often the session the user is talking to in another terminal.

## Commands

    codex-collab peers                    # who is live here: name, idle or busy, kind
    codex-collab send <name> "message"    # hand that session a task and wait for its reply
    codex-collab send "message"           # the only live session, or one started for you
    codex-collab task wait <id>           # go on waiting for a task's reply
    codex-collab task result <id>         # print a task's reply, if it has come
    codex-collab task status <id>         # where a task stands

Every `send` is a task with an id, shown when the message is delivered, and `send` prints the reply in its output. `--timeout <sec>` bounds how long the command waits (default 600). The task itself goes on past it, and a reply that comes later is kept under the id. `--no-wait` returns the id as soon as the message is delivered, for work you will collect later. `codex-collab send <name> -` reads a long message from stdin.

## Choosing a model

A session `send` starts runs on the user's default Claude model and effort unless you choose: `--model <model>` and `--effort <level>` (or `-m`, `-r`). `codex-collab models --claude` lists the models, from most capable and expensive to fastest and cheapest, and the effort levels. The user pays for the choice, so fit it to the task: a lookup or a quick question sits well with a small model at low effort, and hard design or debugging work earns a capable one. The choice is made when the session starts, or is resumed, and holds until it next stops; `codex-collab peers` shows what a started session runs on, and `send` tells you when a choice could not apply. A live session the user opened runs on what they chose.

## Working with a session

- Neither of you sees the other's conversation, and both of you have the same working directory. Say what you want done and what you want back; it will find what it needs.
- You work in the same files. When you hand over edits, name the files that are Claude's to change and leave them alone until it replies, so the two of you never write the same file at once.
- A busy session receives your message during its current turn and replies when it gets to it.
- Replies can be wrong, like any collaborator's: verify what your task depends on before building on it.

## Mechanics

- `send` runs outside the sandbox, because it reaches the session over a local socket, which the sandbox blocks. Run it with escalated permissions; none are needed once the user has turned on `codex-collab config codex-rule on`. `peers` works inside the sandbox.
- `send` blocks until the reply arrives or its timeout passes, which routinely takes tens of seconds to minutes while the session works. Keep waiting on the running command: a second `send` delivers the same message twice.
- The outcome is one line, `task: <id>  status: <status>`, and the exit code says the same. 0: the session replied. 3: no reply yet, and the task goes on. Carry on with other work, then collect the reply with `codex-collab task wait <id>`, which waits, or `task result <id>`, which prints it if it is there. 5: a session `send` started stopped at a prompt nobody could answer; the output says how to send again. 1: the message could not be delivered, or the session went away before it replied.
- To wait, run one command and let it block: `send`, or `codex-collab task wait <id>` for a task already sent (`--timeout <sec>`, default 600). Both return the moment the reply is there, so checking in between gains nothing. `task status <id>` is a single look, for when you want to know what the session is doing right now: `busy` is a turn in progress, `idle` a session that has ended its turn, `waiting` one stopped at a prompt.
- A task's id outlives the command and your own context: `codex-collab tasks` lists the tasks sent from this workspace. `task` and `tasks` work inside the sandbox.
- A user's session running in `bypassPermissions` mode runs every action without asking, so Claude Code does not hand it another session's message unchecked: yours is held until the user approves it in that session's terminal, unless they have set `crossSessionInbound` to `accept`. From your side a held message is a task that stays `running` with no reply. Tell the user, who can approve it there.
- With no session live, `send` brings one up in the background for this workspace, named `claude(<workspace>-…)`; it stops after 30 idle minutes by default. If the one it started before was stopped within the past week, that session is resumed with its conversation intact, so what you worked out with it still stands and a long collaboration carries across its idle stops; `codex-collab peers` says when this is what `send` will do, and `--fresh` starts a new session instead. A new session starts from the working directory alone, with none of the user's conversation. It runs in Claude Code's `auto` permission mode and can edit files and run commands, each action reviewed by Claude Code's safety classifier, so work can be handed to it as to a live session.
