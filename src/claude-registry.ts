// src/claude-registry.ts — Claude Code's session registry, as codex-collab reads and writes it
//
// Claude Code keeps one JSON entry per running session under
// `~/.claude/sessions/`. codex-collab reads those entries to find sessions,
// and writes entries of its own so that Claude can address Codex. This module
// holds what both directions share: where the registry is, whether the
// process an entry names is alive and the one that registered, and the shape
// of an entry codex-collab writes. It knows nothing of the peer runtime.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { config, mailboxRoot, workspaceHash } from "./config";


export function sessionsDir(): string {
  // Override for tests and probes — writing a FAKE registry must never
  // touch the user's real one.
  return process.env.CODEX_COLLAB_SESSIONS_DIR ?? join(homedir(), ".claude", "sessions");
}

/** Exact `ps -o lstart=` output for a pid, in the registry's expected form.
 *  TZ/locale pinned, edges trimmed ONLY — `ps` pads the day ("Sat Aug  8")
 *  and the validator compares by exact string equality. */
export function procStartOf(pid: number): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).toString().replace(/^\s+|\s+$/g, "");
}

/** A pid's start time as Claude Code records it for its OWN sessions on
 *  Linux: field 22 of /proc/<pid>/stat (`starttime`, clock ticks since boot),
 *  kept as the decimal string it is. null anywhere that cannot be read — not
 *  Linux, the pid gone, or a pid from another namespace.
 *
 *  `comm` (field 2) is the executable's name in parentheses and may itself
 *  hold spaces and parentheses, so the fields are counted from the LAST ")". */
