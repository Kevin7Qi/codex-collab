---
name: claude-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Claude (Claude Code) on any task. Also use PROACTIVELY when handing part of the work to Claude, or an independent non-Codex perspective, would add value — implementation, review, second opinions on code, plans, architecture, or design decisions.
---

# Claude Code peers

Claude Code sessions in this workspace are peers you can work with: hand one a task, split work with it, or ask it for a review or a second opinion. Each is a separate agent with its own context, working in the same checkout as you — often the session the user is talking to in another terminal.

## Commands

    codex-collab peers                    # who is live here: name, idle or busy, kind
    codex-collab send <name> "message"    # deliver to that session and wait for its reply
    codex-collab send "message"           # the only live session, or one started for you

`send` prints the reply in its output. `--timeout <sec>` bounds the wait (default 600); raise it for a task that takes longer. `--no-wait` hands the message off and returns at once, for work whose result you will pick up from the files or do not need back; no reply can reach you afterwards. `codex-collab send <name> -` reads a long message from stdin.

## Choosing a model

A session `send` starts runs on the user's default Claude model and effort unless you choose: `--model <model>` and `--effort <level>` (or `-m`, `-r`). `codex-collab models --claude` lists the models, from most capable and expensive to fastest and cheapest, and the effort levels. The user pays for the choice, so fit it to the task: a lookup or a quick question sits well with a small model at low effort, and hard design or debugging work earns a capable one. The choice is made when the session starts and holds for its life; `codex-collab peers` shows what a started session runs on, and `send` tells you when a choice could not apply. A live session the user opened runs on what they chose.

## Working with a session

- Neither of you sees the other's conversation. Write a message that stands alone: the goal, the files involved, what you have already done or ruled out, and what you want back (a change made, a review, an answer).
- You share one working tree. When you hand over edits, name the files that are Claude's to change and leave them alone until it replies, so the two of you never write the same file at once.
- A busy session receives your message during its current turn and replies when it gets to it.
- Replies can be wrong, like any collaborator's: verify what your task depends on before building on it.

## Mechanics

- `send` runs outside the sandbox, because it reaches the session over a local socket, which the sandbox blocks. Run it with escalated permissions; none are needed once the user has turned on `codex-collab config codex-rule on`. `peers` works inside the sandbox.
- `send` blocks until the reply arrives or the timeout passes, which routinely takes tens of seconds to minutes while the session works. Keep waiting on the running command: a second `send` delivers the same message twice.
- When the timeout passes with no reply, the command says so and exits 0. The session may still be working on your message; carry on, and mention the open item in your answer. (A session running with `bypassPermissions` holds peer messages for its user to approve unless its `crossSessionInbound` setting is `accept`.)
- With no session live, `send` starts a background Claude Code session for this workspace, named `claude(<workspace>-…)`, which stops after 30 idle minutes by default. It starts from the repository alone, with none of the user's conversation, so give it the background a live session would already have. It runs in Claude Code's `auto` permission mode and can edit files and run commands, each action reviewed by Claude Code's safety classifier, so work can be handed to it as to a live session.
