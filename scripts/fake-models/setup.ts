import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

export const versions = { claude: "2.1.332", codex: "0.172.0" } as const;

export function toolCommand(name: string, ...args: string[]): string[] {
  return process.platform === "win32" ? ["cmd.exe", "/d", "/c", name, ...args] : [name, ...args];
}

export function createFixture(port: number) {
  // Unix broker sockets live under HOME and have a short kernel pathname limit.
  const baseDir = process.platform === "win32" ? homedir() : "/tmp";
  const home = realpathSync(mkdtempSync(join(baseDir, ".cc-fixture-")));
  const workspace = join(home, "ws");
  const codexHome = join(home, ".codex");
  const temp = join(home, "tmp");
  for (const dir of [workspace, codexHome, temp, join(home, ".claude", "sessions")]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "USER", "USERNAME", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const base = `http://127.0.0.1:${port}`;
  const dummyKey = "fixture-invalid-key";
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: temp, TMP: temp, TEMP: temp,
    ANTHROPIC_API_KEY: dummyKey, ANTHROPIC_BASE_URL: base,
    CODEX_HOME: codexHome, COLLAB_FIXTURE_KEY: dummyKey,
    CODEX_COLLAB_NO_UPDATE_CHECK: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CODEX_COLLAB_REAP_POLL_MS: "500", CODEX_COLLAB_CHANNEL_CHECK_MS: "500",
    ENABLE_TOOL_SEARCH: "false", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = Bun.spawnSync(["git", "init", "--quiet", workspace], { env });
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [dummyKey], rejected: [] },
    projects: { [realpathSync(workspace)]: { hasTrustDialogAccepted: true } },
  }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["SendMessage"] } }));
  writeFileSync(join(codexHome, "config.toml"), `model = "gpt-5.4"
model_provider = "loopback_fixture"
analytics.enabled = false
check_for_update_on_startup = false
[model_providers.loopback_fixture]
name = "Loopback fixture"
base_url = "${base}/v1"
env_key = "COLLAB_FIXTURE_KEY"
wire_api = "responses"

[projects.${JSON.stringify(realpathSync(workspace))}]
trust_level = "trusted"
`);
  return { home, workspace, env };
}

export async function configureTools(home: string, env: Record<string, string>, install: boolean) {
  const paths = [dirname(process.execPath), env.PATH ?? ""];
  if (install) {
    const dir = join(home, "tools");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), "{}\n");
    const tools = [`@anthropic-ai/claude-code@${versions.claude}`, `@openai/codex@${versions.codex}`];
    const installEnv = { ...env, PATH: paths.join(delimiter), BUN_INSTALL_CACHE_DIR: join(dir, "cache") };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete installEnv[name as keyof typeof installEnv];
    const proc = Bun.spawn([process.execPath, "add", "--trust", ...tools], { cwd: dir, env: installEnv, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error("Failed to install pinned fixture CLIs");
    paths.unshift(join(dir, "node_modules", ".bin"));
  }
  env.PATH = paths.join(delimiter);
  for (const name of ["claude", "codex"] as const) {
    const exe = Bun.which(name, { PATH: env.PATH });
    if (!exe) throw new Error(`Missing ${name} on PATH; rerun with --install`);
    const version = Bun.spawnSync(toolCommand(exe, "--version"), { env });
    if (version.exitCode !== 0) throw new Error(`Cannot run ${name}: ${version.stderr.toString()}`);
    const actual = version.stdout.toString().trim();
    console.log(actual);
    if (!actual.includes(versions[name])) console.warn(`Fixture validated with ${name} ${versions[name]}; use --install to pin it`);
    if (name === "codex" && process.platform === "linux" && !Bun.which("bwrap", { PATH: env.PATH })) {
      const modules = dirname(dirname(realpathSync(exe)));
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const triplet = process.arch === "arm64" ? "aarch64" : "x86_64";
      for (const parent of [join(modules, "node_modules", "@openai"), dirname(modules)]) {
        const bin = join(parent, `codex-linux-${arch}`, "vendor", `${triplet}-unknown-linux-musl`, "codex-resources");
        if (existsSync(join(bin, "bwrap"))) {
          env.PATH += delimiter + bin;
          break;
        }
      }
    }
  }
}