export function procStartTicksOf(pid: number, statPath = `/proc/${pid}/stat`): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(statPath, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    // After ") " comes field 3 (state); starttime is field 22, index 19 here.
    const ticks = stat.slice(close + 2).split(" ")[19];
    return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/** The pid domain this process lives in, in the form Claude Code writes to
 *  its registry entries on Linux (`pidDomain`): the machine id and the PID
 *  namespace. A pid means something only inside its own domain — a command
 *  Codex runs in its sandbox (its own PID namespace from 0.154) sees none of
 *  the host's pids. Built exactly as Claude Code builds it, a part it cannot
 *  read left empty (a container often has no /etc/machine-id): two domains
 *  are compared as strings, and one written differently would read as
 *  another machine's. null where there is no such thing (not Linux). */
export function ownPidDomain(): string | null {
  if (process.platform !== "linux") return null;
  let machine = "";
  try { machine = readFileSync("/etc/machine-id", "utf-8").trim(); } catch { /* none */ }
  let ns = "";
  try { ns = readlinkSync("/proc/self/ns/pid"); } catch { /* none */ }
  return `linux:${machine}:${ns}`;
}

/** What one look at a registry entry's process says: it is the process that
 *  registered, it is not, or this process has no means to tell. */
export type ProcIdentity = "live" | "dead" | "unverifiable";

/** Test seams: the three probes `procIdentity` makes. */
export interface ProcProbes {
  ownDomain?: () => string | null;
  ticksOf?: (pid: number) => string | null;
  lstartOf?: (pid: number) => string;
  signal?: (pid: number) => void;
}

/** Whether the process a registry entry names is alive AND the one that
 *  registered. The one place this is decided, for every reader of Claude
 *  Code's entries.
 *
 *  `procStart` comes in two representations: Claude Code on Linux writes
 *  /proc clock ticks, and where there is no /proc (macOS) — as in the
 *  entries codex-collab writes itself — it is `ps -o lstart=`. A match on
 *  either is a match; comparing one against the other made every Linux
 *  session look dead.
 *
 *  `unverifiable` is for an entry from another pid domain, or one whose
 *  start time nothing here can read (Codex's pre-0.154 sandbox forbids `ps`
 *  and answers `kill -0` with EPERM). Callers may take other evidence for
 *  such an entry — never a reason to signal its pid. */
export function procIdentity(entry: Record<string, unknown>, probes: ProcProbes = {}): ProcIdentity {
  const pid = entry.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "dead";
  // Domain first: in another domain the pid names a different process, or
  // none, and neither answer says anything about the session.
  if (typeof entry.pidDomain === "string") {
    const own = (probes.ownDomain ?? ownPidDomain)();
    if (own !== null && own !== entry.pidDomain) return "unverifiable";
  }
  try {
    (probes.signal ?? ((p: number) => { process.kill(p, 0); }))(pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    // EPERM: it exists and is someone else's — the start time decides.
  }
  if (typeof entry.procStart !== "string") return "live";
  const ticks = (probes.ticksOf ?? procStartTicksOf)(pid);
  if (ticks !== null && /^\d+$/.test(entry.procStart)) return entry.procStart === ticks ? "live" : "dead";
  let lstart: string | null = null;
  try { lstart = (probes.lstartOf ?? procStartOf)(pid); } catch { lstart = null; }
  if (lstart === null) return "unverifiable";
  return entry.procStart === lstart ? "live" : "dead";
}

/** Lowest Claude Code that binds a cross-session messaging socket. From its
 *  changelog: 2.1.224 "Added cross-session SendMessage … (macOS and Linux)".
 *  Later releases fixed bugs around it, but this is where the capability
 *  starts, and gating higher would refuse installs that work. */
export const MESSAGING_FLOOR = "2.1.224";

/** Compare dotted numeric versions. Returns <0, 0, >0 like a comparator, and
 *  treats a missing or non-numeric segment as 0 so "2.1" sorts below "2.1.1"
 *  and a suffixed build ("2.1.224-beta") compares on its numbers. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The installed Claude Code's version, or null when it cannot be determined
 *  (not installed, not on PATH, or output we do not recognize).
 *
 *  Memoized: this shells out, and it is asked once per render and once per
 *  broker start. A version that changes under a running process is a Claude
 *  Code upgrade, which `skill sync` notices separately. */
let claudeVersionCache: { value: string | null } | null = null;

export function claudeCodeVersion(): string | null {
  if (claudeVersionCache) return claudeVersionCache.value;
  let value: string | null = null;
  try {
    // `claude --version` prints e.g. "2.1.241 (Claude Code)".
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    value = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch { /* absent, not executable, or too slow — treat as unknown */ }
  claudeVersionCache = { value };
  return value;
}

/** Test seam: forget the memoized version. */
export function resetClaudeVersionCache(): void {
  claudeVersionCache = null;
}

/** A plausible Claude Code version string for our registry entries: borrow
 *  it from any live sibling session's entry, else the installed binary's,
 *  else the last version this was verified against. The registry does not
 *  validate it, but `claude agents` shows it. */
export function sniffRegistryVersion(): string {
  try {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
        if (typeof parsed?.version === "string" && typeof parsed?.pid === "number") {
          try {
            process.kill(parsed.pid, 0);
            return parsed.version;
          } catch { /* dead entry — keep looking */ }
        }
      } catch { /* unreadable entry — keep looking */ }
    }
  } catch { /* no registry dir */ }
  // No live sibling to borrow from: the installed binary's version, then
  // the last one this was verified against.
  return claudeCodeVersion() ?? "2.1.226";
}

/** True when a registry entry's messaging socket belongs to a codex-collab
 *  broker (any workspace) rather than a real Claude session. Exported for
 *  tests. Path-based rather than a marker field: the socket path is one we
 *  already write, and Claude Code validates none of it. */
export function isCodexCollabSocket(socketPath: unknown): boolean {
  if (typeof socketPath !== "string" || socketPath.length === 0) return false;
  const root = config.dataDir;
  if (socketPath === root || socketPath.startsWith(root + sep)) return true;
  // A task's receiver (see `send`) registers a socket under the temp root
  // (short enough for any home directory); it is a Codex session's, not
  // Claude's. The temp root follows TMPDIR, which differs between processes —
  // a sandboxed shell, a login that sets its own — so it is recognised by its
  // own name wherever it sits, not only where this process would put it.
  const tmpRoot = mailboxRoot();
  return socketPath.startsWith(tmpRoot + sep) || basename(dirname(socketPath)) === basename(tmpRoot);
}

/** The workspace half of every peer address this broker registers. The
 *  session registry is shared across workspaces and the name IS the
 *  messaging address, so a name carrying only a topic or a thread slug can
 *  be claimed by two checkouts at once and SendMessage reaches whichever
 *  registered last. Same suffix the front door carries, so every address
 *  from one workspace is recognizably from it. */
export function workspaceSuffix(cwd: string): string {
  return workspaceHash(cwd).slice(0, 6);
}

export function buildRegistryEntry(opts: {
  pid: number;
  cwd: string;
  name: string;
  socketPath: string;
  version: string;
  procStart: string;
  sessionId: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    pid: opts.pid,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    startedAt: now,
    procStart: opts.procStart,
    version: opts.version,
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: opts.socketPath,
    name: opts.name,
    // Claude Code's own values are `derived` (from the cwd) and `user` (set
    // deliberately). A peer address is chosen, never derived, and renderings
    // that hide derived names keep a `user` one visible.
    nameSource: "user",
    status: "idle",
    updatedAt: now,
    statusUpdatedAt: now,
  };
}
