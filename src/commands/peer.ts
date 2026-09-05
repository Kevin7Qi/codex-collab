// codex-collab peer — inspect and manage the workspace's front-door peer.
//
//   peer            status: capability, broker, registry entry, socket
//   peer up         ensure the broker (and with it the peer) is running

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../config";
import { parseOptions } from "./shared";
import { peerCapability, peerNameFor, sessionsDir } from "../peer";
import { listRuns } from "../threads";
import { loadBrokerState, teardownBroker } from "../broker";
import { ensureConnection } from "../broker";

export interface PeerState {
  pid: number;
  name: string;
  socketPath: string;
  startedAt: string;
}

export function readPeerState(stateDir: string): PeerState | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "peer-state.json"), "utf-8"));
    if (typeof parsed?.pid === "number" && typeof parsed?.socketPath === "string") {
      return parsed as PeerState;
    }
  } catch { /* absent */ }
  return null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function handlePeer(args: string[]): Promise<void> {
  // `--dir` is a global flag, so it may appear on either side of the
  // subcommand. parseOptions is unordered and already resolves the path;
  // reading process.cwd() directly meant `-d <path>` silently inspected the
  // wrong workspace — and `peer up` started a broker for it.
  const { positional, options } = parseOptions(args);
  const sub = positional[0] ?? "status";
  const cwd = options.dir;
  if (!existsSync(cwd)) {
    console.error(`Error: --dir path does not exist: ${cwd}`);
    process.exit(1);
  }
  const stateDir = resolveStateDir(cwd);

  if (sub === "up") {
    // A broker decides once, at startup, whether it can register a peer —
    // so one that started before Claude Code was installed, or before the
    // session registry existed, stays peerless for its whole life. Merely
    // connecting to it changes nothing, which is why `peer up` used to
    // report the same failure however many times it was run. Replace it,
    // but only when replacing it cannot interrupt anything.
    const existing = loadBrokerState(stateDir);
    if (existing?.pid && isAlive(existing.pid) && !readPeerState(stateDir) && peerCapability().ok) {
      const running = listRuns(stateDir).filter((r) => r.status === "running");
      if (running.length > 0) {
        console.error(`A broker is running for this workspace but has no peer, and it cannot be replaced while ${running.length} run${running.length === 1 ? " is" : "s are"} in flight.`);
        console.error(`Wait for ${running.length === 1 ? "it" : "them"} to finish, or stop ${running.length === 1 ? "it" : "them"} with \`codex-collab kill\`, then run \`codex-collab peer up\` again.`);
        process.exit(1);
      }
      console.log("Broker is running without a peer — replacing it so the peer can register.");
      teardownBroker(stateDir, existing);
    }
    // Spawning the broker starts the peer with it; the connection itself is
    // only the vehicle and closes right away.
    const client = await ensureConnection(cwd);
    await client.close();
    // Fall through to status so `peer up` reports what it achieved.
  } else if (sub !== "status") {
    console.error(`Unknown peer subcommand: ${sub} (expected: status, up)`);
    process.exit(1);
  }

  const capability = peerCapability();
  console.log(`Peer capability: ${capability.ok ? "available" : `unavailable — ${capability.reason}`}`);
  if (!capability.ok) return;

  const state = readPeerState(stateDir);
  if (!state) {
    // Distinguish the two ways there can be no peer: they need different
    // things done about them, and reporting both as "no broker yet" sent
    // the user back to a command that had just declined to help.
    const broker = loadBrokerState(stateDir);
    if (broker?.pid && isAlive(broker.pid)) {
      console.log(`Peer: not registered, though a broker IS running (pid ${broker.pid}).`);
      console.log(`It started when no peer could be registered. Run \`codex-collab peer up\` to replace it once no runs are in flight.`);
    } else {
      console.log(`Peer: not running (no broker for this workspace yet — start one with \`codex-collab peer up\`)`);
    }
    return;
  }

  const brokerAlive = isAlive(state.pid);
  const entryPath = join(sessionsDir(), `${state.pid}.json`);
  const entryPresent = existsSync(entryPath);
  const socketPresent = existsSync(state.socketPath);

  console.log(`Peer name:  ${state.name} (expected for this workspace: ${peerNameFor(cwd)})`);
  console.log(`Broker pid: ${state.pid} (${brokerAlive ? "alive" : "DEAD — stale state"})`);
  console.log(`Registry:   ${entryPresent ? entryPath : "MISSING entry"}`);
  console.log(`Socket:     ${socketPresent ? state.socketPath : "MISSING socket"}`);
  console.log(`Started:    ${state.startedAt}`);
  if (brokerAlive && entryPresent && socketPresent) {
    console.log(`\nClaude sessions can message this workspace's Codex as "${state.name}".`);
  } else if (!brokerAlive) {
    console.log(`\nRun \`codex-collab peer up\` to start a fresh broker + peer.`);
  }
}
