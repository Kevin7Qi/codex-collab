// Tests for shared-server.ts — the WebSocket-over-unix-socket client that
// attaches codex-collab to Codex's own app-server, and the attach/spawn
// decision around it. The server side is a Bun.serve unix-socket WebSocket
// speaking just enough JSON-RPC to exercise the framing and the handshake.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import {
  acceptKeyFor,
  attachSupported,
  connectAppServer,
  connectShared,
  controlSocketPath,
  decodeFrames,
  encodeFrame,
  serverPreference,
} from "./shared-server";

const onWindows = process.platform === "win32";

// Unix socket paths have a ~104-byte ceiling; macOS's TMPDIR is long, so
// keep the tail short and let the per-test dir carry the uniqueness.
function shortTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ss-"));
}

type Handler = (msg: Record<string, unknown>, reply: (m: unknown) => void, ws: { send(s: string): void }) => void;

/** A fake app-server on a unix socket: answers initialize, then hands every
 *  other request to `onRequest`. Returns the server and a way to push
 *  notifications / server requests to the most recent client. */
function fakeServer(socketPath: string, onRequest: Handler, opts: { silentInitialize?: boolean } = {}) {
  let latest: { send(s: string): void } | null = null;
  const server = Bun.serve({
    unix: socketPath,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) { latest = ws; },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        const reply = (m: unknown) => ws.send(JSON.stringify(m));
        if (msg.method === "initialize") {
          if (!opts.silentInitialize) reply({ id: msg.id, result: { userAgent: "fake-shared/1.0" } });
          return;
        }
        if (msg.id === undefined) return; // notifications
        if (msg.method === undefined) { onRequest(msg, reply, ws); return; } // a response to our request
        onRequest(msg, reply, ws);
      },
    },
  });
  return {
    server,
    push: (m: unknown) => latest?.send(JSON.stringify(m)),
    stop: () => server.stop(true),
  };
}

