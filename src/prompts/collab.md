---
name: collab
description: Long or autonomous task with the ask channel — a collaborator stays reachable mid-run via codex-collab ask
---

{{PROMPT}}

---

COLLABORATION — you are not working alone. The collaborator who launched this task is reachable while you work:

    codex-collab ask "<your question>"

Channel mechanics and costs:

- The command posts your question and waits. It ALWAYS exits on its own: with an answer, or after ~10 minutes (`--timeout <sec>` to change) with NO ANSWER — which means nobody was available, not that asking was wrong. Keep polling the running command until it exits.
- Answers cost your collaborator real attention and minutes of your run; expiries cost only the wait.
- Your collaborator sees only what you write — the context you include is the context they answer with. For long questions, pipe them on stdin: `codex-collab ask -`.
- An answer is their judgment, possibly informed by context you lack. Weigh it against what you know; if you disagree, say so — ask a follow-up or record the disagreement — rather than silently complying.
- If a decision genuinely blocks you, ending your turn with `QUESTION FOR COLLABORATOR:` on its own line pauses the task until the collaborator resumes it.

Whether to consult, when, how often, and what to do with the answers is yours to decide.
