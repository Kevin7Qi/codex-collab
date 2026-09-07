// src/commands/config.ts — config, models, health command handlers

import { config, listTemplates, resolveStateDir } from "../config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { peerCapability, sessionsDir, COLLAB_MODES, readConfiguredMode, resolveCollabMode } from "../peer";
import { SERVER_PREFERENCES, attachSupported, controlSocketPath, serverPreference } from "../shared-server";
import { readPeerState, isAlive, type PeerState } from "./peer";
import type { Model, AccountRead } from "../types";
import {
  die,
  parseOptions,
  withClient,
  fetchAllPages,
  loadUserConfig,
  saveUserConfig,
  MAX_TIMEOUT_SECONDS,
} from "./shared";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export async function handleConfig(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);

  const VALID_KEYS: Record<string, { validate: (v: string) => boolean; hint: string }> = {
    model:     { validate: v => v.length > 0 && !/[^a-zA-Z0-9._\-\/:]/.test(v), hint: "model name (e.g. gpt-5.6-sol, gpt-5.5)" },
    reasoning: { validate: v => (config.reasoningEfforts as readonly string[]).includes(v), hint: config.reasoningEfforts.join(", ") },
    sandbox:   { validate: v => (config.sandboxModes as readonly string[]).includes(v), hint: config.sandboxModes.join(", ") },
    approval:  { validate: v => (config.approvalModes as readonly string[]).includes(v), hint: config.approvalModes.join(", ") },
    timeout:   { validate: v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= MAX_TIMEOUT_SECONDS; }, hint: `seconds, 1-${MAX_TIMEOUT_SECONDS} (e.g. 3600)` },
    memory:    { validate: v => v === "true" || v === "false", hint: "true, false (let Codex memory learn from created threads)" },
    mode:      { validate: v => (COLLAB_MODES as readonly string[]).includes(v), hint: `${COLLAB_MODES.join(", ")} (auto: peer messaging where supported, CLI otherwise)` },
    server:    { validate: v => (SERVER_PREFERENCES as readonly string[]).includes(v), hint: `${SERVER_PREFERENCES.join(", ")} (auto: attach to Codex's own app-server when its socket answers, else run a private one)` },
  };

  const cfg = loadUserConfig();

  // No args -> show current config, or --unset to clear all
  if (positional.length === 0) {
    if (options.explicit.has("unset")) {
      saveUserConfig({});
      console.log("All config values cleared. Using auto-detected defaults.");
      return;
    }
    if (Object.keys(cfg).length === 0) {
      console.log("No user config set. Using auto-detected defaults.");
      console.log(`\nConfig file: ${config.configFile}`);
      console.log(`\nAvailable keys: ${Object.keys(VALID_KEYS).join(", ")}`);
      console.log("Set a value:   codex-collab config <key> <value>");
      console.log("Unset a value: codex-collab config <key> --unset");
    } else {
      for (const [k, v] of Object.entries(cfg)) {
        console.log(`  ${k}: ${v}`);
      }
      console.log(`\nConfig file: ${config.configFile}`);
    }
    return;
  }

  const key = positional[0];
  if (!Object.hasOwn(VALID_KEYS, key)) {
    die(`Unknown config key: ${key}\nValid keys: ${Object.keys(VALID_KEYS).join(", ")}`);
  }

  // Unset
  if (options.explicit.has("unset")) {
    delete (cfg as Record<string, unknown>)[key];
    saveUserConfig(cfg);
    console.log(`Unset ${key} (will use auto-detected default)`);
    return;
  }

  // Key only -> show value
  if (positional.length === 1) {
    const val = (cfg as Record<string, unknown>)[key];
    if (val !== undefined) {
      console.log(`${key}: ${val}`);
    } else {
      console.log(`${key}: (not set — auto-detected)`);
    }
    return;
  }

  const value = positional[1];

  // Validate and set
  const spec = VALID_KEYS[key];
  if (!spec.validate(value)) {
    die(`Invalid value for ${key}: ${value}\nValid: ${spec.hint}`);
  }

  (cfg as Record<string, unknown>)[key] =
    key === "timeout" ? Number(value) : key === "memory" ? value === "true" : value;
  saveUserConfig(cfg);
  console.log(`Set ${key}: ${value}`);
  if (key === "mode") {
    // The mode is read when a broker starts. One already running keeps its
    // peer (or its lack of one) until it restarts, so the setting alone
    // changes nothing visible for that workspace.
    console.log("Brokers already running keep their current peer state until they restart — `codex-collab peer up` applies the mode to this workspace's broker.");
  }
  if (key === "server") {
    // Same lifecycle: a broker chooses its app-server once, when it starts.
    console.log("Brokers already running keep the app-server they started on — `codex-collab peer up` restarts this workspace's broker so the setting applies.");
  }
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

