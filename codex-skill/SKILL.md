---
name: claude-collab
description: Use when the user asks to invoke, delegate to, or collaborate with Claude (Claude Code) on any task. Also use PROACTIVELY when an independent, non-Codex perspective from Claude would add value — second opinions on code, plans, architecture, or design decisions.
---

# Claude Code peers

Claude Code sessions in this workspace are peers you can message. Each is a separate agent with its own context — often the one the user is talking to in another terminal.

## Commands

    codex-collab peers                    # who is live here: name, idle or busy, kind
    codex-collab send <name> "message"    # deliver to that session and wait for its reply
    codex-collab send "message"           # the only live session, or one started for you

`send` prints the reply in its output. `--timeout <sec>` bounds the wait (default 600). `--no-wait` delivers a note and returns; a reply cannot reach you afterwards. `codex-collab send <name> -` reads a long message from stdin.

## Mechanics and costs

- `send` runs outside the sandbox — it reaches the session over a local socket, which the sandbox blocks. Run it with escalated permissions. `peers` works inside the sandbox.
- `send` blocks until the reply arrives or the timeout passes — this routinely takes tens of seconds to minutes while the session works on your question. Wait on the running command; do not kill it or re-run it.
- The session sees your message with your thread id and whether you are waiting. Its reply is its judgment, possibly informed by context you lack — weigh it against what you know.
- No reply within the timeout means nobody answered, not that asking was wrong. The command exits 0 either way; proceed on your own judgment and note the open question. (A session running with `bypassPermissions` holds peer messages for its user to approve unless its `crossSessionInbound` setting is `accept`.)
- With no session live, `send` starts a background Claude Code session for this workspace, named `claude(<workspace>-…)`. It has the repository but none of the user's conversation, and it stops after 30 idle minutes by default.
- A reply costs the collaborator attention and you the wait. Whether to consult, when, and what to do with the answer is yours to decide.
