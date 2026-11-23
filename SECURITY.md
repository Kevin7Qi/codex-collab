# Security Policy

## Supported versions

Only the latest release gets security fixes. Run `codex-collab update` to get it.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability** ([direct link](https://github.com/Kevin7Qi/codex-collab/security/advisories/new)).

Please include the codex-collab version (`codex-collab health`), your OS, and steps to reproduce. Do not open a public issue for a vulnerability.

## Security model

codex-collab is a local CLI. It runs as your OS user, drives Codex through the `codex app-server` protocol, and relays messages between Codex and Claude Code sessions on the same machine. It runs no network service. Its only network traffic is the release check and the `update` download from GitHub.

**What it is designed for**

- **A single-user machine.** The broker socket (0o700), state under `~/.codex-collab/` (0o700 directories, 0o600 files) and peer sockets assume no other OS user on the machine is hostile. Shared multi-user hosts are out of scope.
- **Repositories you trust.** Codex and Claude act on what they read. codex-collab does not try to defend against prompt injection or malicious repository content steering them through peer messaging, `collab.consult`, `ask`/`answer` or hooks.
- **Trusting GitHub for updates.** `update` downloads the release tag's source tarball from GitHub over HTTPS and runs its installer after you confirm. It does not verify signatures.

**What it should protect**

- **Your chosen sandbox and approval policy.** codex-collab should never run Codex with a more permissive sandbox or approval policy than you asked for. `review` always runs read-only.
- **Your files outside the workspace.** Install, uninstall, hooks and trust carry-over (`~/.codex/hooks.json`, `~/.codex/config.toml`, `~/.claude.json`, `~/.claude/skills/`) should change only what codex-collab owns.
- **Transcripts, run logs and approval records.** Those under `~/.codex-collab/` may contain workspace code or secrets and should stay private to your user.

A bug that breaks one of these is a vulnerability. Choosing a permissive setting yourself (for example `--sandbox danger-full-access` or approval `never`) is not.