export async function handleModels(args: string[]): Promise<void> {
  // Parse for -d/--dir support and so unknown flags error like every other
  // command instead of being silently ignored.
  const { options } = parseOptions(args);
  const allModels = await withClient((client) =>
    fetchAllPages<Model>(client, "model/list", { includeHidden: true }),
  options.dir);

  for (const m of allModels) {
    const efforts =
      m.supportedReasoningEfforts?.map((o) => o.reasoningEffort).join(", ") ?? "";
    console.log(
      `  ${m.id.padEnd(25)} ${(m.description ?? "").slice(0, 50).padEnd(52)} ${efforts}`,
    );
  }
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

/** Classify `account/read` into a health verdict.
 *
 *  Fails OPEN on anything inconclusive. A false "not authenticated" is the
 *  worse error here: it tells a working user their setup is broken. Only the
 *  case where Codex reports no account AND says it needs OpenAI credentials
 *  is treated as a real failure. */
export function describeAuth(read: AccountRead | "unknown"): { ready: boolean; detail: string } {
  if (read === "unknown") {
    return { ready: true, detail: "not reported (this codex build may predate account/read)" };
  }
  const account = read.account ?? null;
  if (account?.type === "chatgpt") {
    const who = [account.planType, account.email].filter(Boolean).join(" — ");
    return { ready: true, detail: who ? `ChatGPT login active (${who})` : "ChatGPT login active" };
  }
  if (account?.type === "apiKey") {
    // Presence is not validity — the key is only proven by a real request.
    return { ready: true, detail: "API key configured (not verified here)" };
  }
  if (read.requiresOpenaiAuth === false) {
    return { ready: true, detail: "provider configured; OpenAI authentication not required" };
  }
  if (account?.type) {
    return { ready: true, detail: `${account.type} (unrecognized account type — assuming usable)` };
  }
  // No account. Only an explicit "OpenAI auth IS required" makes that a real
  // failure: `requiresOpenaiAuth` is optional and nullable, so an absent or
  // null flag is inconclusive and must not be reported as logged out.
  if (read.requiresOpenaiAuth === true) {
    return { ready: false, detail: "NOT AUTHENTICATED" };
  }
  return { ready: true, detail: "not reported (no account and no auth requirement given)" };
}

/** One-line native-peer verdict for `health`.
 *
 *  Never fatal: peer messaging is an enhancement, and every CLI path works
 *  without it. The point is to make the fallback VISIBLE — on Windows, on an
 *  older Claude Code, or with the peer switched off, the user should be able
 *  to see that codex-collab is running in its degraded-but-complete mode
 *  rather than wonder why `ListAgents` shows nothing. */
export function describePeer(dir: string): string {
  // Name the mode that is in force, and where it came from. Whether the peer
  // runs is now a setting as well as a capability, and "unavailable" without
  // a reason reads like a broken install when it may be a deliberate choice.
  const { mode, reason } = resolveCollabMode(readConfiguredMode());
  if (mode === "cli") {
    // A broker that registered its peer before the mode changed keeps it
    // until it restarts; "off" alone would contradict what ListAgents shows.
    let lingering: PeerState | null = null;
    try { lingering = readPeerState(resolveStateDir(dir)); } catch { /* unreadable — report the mode alone */ }
    return lingering && isAlive(lingering.pid)
      ? `off — collaboration mode is cli (${reason}), but the broker running as pid ${lingering.pid} still serves "${lingering.name}" from before the change ('codex-collab peer up' retires it)`
      : `off — collaboration mode is cli (${reason}); the CLI paths are unaffected`;
  }
  const capability = peerCapability();
  if (!capability.ok) return `unavailable — ${capability.reason} (CLI paths unaffected)`;
  let state: PeerState | null = null;
  try {
    state = readPeerState(resolveStateDir(dir));
  } catch {
    return "available (state unreadable)";
  }
  if (!state) return "available, not running (start it with 'codex-collab peer up')";
  if (!isAlive(state.pid)) return "available, not running (stale state — 'codex-collab peer up')";
  const registered = existsSync(join(sessionsDir(), `${state.pid}.json`));
  return registered
    ? `registered as "${state.name}" (broker pid ${state.pid})`
    : `broker running (pid ${state.pid}) but its registry entry is missing — 'codex-collab peer up'`;
}

/** One line naming the app-server a connection reached, and — when it is a
 *  private child — whether Codex's shared server was available instead.
 *  The point is to make the topology visible: whether the Codex app or the
 *  TUI will see codex-collab's turns live depends on nothing else. */
export function describeServer(
  server: { kind: string; socketPath?: string; pid?: number },
  env: NodeJS.ProcessEnv = process.env,
  socketExists: (path: string) => boolean = existsSync,
  platform: string = process.platform,
  /** Whether the connection described runs through the workspace broker
   *  (which keeps the server it started on) or is this invocation's own. */
  brokered = true,
): string {
  const { preference, reason } = serverPreference(env);
  if (server.kind === "shared") {
    return `shared — Codex's own app-server at ${server.socketPath ?? controlSocketPath(env)} (${reason}); its other clients see codex-collab's turns live`;
  }
  const pid = server.pid !== undefined ? ` (pid ${server.pid})` : "";
  if (!attachSupported(platform)) return `private app-server${pid} — attaching to Codex's shared server is not available on Windows`;
  if (preference === "private") return `private app-server${pid} (${reason})`;
  const socket = controlSocketPath(env);
  if (!socketExists(socket)) {
    return `private app-server${pid} — no Codex app-server is listening at ${socket} ('codex app-server daemon start' shares one; the TUI attaches to it too)`;
  }
  return brokered
    ? `private app-server${pid} — Codex's socket at ${socket} exists but the broker keeps the server it started on (\`codex-collab peer up\` to restart on the shared one)`
    : `private app-server${pid} — Codex's socket at ${socket} exists but this invocation did not attach (under \`auto\`, tried the socket and fell back)`;
}

export async function handleHealth(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const findCmd = process.platform === "win32" ? "where" : "which";
  const which = Bun.spawnSync([findCmd, "codex"]);
  if (which.exitCode !== 0) {
    die("codex CLI not found. Install: npm install -g @openai/codex");
  }

  console.log(`  codex-collab: ${config.clientVersion}`);
  console.log(`  bun:   ${Bun.version}`);
  // `where` on Windows returns multiple matches; show only the first
  console.log(`  codex: ${which.stdout.toString().trim().split("\n")[0].trim()}`);

  let account: AccountRead | "unknown" = "unknown";
  try {
    account = await withClient(async (client) => {
      console.log(`  app-server: OK (${client.userAgent})`);
      console.log(`  server: ${describeServer(client.server, process.env, existsSync, process.platform, client.isBrokered)}`);
      // A failure here must not fail the whole check: older codex builds may
      // not know account/read, and a busy broker or transient RPC error is
      // not evidence that the user is logged out.
      try {
        return await client.request<AccountRead>("account/read", { refreshToken: false });
      } catch {
        return "unknown" as const;
      }
    }, options.dir);
  } catch (e) {
    console.log(`  app-server: FAILED (${e instanceof Error ? e.message : e})`);
    process.exit(1);
  }

  const auth = describeAuth(account);
  console.log(`  account: ${auth.detail}`);
  console.log(`  peer: ${describePeer(options.dir)}`);

  // Missing auth is reported, never fatal. This command's exit code answers
  // "is the installation sound?" — install.sh runs it as its own final check,
  // so failing here would tell anyone who installs before `codex login` that
  // their installation is broken. Logging in is a separate, later step.
  if (!auth.ready) {
    console.log("\nHealth check passed, but Codex is not authenticated — run 'codex login' before your first task.");
    return;
  }

  console.log("\nHealth check passed.");
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

export function handleTemplates(args: string[]): void {
  parseOptions(args); // reject unknown flags like every other command
  const templates = listTemplates();

  if (templates.length === 0) {
    console.log("No templates found.");
  } else {
    console.log("Available templates:\n");
    const maxName = Math.max(...templates.map(t => t.name.length));
    for (const t of templates) {
      const sandbox = t.sandbox ? ` (${t.sandbox})` : "";
      console.log(`  ${t.name.padEnd(maxName + 2)} ${t.description}${sandbox}`);
    }
  }

  console.log(`\nTemplate directories:`);
  console.log(`  User:     ~/.codex-collab/templates/`);
  console.log(`  Built-in: (bundled with codex-collab)`);
  console.log(`\nUsage: codex-collab run "prompt" --template <name>`);
}
