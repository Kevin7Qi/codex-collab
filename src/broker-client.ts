/**
 * BrokerClient — connects to a broker server via Unix socket / named pipe
 * and implements the AppServerClient interface.
 *
 * This allows callers to use the same interface whether connected directly
 * to `codex app-server` or through the broker multiplexer.
 *
 * The JSON-RPC plumbing lives in rpc.ts (shared with client.ts); this file
 * owns the socket transport: connect, close, and the broker handshake.
 */

import net from "node:net";
import type { AppServerClient } from "./client";
import { config } from "./config";
import { parseEndpoint } from "./broker";
import { createRpcEndpoint } from "./rpc";

export interface BrokerClientOptions {
  /** The broker endpoint (unix:/path or pipe:\path). */
  endpoint: string;
  /** Request timeout in ms. Defaults to config.requestTimeout (30s). */
  requestTimeout?: number;
}

/**
 * Connect to a broker server via Unix socket / named pipe.
 * Performs the initialize handshake and returns an AppServerClient.
 */
export async function connectToBroker(opts: BrokerClientOptions): Promise<AppServerClient> {
  const requestTimeout = opts.requestTimeout ?? config.requestTimeout;
  const target = parseEndpoint(opts.endpoint);

  // Connect to the socket
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const sock = new net.Socket();
    sock.setEncoding("utf8");

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Connection to broker timed out (${opts.endpoint})`));
    }, 5000);

    sock.on("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to broker: ${err.message}`));
    });

    sock.connect({ path: target.path });
  });

  let failed = false;

  const endpoint = createRpcEndpoint({
    label: "broker-client",
    requestTimeout,
    send: (data) => {
      if (socket.destroyed) return;
      socket.write(data);
    },
    // Mirror connectDirect's exited guard: after an unexpected socket close,
    // writes silently no-op on the dead socket — without this check a request
    // would sit in `pending` for the full 30s timeout (e.g. blocking Ctrl-C
    // shutdown's turn/interrupt on a dead broker).
    downReason: () => (failed || socket.destroyed ? "Broker connection closed" : null),
    overflowReason: "Broker response buffer exceeded maximum size",
    onOverflow: () => socket.destroy(new Error("Broker response buffer exceeded maximum size")),
    writeFailedPrefix: "Socket write failed: ",
  });

  function notifyUnexpectedClose(reason: string): void {
    failed = true;
    endpoint.fail(reason);
  }

  socket.on("data", (chunk: string) => endpoint.feed(chunk));

  socket.on("close", () => {
    notifyUnexpectedClose("Broker connection closed");
  });

  socket.on("error", (err) => {
    if (!endpoint.isClosed()) {
      console.error(`[broker-client] Socket error: ${err.message}`);
      notifyUnexpectedClose("Broker socket error: " + err.message);
    }
  });

  async function close(): Promise<void> {
    if (endpoint.isClosed()) return;
    endpoint.markClosed();
    socket.end();
    // Wait for the socket to fully close. Clear the safety timer once the
    // close lands so a leftover armed timer can't keep the event loop alive.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // If already destroyed, the close event may have fired before we could
      // subscribe — resolve immediately.
      if (socket.destroyed) {
        done();
        return;
      }
      socket.once("close", done);
    });
  }

  // Perform initialize handshake with the broker
  let userAgent: string;
  let brokerBusy = false;
  try {
    const result = await endpoint.request<{ userAgent: string; busy?: boolean }>("initialize", {
      clientInfo: {
        name: config.clientName,
        title: null,
        version: config.clientVersion,
      },
      capabilities: {
        // The broker handles this initialize locally (the app-server sees the
        // broker's own handshake from client.ts), but keep the declared
        // capabilities in lockstep with the direct path.
        experimentalApi: true,
        optOutNotificationMethods: ["item/reasoning/textDelta"],
      },
    });
    brokerBusy = result.busy === true;
    userAgent = result.userAgent;
    endpoint.notify("initialized");
  } catch (e) {
    await close();
    throw e;
  }

  return {
    request: endpoint.request,
    notify: endpoint.notify,
    on: endpoint.on,
    onAny: endpoint.onAny,
    onRequest: endpoint.onRequest,
    respond: endpoint.respond,
    onClose: endpoint.onClose,
    close,
    userAgent,
    brokerBusy,
  };
}
