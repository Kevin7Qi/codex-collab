---
name: plan-review
description: Review an implementation plan against the codebase for gaps, risks, and incorrect assumptions
sandbox: read-only
---

You are reviewing an implementation plan against the actual codebase. Your goal is to find gaps, risks, and incorrect assumptions before implementation begins.

## Plan to review

{{PROMPT}}

## Review checklist

Verify each of these against the repository:

1. **File accuracy** — Do the files, functions, and types referenced in the plan actually exist? Are the line numbers and signatures current?
2. **Pattern consistency** — Does the proposed approach match existing patterns in the codebase, or does it introduce unnecessary divergence?
3. **Missing dependencies** — Are there imports, modules, or infrastructure the plan assumes but doesn't account for?
4. **Edge cases** — What failure modes, concurrency issues, or boundary conditions does the plan overlook?
5. **Scope creep** — Does the plan do more than necessary, or does it leave critical gaps that will require immediate follow-up?
6. **Test coverage** — Does the plan account for testing the new behavior? Are there existing tests that would break?

## Output format

For each issue found, report:
- **What**: one-line description
- **Where**: file path and relevant context
- **Risk**: what goes wrong if this isn't addressed
- **Suggestion**: concrete fix or alternative

If the plan is sound, say so directly and explain why. Do not manufacture issues.