describe.skipIf(onWindows)("shared-server: WebSocket client", () => {
  test("a socket that accepts and hangs up before any answer fails at once, not at the deadline", async () => {
    const dir = shortTempDir();
    const socketPath = join(dir, "h.sock");
    const server = net.createServer((sock) => { sock.destroy(); });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
    try {
      const started = Date.now();
      const err = await connectShared({ socketPath, connectTimeout: 3000, requestTimeout: 30_000 }).catch((e: unknown) => e) as Error;
      // Whichever the kernel reports first — the hang-up, or the write it
      // broke (EPIPE / ECONNRESET) — the failure is immediate.
      expect(err.message).toMatch(/closed the connection|EPIPE|ECONNRESET/);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a large message arriving in many chunks is decoded whole", async () => {
    const dir = shortTempDir();
    const socketPath = join(dir, "big.sock");
    const big = "x".repeat(300_000);
    const fake = fakeServer(socketPath, () => {});
    try {
      const client = await connectShared({ socketPath, connectTimeout: 2000, requestTimeout: 5000 });
      const got = new Promise<string>((resolve) => client.on("big/notification", (p) => resolve((p as { text: string }).text)));
      fake.push({ method: "big/notification", params: { text: big } });
      expect((await got).length).toBe(big.length);
      await client.close();
    } finally {
      fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a socket that upgrades but never answers initialize fails within the connect deadline", async () => {
    const dir = shortTempDir();
    const socketPath = join(dir, "s.sock");
    const fake = fakeServer(socketPath, () => {}, { silentInitialize: true });
    try {
      const started = Date.now();
      const err = await connectShared({ socketPath, connectTimeout: 300, requestTimeout: 30_000 }).catch((e: unknown) => e) as Error;
      expect(err.message).toContain("initializ");
      expect(Date.now() - started).toBeLessThan(3000); // not the 30 s request timeout
    } finally {
      fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let dir: string;
  let sock: string;
  beforeEach(() => { dir = shortTempDir(); sock = join(dir, "s.sock"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("frames round-trip through encode/decode at every length class", () => {
    for (const len of [0, 1, 125, 126, 65535, 65536, 200_000]) {
      const payload = Buffer.alloc(len, 0x41);
      const { frames, rest } = decodeFrames(encodeFrame(0x1, payload));
      expect(frames).toHaveLength(1);
      expect(frames[0].fin).toBe(true);
      expect(frames[0].opcode).toBe(0x1);
      expect(frames[0].payload.equals(payload)).toBe(true);
      expect(rest.length).toBe(0);
    }
  });

  test("a partial frame is left in the remainder until the rest arrives", () => {
    const whole = encodeFrame(0x1, Buffer.from("hello"));
    const first = decodeFrames(whole.subarray(0, 4));
    expect(first.frames).toHaveLength(0);
    expect(first.rest.length).toBe(4);
    const second = decodeFrames(Buffer.concat([first.rest, whole.subarray(4)]));
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].payload.toString()).toBe("hello");
  });

  test("accept key follows RFC 6455's worked example", () => {
    expect(acceptKeyFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("connects, handshakes, and carries requests, notifications and server requests", async () => {
    const seen: string[] = [];
    const fake = fakeServer(sock, (msg, reply, ws) => {
      if (msg.method === "echo") { reply({ id: msg.id, result: { got: msg.params } }); return; }
      if (msg.method === "fail") { reply({ id: msg.id, error: { code: -32600, message: "thread x already has an active writer" } }); return; }
      if (msg.method === "big") { reply({ id: msg.id, result: { text: "z".repeat(150_000) } }); return; }
      if (msg.method === undefined) { seen.push(`client answered ${JSON.stringify(msg.result)}`); return; }
      reply({ id: msg.id, error: { code: -32601, message: "nope" } });
    });
    try {
      const client = await connectShared({ socketPath: sock });
      expect(client.userAgent).toBe("fake-shared/1.0");
      expect(client.server).toEqual({ kind: "shared", socketPath: sock });
      expect(client.isBrokered).toBe(false);

      expect(await client.request<{ got: unknown }>("echo", { a: 1 })).toEqual({ got: { a: 1 } });
      // A payload well past the 16-bit length class survives fragmentation.
      const big = await client.request<{ text: string }>("big");
      expect(big.text.length).toBe(150_000);

      const err = await client.request("fail").catch((e: unknown) => e) as { rpcCode: number; detail: string; message: string };
      expect(err.rpcCode).toBe(-32600);
      expect(err.detail).toBe("thread x already has an active writer");
      expect(err.message).toBe("JSON-RPC error -32600: thread x already has an active writer");

      const note = new Promise<unknown>((r) => client.on("turn/started", r));
      fake.push({ method: "turn/started", params: { threadId: "t1" } });
      expect(await note).toEqual({ threadId: "t1" });

      client.onRequest("item/commandExecution/requestApproval", () => ({ decision: "accept" }));
      fake.push({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } });
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual(['client answered {"decision":"accept"}']);

      await client.close();
    } finally {
      fake.stop();
    }
  });

  test("connection loss after the handshake rejects pending requests and fires onClose", async () => {
    const fake = fakeServer(sock, () => { /* never answers */ });
    const client = await connectShared({ socketPath: sock, requestTimeout: 5000 });
    const closed = new Promise<void>((r) => client.onClose(r));
    const pending = client.request("slow");
    fake.stop();
    await closed;
    await expect(pending).rejects.toThrow(/connection closed|socket/i);
    await client.close(); // idempotent after loss
  });

  test("nothing listening rejects promptly with the socket path in the message", async () => {
    const err = await connectShared({ socketPath: join(dir, "absent.sock"), connectTimeout: 2000 }).catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("absent.sock");
  });
});

describe("shared-server: preference and socket resolution", () => {
  test("control socket path derives from CODEX_HOME, with an explicit override winning", () => {
    // Expectations go through resolve() too: on Windows an absolute POSIX
    // path gains the current drive, and the function resolves its inputs.
    expect(controlSocketPath({ CODEX_HOME: "/x/codex" })).toBe(join(resolve("/x/codex"), "app-server-control", "app-server-control.sock"));
    expect(controlSocketPath({ HOME: "/home/u" })).toBe(join(resolve("/home/u"), ".codex", "app-server-control", "app-server-control.sock"));
    expect(controlSocketPath({ CODEX_COLLAB_SERVER_SOCKET: "/tmp/other.sock", CODEX_HOME: "/x" })).toBe(resolve("/tmp/other.sock"));
  });

  test("the environment overrides the config file, then the file, then auto", () => {
    const dir = shortTempDir();
    try {
      const cfg = join(dir, "config.json");
      expect(serverPreference({ CODEX_COLLAB_SERVER: "private" }, cfg)).toEqual({ preference: "private", reason: "CODEX_COLLAB_SERVER=private" });
      // An unknown environment value is ignored; with no file, auto applies.
      expect(serverPreference({ CODEX_COLLAB_SERVER: "bogus" }, cfg).preference).toBe("auto");
      writeFileSync(cfg, JSON.stringify({ server: "shared" }));
      expect(serverPreference({ CODEX_COLLAB_SERVER: "bogus" }, cfg)).toEqual({ preference: "shared", reason: "config server shared" });
      writeFileSync(cfg, JSON.stringify({ server: "nonsense" }));
      expect(serverPreference({}, cfg).preference).toBe("auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("attach is unsupported on Windows only", () => {
    expect(attachSupported("win32")).toBe(false);
    expect(attachSupported("darwin")).toBe(true);
    expect(attachSupported("linux")).toBe(true);
  });
});

describe.skipIf(onWindows)("shared-server: connectAppServer decision", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = shortTempDir();
    for (const k of ["CODEX_COLLAB_SERVER", "CODEX_COLLAB_SERVER_SOCKET", "CODEX_HOME"]) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });

  test("auto attaches when the control socket answers", async () => {
    const sock = join(dir, "c.sock");
    const fake = fakeServer(sock, (msg, reply) => reply({ id: msg.id, result: {} }));
    process.env.CODEX_COLLAB_SERVER = "auto";
    process.env.CODEX_COLLAB_SERVER_SOCKET = sock;
    try {
      const client = await connectAppServer();
      expect(client.server.kind).toBe("shared");
      await client.close();
    } finally {
      fake.stop();
    }
  });

  test("shared insists: no socket is an error that names it and the remedy", async () => {
    process.env.CODEX_COLLAB_SERVER = "shared";
    process.env.CODEX_COLLAB_SERVER_SOCKET = join(dir, "missing.sock");
    const err = await connectAppServer().catch((e: unknown) => e) as Error;
    expect(err.message).toContain("missing.sock");
    expect(err.message).toContain("codex app-server daemon start");
  });

  test("a socket file that nothing serves is skipped under auto and fatal under shared", async () => {
    const sock = join(dir, "dead.sock");
    writeFileSync(sock, ""); // a plain file where a socket used to be
    process.env.CODEX_COLLAB_SERVER_SOCKET = sock;
    process.env.CODEX_COLLAB_SERVER = "shared";
    const err = await connectAppServer().catch((e: unknown) => e) as Error;
    expect(err.message).toContain("Could not attach");
    // auto falls through to the private path — which needs a real codex;
    // a mock command keeps the test hermetic and proves the decision alone.
    process.env.CODEX_COLLAB_SERVER = "auto";
    const mock = join(dir, "mock.ts");
    writeFileSync(mock, `
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of Bun.stdin.stream()) { buf += dec.decode(chunk);
        let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
          const m = JSON.parse(line); if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: { userAgent: "mock-private/1" } })); } }
    `);
    const client = await connectAppServer({ command: ["bun", "run", mock] });
    expect(client.server.kind).toBe("private");
    await client.close();
  });

  test("shared on Windows is refused, not quietly downgraded to a private server", async () => {
    process.env.CODEX_COLLAB_SERVER = "shared";
    const err = await connectAppServer(undefined, "win32").catch((e: unknown) => e) as Error;
    expect(err.message).toContain("cannot be reached on Windows");
    expect(err.message).toContain("config server auto");
  });

  test("private never looks at the socket", async () => {
    const sock = join(dir, "c.sock");
    let touched = false;
    const fake = fakeServer(sock, (msg, reply) => { touched = true; reply({ id: msg.id, result: {} }); });
    process.env.CODEX_COLLAB_SERVER = "private";
    process.env.CODEX_COLLAB_SERVER_SOCKET = sock;
    const mock = join(dir, "mock.ts");
    writeFileSync(mock, `
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of Bun.stdin.stream()) { buf += dec.decode(chunk);
        let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
          const m = JSON.parse(line); if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: { userAgent: "mock-private/1" } })); } }
    `);
    try {
      const client = await connectAppServer({ command: ["bun", "run", mock] });
      expect(client.server.kind).toBe("private");
      expect(touched).toBe(false);
      await client.close();
    } finally {
      fake.stop();
    }
  });
});
