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
import { ensureConnection, isBrokerAlive, isBrokerBusyError, loadBrokerState } from "../broker";
import { connectToBroker } from "../broker-client";
import { attachSupported, controlSocketPath, serverPreference } from "../shared-server";

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
    // so one that started before Claude Code was installed, or under
    // `config mode cli`, keeps that answer for its whole life. Merely
    // connecting to it changes nothing. So `peer up` retires a broker whose
    // peer state disagrees with what the mode now says: peerless (or with a
    // half-registered peer) when the peer should run, or serving a peer
    // when the mode says it must not. The broker itself refuses while a
    // turn is claimed — a ledger snapshot here cannot see a turn that
    // starts a moment later, only the broker can.
    const capability = peerCapability();
    const broker = loadBrokerState(stateDir);
    // Liveness by the socket, never by the pid alone: a broker that crashed
    // leaves a pid the OS may hand to something unrelated.
    const brokerLive = broker?.endpoint ? await isBrokerAlive(broker.endpoint) : false;
    const state = readPeerState(stateDir);
    const peerHealthy = state !== null
      && isAlive(state.pid)
      && existsSync(join(sessionsDir(), `${state.pid}.json`))
      && existsSync(state.socketPath);
    let why: string | null = null;
    if (brokerLive && capability.ok && !peerHealthy) {
      why = state ? "its peer is not fully registered" : "has no peer";
    } else if (brokerLive && !capability.ok && state && isAlive(state.pid)) {
      why = `still serves a peer though peer messaging is off (${capability.reason})`;
    }
    // The app-server is chosen at startup too. A broker that started
    // before Codex's shared server came up, or before `config server`
    // changed, keeps the one it has; `peer up` is the documented way to
    // move it, so compare what it runs on with what the setting says now.
    let serverWhy: string | null = null;
    if (brokerLive && !why && broker?.endpoint) {
      const { preference } = serverPreference();
      let kind: string | null = null;
      try {
        const probe = await connectToBroker({ endpoint: broker.endpoint });
        kind = probe.server.kind;
        await probe.close().catch(() => undefined);
      } catch { /* went away between the probe and now */ }
      const sharedAvailable = attachSupported() && existsSync(controlSocketPath());
      if (kind === "private" && preference !== "private" && sharedAvailable) {
        serverWhy = `runs a private app-server though Codex's shared one is listening at ${controlSocketPath()}`;
      } else if (kind === "shared" && preference === "private") {
        serverWhy = "is attached to Codex's shared app-server though `config server` is private";
      }
      if (serverWhy) why = serverWhy;
    }
    if (why && broker) {
      const running = listRuns(stateDir).filter((r) => r.status === "running");
      if (running.length > 0) {
        console.error(`The broker for this workspace must be replaced (${why}), but not while ${running.length} run${running.length === 1 ? " is" : "s are"} in flight.`);
        console.error(`Wait for ${running.length === 1 ? "it" : "them"} to finish, or stop ${running.length === 1 ? "it" : "them"} with \`codex-collab kill\`, then run \`codex-collab peer up\` again.`);
        process.exit(1);
      }
      console.log(`Broker is running and ${why} — stopping it${serverWhy ? " so its replacement starts on the right app-server" : capability.ok ? " so a new one can register the peer" : ""}.`);
      try {
        const client = await connectToBroker({ endpoint: broker.endpoint! });
        try {
          await client.request("broker/shutdown", { ifIdle: true });
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (e) {
        if (isBrokerBusyError(e)) {
          console.error("A turn started on the broker just now, so it was left running. Run `codex-collab peer up` again once it finishes.");
          process.exit(1);
        }
        // Unreachable after all (it exited between the probe and now):
        // nothing to stop, carry on to start a fresh one.
      }
      // The broker exits once its app-server is closed; a fresh one must
      // not race that.
      for (let i = 0; i < 100 && await isBrokerAlive(broker.endpoint); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // `peer up` is the documented way to start or restart the workspace
    // broker in every mode: with peer messaging it registers the peer, and
    // without it the broker still needs starting — on the app-server the
    // setting names — which nothing else does until the first run.
    if (capability.ok || serverWhy || !brokerLive) {
      // Spawning the broker starts the peer with it; the connection itself is
      // only the vehicle and closes right away.
      const client = await ensureConnection(cwd);
      if (serverWhy) console.log(`Broker restarted on a ${client.server.kind} app-server.`);
      else if (!brokerLive && !capability.ok) console.log(`Broker started on a ${client.server.kind} app-server.`);
      await client.close();
    }
    // Fall through to status so `peer up` reports what it achieved.
  } else if (sub !== "status") {
    console.error(`Unknown peer subcommand: ${sub} (expected: status, up)`);
    process.exit(1);
  }

  const capability = peerCapability();
  console.log(`Peer capability: ${capability.ok ? "available" : `unavailable — ${capability.reason}`}`);
  if (!capability.ok) {
    // Off by mode, yet a broker that started under the old answer may still
    // be serving a peer. Say so — `health` says "off", ListAgents disagrees.
    const stale = readPeerState(stateDir);
    if (stale && isAlive(stale.pid)) {
      console.log(`Peer: still registered as "${stale.name}" by the running broker (pid ${stale.pid}), which started before the mode changed. \`codex-collab peer up\` retires it.`);
    }
    return;
  }

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
