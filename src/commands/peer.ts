// codex-collab peer — inspect and manage the workspace's front-door peer.
//
//   peer            status: capability, broker, registry entry, socket
//   peer up         ensure the broker (and with it the peer) is running

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../config";
import { peerCapability, peerNameFor, sessionsDir } from "../peer";
import { ensureConnection } from "../broker";

interface PeerState {
  pid: number;
  name: string;
  socketPath: string;
  startedAt: string;
}

function readPeerState(stateDir: string): PeerState | null {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "peer-state.json"), "utf-8"));
    if (typeof parsed?.pid === "number" && typeof parsed?.socketPath === "string") {
      return parsed as PeerState;
    }
  } catch { /* absent */ }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function handlePeer(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const cwd = process.cwd();
  const stateDir = resolveStateDir(cwd);

  if (sub === "up") {
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
    console.log(`Peer: not running (no broker for this workspace yet — start one with \`codex-collab peer up\`)`);
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
