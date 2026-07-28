// src/commands/config.ts — config, models, health command handlers

import { config, listTemplates } from "../config";
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
    timeout:   { validate: v => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= MAX_TIMEOUT_SECONDS; }, hint: `seconds, 1-${MAX_TIMEOUT_SECONDS} (e.g. 1200)` },
    memory:    { validate: v => v === "true" || v === "false", hint: "true, false (let Codex memory learn from created threads)" },
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
