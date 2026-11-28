# Fake-model smoke tests

From the checkout root, with Bun, Git, Node.js, Claude Code, and Codex on PATH:

```sh
bun run test:fake-models
bun run test:fake-models peer --keep
bun run test:fake-models --install
```

`--install` downloads the pinned Claude Code 2.1.332 and Codex 0.172.0 packages into the fixture, not globally. Otherwise the harness uses the versions on PATH and prints them. The runner binds to a random port on loopback. Each invocation starts a private workspace and isolated HOME/CODEX_HOME, with dummy API keys and only `SendMessage` explicitly allowed in the disposable Claude profile. On Unix it uses `/tmp` so the broker socket path stays short even if your home or temp path is long. It shuts down its broker and Claude background service afterwards. Failed runs (or `--keep`) retain the directory shown at startup, including `commands.log`, `model.jsonl`, and CLI state; a successful run normally removes it.

| Scenario | What it checks |
| --- | --- |
| `run` | Foreground CLI run returns the scripted response through the real app-server. |
| `detach` | Detached run can be followed through completion, including its output. |
| `broker` | Two broker clients can run different threads concurrently; competing for the same thread returns `-32001`. |
| `send` | `send` auto-spawns a Claude session, replies over the per-thread channel, and replays the reply from `messages`. |
| `peer` | Claude's `ListAgents` finds the workspace broker, its `SendMessage` starts a Codex turn, and `collab.consult` reaches Claude and returns an answer before the final reply. |
| `peer-default` | The same round trip without naming a Codex model; Codex 0.172.0 selects `gpt-6.2-sol` and routes consult through code mode. |
| `failures` | A mid-stream model error fails the run; delaying a response triggers the CLI's timeout. |
| `held` | A separate app-server holding a thread prevents resume with exit code 8. |
| `contract` | Runs the live `item/tool/call` contract against the fixture, asserting the real callback and returned answer. |

These are opt-in and do not run under `bun test` or `bun run test:ci`. The Claude messaging scenarios are skipped on Windows. The peer scenarios may normalize Linux process start times **only** in their isolated synthetic entries for checkouts that still write `ps` timestamps. The `peer` scenario pins `gpt-5.4` to cover direct function tools; with Responses Lite, Codex instead advertises `functions.exec` in an `additional_tools` input item and exposes `collab__consult` to that tool. The `SendMessage` rule leaves automatic spawning in `auto`; it covers this one scripted action, not the classifier.

The tests verify collaboration plumbing and error propagation, not real sign-in, model judgment, account-specific feature gates, Remote Control, or provider compatibility. This harness does not replace the opt-in live contracts or a real-account smoke test.
