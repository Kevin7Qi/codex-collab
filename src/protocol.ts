// src/protocol.ts — Backward compatibility shim (delegates to client.ts)
// Will be removed once all consumers import from client.ts directly

export { connectDirect as connect, formatNotification, formatResponse, parseMessage } from "./client";
export type { AppServerClient, ConnectOptions } from "./client";
