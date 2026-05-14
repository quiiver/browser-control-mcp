# Browser-Control Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the mcp-server into a singleton local daemon (owns port 8089 + Firefox WebSocket) and a thin per-Claude stdio client, so multiple Claude instances can drive the browser concurrently.

**Architecture:** New `daemon.ts` bootstrap + `ipc-server.ts`, `ws-bridge.ts`, `request-router.ts` modules. New `daemon-client.ts` on the mcp-server side. `browser-api.ts` shrinks to a thin wrapper that delegates every method to `daemon-client`. Shared protocol types and HMAC helper live in `common/`. Both processes share the same `tsc` build; daemon runs from `dist/daemon.js`.

**Tech Stack:** Node.js ≥22 (`node:net` for UDS/named pipe IPC, `node:child_process.spawn` for daemon spawn, `node:crypto` for HMAC), TypeScript strict CommonJS ES2022, existing `ws` library, `node:test` for unit tests via `tsx`.

**Spec:** `docs/superpowers/specs/2026-05-14-browser-control-daemon-design.md`
**Branch:** `feat/browser-control-daemon` (already checked out off `main`)

---

## File Map

**New:**
- `common/daemon-protocol.ts` — protocol types + `PROTOCOL_VERSION` + `computeHelloAuth` helper
- `mcp-server/request-router.ts` — `Map<daemonCid, { clientSocket, clientCorrelationId }>` with timeout cleanup
- `mcp-server/ws-bridge.ts` — owns the Firefox WebSocket; extracted from `browser-api.ts`
- `mcp-server/ipc-server.ts` — accepts mcp-server clients over the local socket; handles `hello`/`request`/`status`
- `mcp-server/daemon.ts` — daemon bootstrap (wires logger, ws-bridge, ipc-server, signal handlers)
- `mcp-server/daemon-client.ts` — IPC client used by mcp-server to talk to the daemon
- `mcp-server/socket-path.ts` — resolves the right IPC socket path per platform
- Tests: `mcp-server/request-router.test.ts`, `mcp-server/ipc-protocol.test.ts`, `mcp-server/daemon-client.test.ts`

**Modified:**
- `mcp-server/browser-api.ts` — gutted; becomes a thin wrapper over `DaemonClient`
- `mcp-server/server.ts` — status tool returns `{ client, daemon }`; remove direct WS server bootstrap
- `mcp-server/health.ts` — `Health` becomes the *client-side* record; new `recordDaemonReachable`/`recordDaemonError`
- `mcp-server/package.json` — version → `1.7.0`; new `start:daemon` script
- `mcp-server/manifest.json` — version → `1.7.0`
- `common/index.ts` — re-export `daemon-protocol`

**Unchanged:**
- `firefox-extension/` — daemon speaks the same WebSocket protocol to the extension
- `mcp-server/logger.ts` — already env-configurable; daemon will set `LOG_FILE` to a different path

---

## Task 1: Shared protocol types

**Files:**
- Create: `common/daemon-protocol.ts`
- Modify: `common/index.ts`

- [ ] **Step 1: Create `common/daemon-protocol.ts`**

```typescript
import * as crypto from "crypto";
import type { ServerMessage } from "./server-messages";
import type { ExtensionMessage } from "./extension-messages";

export const PROTOCOL_VERSION = 1;

export interface HelloFrame {
  type: "hello";
  protocolVersion: number;
  clientPid: number;
  clientVersion: string;
  nonce: string;
  auth: string;
}

export interface HelloAckFrame {
  type: "hello-ack";
  protocolVersion: number;
  daemonPid: number;
  daemonVersion: string;
}

export interface ErrorFrame {
  type: "error";
  error: string;
  fatal?: boolean;
}

export interface RequestFrame {
  type: "request";
  clientCorrelationId: string;
  message: ServerMessage;
}

export interface ResponseFrame {
  type: "response";
  clientCorrelationId: string;
  ok: boolean;
  payload?: ExtensionMessage;
  error?: string;
}

export interface StatusRequestFrame {
  type: "status";
}

export interface DaemonStatus {
  startedAt: string;
  pid: number;
  wsConnected: boolean;
  wsPort: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
  daemonVersion: string;
}

export interface StatusResponseFrame {
  type: "status-response";
  daemon: DaemonStatus;
}

export type IpcClientToDaemon = HelloFrame | RequestFrame | StatusRequestFrame;
export type IpcDaemonToClient =
  | HelloAckFrame
  | ResponseFrame
  | StatusResponseFrame
  | ErrorFrame;

export interface HelloAuthPayload {
  protocolVersion: number;
  clientPid: number;
  clientVersion: string;
  nonce: string;
}

export function computeHelloAuth(secret: string, payload: HelloAuthPayload): string {
  const canonical = JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifyHelloAuth(secret: string, frame: HelloFrame): boolean {
  const expected = computeHelloAuth(secret, {
    protocolVersion: frame.protocolVersion,
    clientPid: frame.clientPid,
    clientVersion: frame.clientVersion,
    nonce: frame.nonce,
  });
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(frame.auth));
}
```

- [ ] **Step 2: Re-export from `common/index.ts`**

Open `common/index.ts` and add `export * from "./daemon-protocol";` to the existing re-exports.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/wstuckey/dev/browser-control-mcp && npm run build
```

Expected: clean build of `common` and dependent projects. (Even though no code uses these types yet, both `mcp-server` and `common` should still compile.)

- [ ] **Step 4: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add common/daemon-protocol.ts common/index.ts
git commit -m "$(cat <<'EOF'
Add shared IPC protocol types for browser-control daemon

Defines the NDJSON frames exchanged between the per-Claude mcp-server
client and the singleton daemon (hello/hello-ack, request/response,
status, error), plus the HMAC helper used for the hello handshake.
Types live in common/ so both processes import from one source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Socket path resolver

**Files:**
- Create: `mcp-server/socket-path.ts`

- [ ] **Step 1: Implement `socket-path.ts`**

```typescript
import * as os from "node:os";
import * as path from "node:path";

export function resolveSocketPath(): string {
  if (process.env.BROWSER_CONTROL_SOCKET) {
    return process.env.BROWSER_CONTROL_SOCKET;
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\browser-control-mcp`;
  }
  return path.join(os.homedir(), ".browser-control-mcp", "sock");
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/socket-path.ts
git commit -m "$(cat <<'EOF'
Add cross-platform socket path resolver for daemon IPC

Returns ~/.browser-control-mcp/sock on POSIX, \\.\pipe\browser-control-mcp
on Windows, or the BROWSER_CONTROL_SOCKET env var if set (used in tests).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Request router (TDD)

**Files:**
- Create: `mcp-server/request-router.ts`
- Test: `mcp-server/request-router.test.ts`

- [ ] **Step 1: Update test script in `mcp-server/package.json`**

The existing `test` script only runs `logger.test.ts`. Replace with a glob:

```json
"test": "tsc --noEmit && node --test --import tsx '*.test.ts'"
```

- [ ] **Step 2: Write failing test at `mcp-server/request-router.test.ts`**

```typescript
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { RequestRouter } from "./request-router";

test("register + resolve round-trip", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const fakeClient = { id: "c1" };
  const daemonCid = router.register(fakeClient as any, "client-cid-1");
  assert.equal(typeof daemonCid, "string");
  const entry = router.take(daemonCid);
  assert.ok(entry);
  assert.equal(entry!.client, fakeClient);
  assert.equal(entry!.clientCorrelationId, "client-cid-1");
});

test("take() consumes (second take returns undefined)", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const id = router.register({} as any, "cid");
  router.take(id);
  assert.equal(router.take(id), undefined);
});

test("timeout removes entry and invokes onTimeout", () => {
  return new Promise<void>((resolve) => {
    const router = new RequestRouter({ timeoutMs: 30 });
    const timedOut: string[] = [];
    const id = router.register({} as any, "cid-timeout", (daemonCid) => {
      timedOut.push(daemonCid);
    });
    setTimeout(() => {
      assert.equal(router.take(id), undefined);
      assert.deepEqual(timedOut, [id]);
      resolve();
    }, 80);
  });
});

test("forEachForClient + dropClient", () => {
  const router = new RequestRouter({ timeoutMs: 1000 });
  const a = { id: "a" };
  const b = { id: "b" };
  router.register(a as any, "a1");
  router.register(a as any, "a2");
  router.register(b as any, "b1");

  const aIds: string[] = [];
  router.forEachForClient(a as any, (daemonCid, clientCid) => {
    aIds.push(clientCid);
  });
  assert.deepEqual(aIds.sort(), ["a1", "a2"]);

  router.dropClient(a as any);
  const remaining: string[] = [];
  router.forEachForClient(a as any, (_d, c) => remaining.push(c));
  assert.deepEqual(remaining, []);
  router.forEachForClient(b as any, (_d, c) => remaining.push(c));
  assert.deepEqual(remaining, ["b1"]);
});
```

- [ ] **Step 3: Run tests, verify they fail**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm test
```

Expected: FAIL with `Cannot find module './request-router'`.

- [ ] **Step 4: Implement `mcp-server/request-router.ts`**

```typescript
import * as crypto from "node:crypto";

export interface RouterClient {
  // Marker type — the actual client is whatever the daemon passes in
  // (typically a net.Socket). Router is intentionally not coupled to that.
}

interface Entry {
  client: RouterClient;
  clientCorrelationId: string;
  timer: NodeJS.Timeout;
}

export interface RequestRouterOptions {
  timeoutMs: number;
}

export class RequestRouter {
  private entries = new Map<string, Entry>();

  constructor(private readonly options: RequestRouterOptions) {}

  register(
    client: RouterClient,
    clientCorrelationId: string,
    onTimeout?: (daemonCorrelationId: string) => void
  ): string {
    const daemonCorrelationId = crypto.randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      if (this.entries.delete(daemonCorrelationId) && onTimeout) {
        onTimeout(daemonCorrelationId);
      }
    }, this.options.timeoutMs);
    // Don't keep the event loop alive just for pending request timers.
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(daemonCorrelationId, {
      client,
      clientCorrelationId,
      timer,
    });
    return daemonCorrelationId;
  }

  take(daemonCorrelationId: string): { client: RouterClient; clientCorrelationId: string } | undefined {
    const entry = this.entries.get(daemonCorrelationId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(daemonCorrelationId);
    return { client: entry.client, clientCorrelationId: entry.clientCorrelationId };
  }

  forEachForClient(
    client: RouterClient,
    fn: (daemonCorrelationId: string, clientCorrelationId: string) => void
  ): void {
    for (const [daemonCid, entry] of this.entries) {
      if (entry.client === client) fn(daemonCid, entry.clientCorrelationId);
    }
  }

  dropClient(client: RouterClient): void {
    for (const [daemonCid, entry] of this.entries) {
      if (entry.client === client) {
        clearTimeout(entry.timer);
        this.entries.delete(daemonCid);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm test
```

Expected: 4 new tests pass, plus the 4 existing logger tests = 8/8 pass total.

- [ ] **Step 6: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/request-router.ts mcp-server/request-router.test.ts mcp-server/package.json
git commit -m "$(cat <<'EOF'
Add request router for daemon multiplexing

RequestRouter maps daemon-side correlation IDs back to the originating
client socket + client correlation ID, so the daemon can fan responses
from the single Firefox WebSocket back to the right mcp-server. Each
pending request has a timer that auto-evicts on timeout and invokes
an onTimeout callback so the daemon can send a synthesized
response-frame to the waiting client.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: WebSocket bridge (extract from browser-api.ts)

**Files:**
- Create: `mcp-server/ws-bridge.ts`

- [ ] **Step 1: Implement `ws-bridge.ts`**

This lifts the WebSocket-server / signature / extension-error-handling logic out of the current `browser-api.ts`. Crucially, it does NOT know about MCP, daemonCids, or client sockets — it just sends `ServerMessageRequest` frames and emits incoming `ExtensionMessage` / `ExtensionError` to whoever subscribed. The daemon wires those callbacks to the request router.

```typescript
import WebSocket from "ws";
import * as crypto from "node:crypto";
import type {
  ServerMessage,
  ServerMessageRequest,
  ExtensionMessage,
  ExtensionError,
} from "@browser-control-mcp/common";
import { log } from "./logger";

const WS_DEFAULT_PORT = 8089;
const MAX_BIND_ATTEMPTS = 5;
const BIND_BACKOFFS_MS = [1000, 2000, 4000, 8000, 16000];

export interface WsBridgeEvents {
  onExtensionMessage: (msg: ExtensionMessage) => void;
  onExtensionError: (err: ExtensionError) => void;
  onConnection: (port: number) => void;
  onDisconnect: () => void;
  onWsError: (err: unknown) => void;
}

export class WsBridge {
  private wsServer: WebSocket.Server | null = null;
  private ws: WebSocket | null = null;
  private events: WsBridgeEvents;
  private port: number;

  constructor(
    private readonly sharedSecret: string,
    port: number,
    events: WsBridgeEvents
  ) {
    this.port = port;
    this.events = events;
  }

  async start(): Promise<void> {
    const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";

    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      try {
        await this.bind(host, this.port);
        log.info("ws-bridge listening", { host, port: this.port });
        return;
      } catch (err) {
        this.events.onWsError(err);
        const isTransient = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
        const isLast = attempt === MAX_BIND_ATTEMPTS - 1;
        if (!isTransient || isLast) {
          log.error("ws-bridge bind failed permanently", {
            attempt: attempt + 1,
            err: String(err),
          });
          throw err;
        }
        const backoff = BIND_BACKOFFS_MS[Math.min(attempt, BIND_BACKOFFS_MS.length - 1)];
        log.warn("ws-bridge bind failed, retrying", {
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private bind(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocket.Server({ host, port });
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.wsServer = server;
        this.attachServerHandlers(server, port);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });
  }

  private attachServerHandlers(server: WebSocket.Server, port: number) {
    server.on("connection", (connection) => {
      this.ws = connection;
      this.events.onConnection(port);

      connection.on("close", () => {
        if (this.ws === connection) this.ws = null;
        this.events.onDisconnect();
      });
      connection.on("error", (err) => this.events.onWsError(err));

      connection.on("message", (message) => {
        try {
          const decoded = JSON.parse(message.toString());
          if (isErrorMessage(decoded)) {
            this.events.onExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            log.warn("invalid message signature from extension");
            return;
          }
          this.events.onExtensionMessage(decoded.payload);
        } catch (err) {
          this.events.onWsError(err);
        }
      });
    });
    server.on("error", (err) => this.events.onWsError(err));
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(message: ServerMessage, correlationId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    this.ws.send(JSON.stringify({ payload: req, signature }));
  }

  private createSignature(payload: string): string {
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  close() {
    this.wsServer?.close();
  }
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message != null &&
    message.errorMessage !== undefined &&
    message.correlationId !== undefined
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npx tsc --noEmit
```

Expected: no errors. (Nothing imports it yet, but it must compile.)

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/ws-bridge.ts
git commit -m "$(cat <<'EOF'
Extract WsBridge from browser-api.ts

WsBridge owns the Firefox WebSocket — bind with retry on EADDRINUSE,
signature verification, message parsing in try/catch — and exposes a
plain send(message, correlationId) plus a callback bag for incoming
events. Doesn't know about MCP, mcp-server clients, or daemon
correlation IDs; that's the daemon's job to wire up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: IPC server (daemon side) with handshake test

**Files:**
- Create: `mcp-server/ipc-server.ts`
- Test: `mcp-server/ipc-protocol.test.ts`

- [ ] **Step 1: Implement `ipc-server.ts`**

```typescript
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type IpcClientToDaemon,
  type HelloAckFrame,
  type ErrorFrame,
  type ResponseFrame,
  type StatusResponseFrame,
  type RequestFrame,
  type HelloFrame,
  type StatusRequestFrame,
  type DaemonStatus,
  PROTOCOL_VERSION,
  verifyHelloAuth,
} from "@browser-control-mcp/common";
import { log } from "./logger";

export interface IpcServerEvents {
  onRequest: (client: net.Socket, frame: RequestFrame) => void;
  onClientDisconnect: (client: net.Socket) => void;
  getStatus: () => DaemonStatus;
}

export class IpcServer {
  private server: net.Server | null = null;
  private authedClients = new WeakSet<net.Socket>();

  constructor(
    private readonly sharedSecret: string,
    private readonly daemonVersion: string,
    private readonly events: IpcServerEvents
  ) {}

  async start(socketPath: string): Promise<void> {
    await this.cleanupStaleSocket(socketPath);
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleClient(socket));
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        this.server = server;
        // POSIX only: tighten socket file permissions to user-only.
        if (process.platform !== "win32") {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch (err) {
            log.warn("failed to chmod ipc socket", { err: String(err) });
          }
        }
        log.info("ipc-server listening", { socketPath });
        resolve();
      });
    });
  }

  private async cleanupStaleSocket(socketPath: string): Promise<void> {
    if (process.platform === "win32") return;
    if (!fs.existsSync(socketPath)) return;

    // Probe: if something is listening, abort startup (another daemon already
    // owns this socket). If nothing is listening, the file is stale — unlink it.
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.end();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (alive) {
      throw new Error(`another daemon is already listening on ${socketPath}`);
    }
    try {
      fs.unlinkSync(socketPath);
      log.info("removed stale ipc socket file", { socketPath });
    } catch (err) {
      log.warn("could not remove stale socket file", { err: String(err) });
    }
  }

  private handleClient(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      this.events.onClientDisconnect(socket);
    });
    socket.on("error", (err) => {
      log.warn("ipc client socket error", { err: String(err) });
    });
  }

  private handleLine(socket: net.Socket, line: string): void {
    let frame: IpcClientToDaemon;
    try {
      frame = JSON.parse(line) as IpcClientToDaemon;
    } catch (err) {
      this.sendError(socket, `invalid JSON: ${String(err)}`, true);
      socket.end();
      return;
    }

    if (frame.type === "hello") {
      this.handleHello(socket, frame);
      return;
    }
    if (!this.authedClients.has(socket)) {
      this.sendError(socket, "client must send hello before any other frame", true);
      socket.end();
      return;
    }
    if (frame.type === "request") {
      this.events.onRequest(socket, frame);
      return;
    }
    if (frame.type === "status") {
      this.sendStatus(socket);
      return;
    }
    this.sendError(socket, `unknown frame type: ${(frame as any).type}`);
  }

  private handleHello(socket: net.Socket, frame: HelloFrame): void {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(
        socket,
        `protocol version mismatch: client=${frame.protocolVersion} daemon=${PROTOCOL_VERSION}`,
        true
      );
      socket.end();
      return;
    }
    let ok = false;
    try {
      ok = verifyHelloAuth(this.sharedSecret, frame);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.sendError(socket, "hello auth failed", true);
      socket.end();
      return;
    }
    this.authedClients.add(socket);
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: process.pid,
      daemonVersion: this.daemonVersion,
    };
    this.writeFrame(socket, ack);
    log.info("ipc client authenticated", {
      clientPid: frame.clientPid,
      clientVersion: frame.clientVersion,
    });
  }

  private sendStatus(socket: net.Socket): void {
    const status: StatusResponseFrame = {
      type: "status-response",
      daemon: this.events.getStatus(),
    };
    this.writeFrame(socket, status);
  }

  sendResponse(socket: net.Socket, frame: ResponseFrame): void {
    this.writeFrame(socket, frame);
  }

  private sendError(socket: net.Socket, error: string, fatal = false): void {
    const frame: ErrorFrame = { type: "error", error };
    if (fatal) frame.fatal = true;
    this.writeFrame(socket, frame);
  }

  private writeFrame(socket: net.Socket, frame: object): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(JSON.stringify(frame) + "\n");
  }

  close(): void {
    this.server?.close();
  }
}
```

- [ ] **Step 2: Write the round-trip test at `mcp-server/ipc-protocol.test.ts`**

```typescript
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  PROTOCOL_VERSION,
  computeHelloAuth,
  type HelloFrame,
  type HelloAckFrame,
  type ErrorFrame,
  type RequestFrame,
  type ResponseFrame,
  type StatusResponseFrame,
} from "@browser-control-mcp/common";
import { IpcServer } from "./ipc-server";

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-ipc-"));
  return path.join(dir, "sock");
}

function makeHello(secret: string): HelloFrame {
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    clientPid: process.pid,
    clientVersion: "1.7.0-test",
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return { type: "hello", ...payload, auth: computeHelloAuth(secret, payload) };
}

function readFrames(socket: net.Socket): { next: () => Promise<any> } {
  let buf = "";
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(parsed);
      else queue.push(parsed);
    }
  });
  return {
    next: () =>
      new Promise((resolve) => {
        if (queue.length) resolve(queue.shift());
        else waiters.push(resolve);
      }),
  };
}

test("hello-ack round-trip succeeds with valid HMAC", async () => {
  const secret = "test-secret";
  const sp = tmpSocketPath();
  const server = new IpcServer(secret, "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  client.write(JSON.stringify(makeHello(secret)) + "\n");
  const ack = (await reader.next()) as HelloAckFrame;
  assert.equal(ack.type, "hello-ack");
  assert.equal(ack.protocolVersion, PROTOCOL_VERSION);
  assert.equal(ack.daemonVersion, "1.7.0-daemon");

  client.end();
  server.close();
});

test("bad HMAC is rejected with fatal error and socket closes", async () => {
  const sp = tmpSocketPath();
  const server = new IpcServer("real-secret", "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  // Sign with the wrong secret.
  client.write(JSON.stringify(makeHello("wrong-secret")) + "\n");
  const err = (await reader.next()) as ErrorFrame;
  assert.equal(err.type, "error");
  assert.equal(err.fatal, true);
  assert.match(err.error, /auth/i);

  await new Promise((r) => client.once("close", r));
  server.close();
});

test("request before hello is rejected", async () => {
  const sp = tmpSocketPath();
  const server = new IpcServer("s", "1.7.0-daemon", {
    onRequest: () => {},
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  const req: RequestFrame = {
    type: "request",
    clientCorrelationId: "x",
    message: { cmd: "get-tab-list" },
  };
  client.write(JSON.stringify(req) + "\n");
  const err = (await reader.next()) as ErrorFrame;
  assert.equal(err.type, "error");
  assert.equal(err.fatal, true);

  server.close();
});

test("request after hello is forwarded; response written back", async () => {
  const sp = tmpSocketPath();
  const secret = "s";
  let captured: { client: net.Socket; frame: RequestFrame } | null = null;
  const server = new IpcServer(secret, "1.7.0-daemon", {
    onRequest: (c, f) => {
      captured = { client: c, frame: f };
    },
    onClientDisconnect: () => {},
    getStatus: () => ({} as any),
  });
  await server.start(sp);

  const client = net.createConnection(sp);
  await new Promise((r) => client.once("connect", r));
  const reader = readFrames(client);
  client.write(JSON.stringify(makeHello(secret)) + "\n");
  await reader.next(); // hello-ack

  const req: RequestFrame = {
    type: "request",
    clientCorrelationId: "abc",
    message: { cmd: "get-tab-list" },
  };
  client.write(JSON.stringify(req) + "\n");

  // Wait for the daemon to receive the request.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(captured);
  assert.equal(captured!.frame.clientCorrelationId, "abc");

  const resp: ResponseFrame = {
    type: "response",
    clientCorrelationId: "abc",
    ok: true,
    payload: { resource: "tabs", correlationId: "ignored", tabs: [] } as any,
  };
  server.sendResponse(captured!.client, resp);
  const got = (await reader.next()) as ResponseFrame;
  assert.equal(got.type, "response");
  assert.equal(got.clientCorrelationId, "abc");
  assert.equal(got.ok, true);

  server.close();
});
```

- [ ] **Step 3: Run tests, verify they pass**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm test
```

Expected: 4 new IPC tests pass plus all existing tests (logger + request-router) = 12/12 total.

- [ ] **Step 4: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/ipc-server.ts mcp-server/ipc-protocol.test.ts
git commit -m "$(cat <<'EOF'
Add IPC server for daemon side of browser-control bridge

Accepts NDJSON connections from per-Claude mcp-server clients on
~/.browser-control-mcp/sock (named pipe on Windows). Enforces a hello
handshake authenticated via HMAC-SHA256 over a structured payload
using EXTENSION_SECRET, with timing-safe comparison and protocol
version check. Probes stale POSIX socket files via a connect attempt
before binding. Forwards authed request frames to the daemon via a
callback bag and exposes sendResponse() for the daemon to fan replies
back.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Daemon bootstrap

**Files:**
- Create: `mcp-server/daemon.ts`

- [ ] **Step 1: Implement `daemon.ts`**

```typescript
import * as net from "node:net";
import { WsBridge } from "./ws-bridge";
import { IpcServer } from "./ipc-server";
import { RequestRouter } from "./request-router";
import { log } from "./logger";
import { resolveSocketPath } from "./socket-path";
import type {
  ExtensionMessage,
  ExtensionError,
  RequestFrame,
  ResponseFrame,
  DaemonStatus,
} from "@browser-control-mcp/common";

const DAEMON_VERSION = "1.7.0";
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function responseTimeoutMs(): number {
  const v = process.env.EXTENSION_RESPONSE_TIMEOUT_MS;
  if (!v) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_TIMEOUT_MS;
}

interface DaemonState {
  startedAt: string;
  wsConnected: boolean;
  wsPort: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function main() {
  const secret = process.env.EXTENSION_SECRET;
  if (!secret) {
    log.error("daemon refusing to start: EXTENSION_SECRET missing");
    process.exit(1);
  }
  const wsPort = process.env.EXTENSION_PORT
    ? parseInt(process.env.EXTENSION_PORT, 10)
    : 8089;

  const state: DaemonState = {
    startedAt: new Date().toISOString(),
    wsConnected: false,
    wsPort,
    lastConnectionAt: null,
    lastDisconnectAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };

  const recordError = (err: unknown) => {
    const msg = errMessage(err);
    state.lastErrorAt = new Date().toISOString();
    state.lastErrorMessage = msg;
    log.error(msg, err instanceof Error && err.stack ? { stack: err.stack } : undefined);
  };

  process.on("uncaughtException", recordError);
  process.on("unhandledRejection", recordError);

  log.info("daemon starting", { pid: process.pid, daemonVersion: DAEMON_VERSION });

  const router = new RequestRouter({ timeoutMs: responseTimeoutMs() });

  // Forward declaration so wsBridge.events can call sendResponse before
  // ipcServer is constructed.
  let ipcServer: IpcServer;

  const wsBridge = new WsBridge(secret, wsPort, {
    onExtensionMessage: (msg: ExtensionMessage) => {
      const entry = router.take(msg.correlationId);
      if (!entry) {
        log.warn("extension reply with unknown correlationId", {
          correlationId: msg.correlationId,
        });
        return;
      }
      const resp: ResponseFrame = {
        type: "response",
        clientCorrelationId: entry.clientCorrelationId,
        ok: true,
        payload: msg,
      };
      ipcServer.sendResponse(entry.client as net.Socket, resp);
    },
    onExtensionError: (err: ExtensionError) => {
      const entry = router.take(err.correlationId);
      if (!entry) {
        log.warn("extension error with unknown correlationId", {
          correlationId: err.correlationId,
        });
        return;
      }
      const resp: ResponseFrame = {
        type: "response",
        clientCorrelationId: entry.clientCorrelationId,
        ok: false,
        error: err.errorMessage,
      };
      ipcServer.sendResponse(entry.client as net.Socket, resp);
    },
    onConnection: (port: number) => {
      state.wsConnected = true;
      state.wsPort = port;
      state.lastConnectionAt = new Date().toISOString();
      log.info("firefox extension connected", { port });
    },
    onDisconnect: () => {
      state.wsConnected = false;
      state.lastDisconnectAt = new Date().toISOString();
      log.info("firefox extension disconnected");
    },
    onWsError: recordError,
  });

  const getStatus = (): DaemonStatus => ({
    startedAt: state.startedAt,
    pid: process.pid,
    wsConnected: state.wsConnected,
    wsPort: state.wsPort,
    lastConnectionAt: state.lastConnectionAt,
    lastDisconnectAt: state.lastDisconnectAt,
    lastErrorAt: state.lastErrorAt,
    lastErrorMessage: state.lastErrorMessage,
    logFilePath: log.filePath(),
    daemonVersion: DAEMON_VERSION,
  });

  ipcServer = new IpcServer(secret, DAEMON_VERSION, {
    onRequest: (client: net.Socket, frame: RequestFrame) => {
      const daemonCid = router.register(
        client,
        frame.clientCorrelationId,
        (cid) => {
          // Timeout — synthesize a failure response so the waiting client
          // doesn't hang. The cid is the daemonCid, but we still know the
          // clientCid because the router stored it.
          // Note: router.take(cid) already returned undefined because the
          // entry was evicted by the timeout, so we have to construct the
          // response from the frame we still have in this closure.
          const timeoutResp: ResponseFrame = {
            type: "response",
            clientCorrelationId: frame.clientCorrelationId,
            ok: false,
            error: "Timed out waiting for response",
          };
          ipcServer.sendResponse(client, timeoutResp);
        }
      );
      try {
        wsBridge.send(frame.message, daemonCid);
      } catch (err) {
        // WebSocket not open or some other immediate failure — send error
        // back and unregister.
        router.take(daemonCid);
        const resp: ResponseFrame = {
          type: "response",
          clientCorrelationId: frame.clientCorrelationId,
          ok: false,
          error: errMessage(err),
        };
        ipcServer.sendResponse(client, resp);
      }
    },
    onClientDisconnect: (client: net.Socket) => {
      router.dropClient(client);
    },
    getStatus,
  });

  const socketPath = resolveSocketPath();
  try {
    await ipcServer.start(socketPath);
  } catch (err) {
    recordError(err);
    log.error("daemon failed to start ipc server, exiting", { err: String(err) });
    process.exit(1);
  }

  try {
    await wsBridge.start();
  } catch (err) {
    recordError(err);
    log.error("daemon failed to start ws bridge, exiting", { err: String(err) });
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    log.info("daemon shutting down", { signal });
    wsBridge.close();
    ipcServer.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
```

- [ ] **Step 2: Smoke-build**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm run build
```

Expected: `dist/daemon.js` is produced; no errors.

- [ ] **Step 3: Live smoke check (foreground daemon)**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
rm -f ~/.browser-control-mcp/sock
BROWSER_CONTROL_SOCKET=/tmp/bcm-daemon-test.sock \
  EXTENSION_SECRET=smoke-secret \
  EXTENSION_PORT=18089 \
  LOG_FILE=/tmp/bcm-daemon-test.log \
  timeout 3 node dist/daemon.js
echo "exit=$?"
echo "--- log ---"
cat /tmp/bcm-daemon-test.log
```

Expected: process runs for ~3s then is killed by `timeout` (exit 124 — that's fine). The log contains JSONL entries for `daemon starting`, `ipc-server listening`, `ws-bridge listening`. No `level: error` entries.

- [ ] **Step 4: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/daemon.ts
git commit -m "$(cat <<'EOF'
Add daemon bootstrap wiring IpcServer + WsBridge + RequestRouter

Daemon owns port 8089 and the Firefox WebSocket; accepts NDJSON
clients over the IPC socket. Incoming request frames are registered
in the router (mapping daemonCid -> {clientSocket, clientCorrelationId})
and forwarded over the WebSocket. Extension replies (and errors) are
looked up by daemonCid and fanned back to the originating client as
response frames. Per-request timeout synthesizes a failure response
so blocked clients don't hang. SIGTERM/SIGINT trigger a clean
shutdown; uncaught exceptions and rejections are logged and the
daemon keeps running.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Daemon client (mcp-server side)

**Files:**
- Create: `mcp-server/daemon-client.ts`
- Test: `mcp-server/daemon-client.test.ts`

- [ ] **Step 1: Write the failing test at `mcp-server/daemon-client.test.ts`**

```typescript
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  type HelloFrame,
  type HelloAckFrame,
  type RequestFrame,
  type ResponseFrame,
  PROTOCOL_VERSION,
} from "@browser-control-mcp/common";
import { DaemonClient } from "./daemon-client";

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-dc-"));
  return path.join(dir, "sock");
}

interface StubDaemon {
  socketPath: string;
  server: net.Server;
  onHello: (sock: net.Socket, frame: HelloFrame) => void;
  onRequest: (sock: net.Socket, frame: RequestFrame) => void;
  close: () => Promise<void>;
}

function startStubDaemon(socketPath: string): StubDaemon {
  const stub: any = { socketPath };
  stub.server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === "hello") stub.onHello?.(sock, parsed);
        else if (parsed.type === "request") stub.onRequest?.(sock, parsed);
      }
    });
  });
  stub.close = () =>
    new Promise<void>((resolve) => {
      stub.server.close(() => resolve());
    });
  return new Promise<StubDaemon>((resolve) => {
    stub.server.listen(socketPath, () => resolve(stub));
  }) as any;
}

test("connect + hello-ack + request/response round-trip", async () => {
  const sp = tmpSocketPath();
  const stub = await startStubDaemon(sp);
  stub.onHello = (sock) => {
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: 99999,
      daemonVersion: "1.7.0-stub",
    };
    sock.write(JSON.stringify(ack) + "\n");
  };
  stub.onRequest = (sock, frame) => {
    const resp: ResponseFrame = {
      type: "response",
      clientCorrelationId: frame.clientCorrelationId,
      ok: true,
      payload: {
        resource: "tabs",
        correlationId: "ignored",
        tabs: [{ id: 1, url: "https://example.com", title: "Example" } as any],
      } as any,
    };
    sock.write(JSON.stringify(resp) + "\n");
  };

  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 1000,
    spawnDaemon: async () => {
      throw new Error("should not need to spawn — stub is running");
    },
  });
  await client.connect();
  const reply = await client.request({ cmd: "get-tab-list" });
  assert.equal(reply.resource, "tabs");
  await client.close();
  await stub.close();
});

test("request rejects on timeout if daemon never responds", async () => {
  const sp = tmpSocketPath();
  const stub = await startStubDaemon(sp);
  stub.onHello = (sock) => {
    const ack: HelloAckFrame = {
      type: "hello-ack",
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: 1,
      daemonVersion: "1.7.0-stub",
    };
    sock.write(JSON.stringify(ack) + "\n");
  };
  // No onRequest handler — request will time out.

  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 80,
    spawnDaemon: async () => {
      throw new Error("not needed");
    },
  });
  await client.connect();
  await assert.rejects(
    client.request({ cmd: "get-tab-list" }),
    /timed out|timeout/i
  );
  await client.close();
  await stub.close();
});

test("connect() invokes spawnDaemon when socket does not exist", async () => {
  const sp = path.join(os.tmpdir(), `bcm-spawn-${Date.now()}.sock`);
  let spawned = 0;
  const client = new DaemonClient({
    socketPath: sp,
    secret: "any",
    clientVersion: "1.7.0-test",
    requestTimeoutMs: 1000,
    spawnDaemon: async () => {
      spawned++;
      const stub = await startStubDaemon(sp);
      stub.onHello = (sock) => {
        const ack: HelloAckFrame = {
          type: "hello-ack",
          protocolVersion: PROTOCOL_VERSION,
          daemonPid: 2,
          daemonVersion: "1.7.0-stub",
        };
        sock.write(JSON.stringify(ack) + "\n");
      };
      // Cleanup stub when client closes; the test owns it via the closure.
      (client as any)._testStub = stub;
    },
  });
  await client.connect();
  assert.equal(spawned, 1);
  await client.close();
  await (client as any)._testStub.close();
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm test
```

Expected: FAIL with `Cannot find module './daemon-client'`.

- [ ] **Step 3: Implement `daemon-client.ts`**

```typescript
import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  PROTOCOL_VERSION,
  computeHelloAuth,
  type HelloFrame,
  type IpcDaemonToClient,
  type RequestFrame,
  type ResponseFrame,
  type StatusResponseFrame,
  type ServerMessage,
  type ExtensionMessage,
} from "@browser-control-mcp/common";
import { log } from "./logger";

export interface DaemonClientOptions {
  socketPath: string;
  secret: string;
  clientVersion: string;
  requestTimeoutMs: number;
  /** Called when the socket does not yet exist. Must arrange for a daemon
   *  to be running (or in the process of becoming runnable) at `socketPath`
   *  before resolving. */
  spawnDaemon: () => Promise<void>;
  /** Reconnect backoffs in milliseconds; defaults match resilience spec. */
  reconnectBackoffsMs?: number[];
}

interface Pending {
  resolve: (value: ExtensionMessage) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_RECONNECT_BACKOFFS = [50, 100, 200, 500, 1000, 2000];

export class DaemonClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly opts: DaemonClientOptions) {}

  async connect(): Promise<void> {
    const backoffs = this.opts.reconnectBackoffsMs ?? DEFAULT_RECONNECT_BACKOFFS;
    let spawned = false;
    for (let i = 0; i <= backoffs.length; i++) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if ((code === "ENOENT" || code === "ECONNREFUSED") && !spawned) {
          log.info("daemon socket unavailable, spawning daemon", {
            socketPath: this.opts.socketPath,
          });
          await this.opts.spawnDaemon();
          spawned = true;
        }
        if (i === backoffs.length) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, backoffs[i]));
      }
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.opts.socketPath);
      const onError = (err: Error) => {
        sock.removeListener("connect", onConnect);
        reject(err);
      };
      const onConnect = () => {
        sock.removeListener("error", onError);
        this.attachHandlers(sock);
        this.sendHello(sock)
          .then(resolve)
          .catch((helloErr) => {
            sock.destroy();
            reject(helloErr);
          });
      };
      sock.once("error", onError);
      sock.once("connect", onConnect);
    });
  }

  private attachHandlers(sock: net.Socket) {
    this.socket = sock;
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("close", () => this.onSocketClose());
    sock.on("error", (err) => log.warn("daemon socket error", { err: String(err) }));
  }

  private sendHello(sock: net.Socket): Promise<void> {
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      clientPid: process.pid,
      clientVersion: this.opts.clientVersion,
      nonce: crypto.randomBytes(16).toString("hex"),
    };
    const hello: HelloFrame = {
      type: "hello",
      ...payload,
      auth: computeHelloAuth(this.opts.secret, payload),
    };
    sock.write(JSON.stringify(hello) + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.removeListener("data", listener);
        reject(new Error("timed out awaiting hello-ack"));
      }, 2000);
      const listener = (chunk: Buffer) => {
        // Peek at incoming data via the same buffer used by onData; we install
        // a one-shot listener that drains the first frame and hands the rest
        // to the normal handler. To keep state simple, we re-route everything
        // through onData and just watch the pending-hello promise.
        sock.removeListener("data", listener);
        clearTimeout(timer);
        // Push the chunk back through the regular handler.
        this.onData(chunk);
        // We resolve optimistically; if it was actually an error frame, the
        // socket will be closed by the daemon and pending calls will reject.
        resolve();
      };
      sock.once("data", listener);
    });
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let frame: IpcDaemonToClient;
      try {
        frame = JSON.parse(line) as IpcDaemonToClient;
      } catch (err) {
        log.warn("daemon sent invalid JSON", { err: String(err) });
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: IpcDaemonToClient) {
    if (frame.type === "response") {
      const pending = this.pending.get(frame.clientCorrelationId);
      if (!pending) {
        log.warn("daemon response with unknown clientCorrelationId", {
          id: frame.clientCorrelationId,
        });
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(frame.clientCorrelationId);
      if (frame.ok && frame.payload) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error || "daemon reported failure"));
      }
      return;
    }
    if (frame.type === "error") {
      log.error("daemon error frame", { error: frame.error, fatal: frame.fatal });
      if (frame.fatal) {
        // Reject everything; socket will close shortly.
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(frame.error));
          this.pending.delete(id);
        }
      }
      return;
    }
    // hello-ack and status-response: consumed by specific waiters, not here.
  }

  private onSocketClose() {
    this.socket = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("daemon connection lost"));
      this.pending.delete(id);
    }
    if (!this.closed) {
      log.info("daemon connection closed; attempting reconnect");
      this.connect().catch((err) => {
        log.error("daemon reconnect failed", { err: String(err) });
      });
    }
  }

  request(message: ServerMessage): Promise<ExtensionMessage> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("daemon connection not open"));
    }
    const clientCorrelationId = crypto.randomBytes(8).toString("hex");
    const frame: RequestFrame = {
      type: "request",
      clientCorrelationId,
      message,
    };
    return new Promise<ExtensionMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(clientCorrelationId)) {
          reject(new Error("timed out waiting for daemon response"));
        }
      }, this.opts.requestTimeoutMs);
      this.pending.set(clientCorrelationId, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(frame) + "\n");
    });
  }

  async status(): Promise<StatusResponseFrame["daemon"] | null> {
    if (!this.socket || this.socket.destroyed) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      const listener = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const nl = text.indexOf("\n");
        if (nl < 0) return; // wait for full line — keep simple
        const line = text.slice(0, nl);
        try {
          const parsed = JSON.parse(line) as IpcDaemonToClient;
          if (parsed.type === "status-response") {
            this.socket!.removeListener("data", listener);
            clearTimeout(timer);
            resolve(parsed.daemon);
            return;
          }
        } catch {
          // ignore
        }
      };
      this.socket!.on("data", listener);
      this.socket!.write(JSON.stringify({ type: "status" }) + "\n");
    });
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.socket) this.socket.end();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closing"));
      this.pending.delete(id);
    }
  }
}
```

Important note about the hello-ack handling: the implementation above uses an optimistic resolve — once any frame arrives, we assume the hello succeeded and let normal handling take over. If the daemon actually rejected the hello it will write a fatal error frame and close the socket, which causes pending calls to reject. This keeps the hello path simple without a second buffer.

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm test
```

Expected: 3 new daemon-client tests pass; total 15/15.

- [ ] **Step 5: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/daemon-client.ts mcp-server/daemon-client.test.ts
git commit -m "$(cat <<'EOF'
Add DaemonClient — mcp-server's IPC end of the bridge

DaemonClient opens the local socket to the daemon, performs the hello
handshake, sends ServerMessage requests as NDJSON frames, and resolves
each Promise when the matching response arrives. On ENOENT/ECONNREFUSED
at connect time it invokes a caller-supplied spawnDaemon hook before
retrying with exponential backoff, so the first Claude to start brings
the daemon up and subsequent ones just connect. Per-request timeout
plus auto-reconnect on socket drop keep failures bounded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Refactor `browser-api.ts` to delegate to DaemonClient

**Files:**
- Modify: `mcp-server/browser-api.ts`

- [ ] **Step 1: Replace `browser-api.ts` with the thin delegate**

```typescript
import * as child_process from "node:child_process";
import * as path from "node:path";
import type {
  BrowserTab,
  BrowserHistoryItem,
  TabContentExtensionMessage,
  StatusResponseFrame,
} from "@browser-control-mcp/common";
import { log } from "./logger";
import { resolveSocketPath } from "./socket-path";
import { DaemonClient } from "./daemon-client";

const CLIENT_VERSION = "1.7.0";
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;

function responseTimeoutMs(): number {
  const v = process.env.EXTENSION_RESPONSE_TIMEOUT_MS;
  if (!v) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_TIMEOUT_MS;
}

export class BrowserAPI {
  private client: DaemonClient | null = null;

  async init(): Promise<void> {
    const secret = process.env.EXTENSION_SECRET;
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    const socketPath = resolveSocketPath();
    this.client = new DaemonClient({
      socketPath,
      secret,
      clientVersion: CLIENT_VERSION,
      requestTimeoutMs: responseTimeoutMs(),
      spawnDaemon: async () => {
        const daemonScript = path.join(__dirname, "daemon.js");
        const child = child_process.spawn(
          process.execPath,
          [daemonScript],
          {
            detached: true,
            stdio: "ignore",
            env: process.env,
          }
        );
        child.unref();
        log.info("spawned daemon", { pid: child.pid });
        // Give the daemon a brief moment to listen on the socket before the
        // first reconnect attempt fires.
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    await this.client.connect();
  }

  close(): void {
    this.client?.close();
  }

  async status() {
    return this.client?.status() ?? null;
  }

  isDaemonReachable(): boolean {
    return this.client?.isConnected() ?? false;
  }

  async openTab(url: string): Promise<number | undefined> {
    const msg = await this.client!.request({ cmd: "open-tab", url });
    return (msg as { tabId?: number }).tabId;
  }

  async closeTabs(tabIds: number[]): Promise<void> {
    await this.client!.request({ cmd: "close-tabs", tabIds });
  }

  async getTabList(): Promise<BrowserTab[]> {
    const msg = await this.client!.request({ cmd: "get-tab-list" });
    return (msg as { tabs: BrowserTab[] }).tabs;
  }

  async getBrowserRecentHistory(searchQuery?: string): Promise<BrowserHistoryItem[]> {
    const msg = await this.client!.request({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    return (msg as { historyItems: BrowserHistoryItem[] }).historyItems;
  }

  async getTabContent(tabId: number, offset: number): Promise<TabContentExtensionMessage> {
    const msg = await this.client!.request({ cmd: "get-tab-content", tabId, offset });
    return msg as TabContentExtensionMessage;
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const msg = await this.client!.request({ cmd: "reorder-tabs", tabOrder });
    return (msg as { tabOrder: number[] }).tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const msg = await this.client!.request({ cmd: "find-highlight", tabId, queryPhrase });
    return (msg as { noOfResults: number }).noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const msg = await this.client!.request({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    return (msg as { groupId: number }).groupId;
  }
}
```

The casts `(msg as { tabId?: number })` etc. are a pragmatic compromise: the daemon-client returns the discriminated union `ExtensionMessage`, but each method here knows which variant to expect. A future cleanup could thread the resource type through the call to get precise inference, but that's out of scope.

- [ ] **Step 2: Build**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm run build
```

Expected: clean build. Existing tests still pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/browser-api.ts
git commit -m "$(cat <<'EOF'
Refactor browser-api to delegate every call to DaemonClient

BrowserAPI no longer binds a port or handles WebSocket plumbing. init()
constructs a DaemonClient pointing at the platform socket path; the
spawnDaemon hook runs node dist/daemon.js detached + unrefed so the
daemon survives this mcp-server's exit. Each tool method is now a
one-liner that awaits a request and casts the union ExtensionMessage
to the expected shape — same public surface as before, all the
multiplexing happens daemon-side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update `server.ts` status tool + `health.ts`

**Files:**
- Modify: `mcp-server/health.ts`
- Modify: `mcp-server/server.ts`

- [ ] **Step 1: Update `health.ts`**

The existing Health interface lives in `mcp-server/health.ts`. Replace its contents with:

```typescript
import { log } from "./logger";

export interface ClientHealth {
  startedAt: string;
  daemonReachable: boolean;
  daemonSocketPath: string;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
}

import { resolveSocketPath } from "./socket-path";

export const health: ClientHealth = {
  startedAt: new Date().toISOString(),
  daemonReachable: false,
  daemonSocketPath: resolveSocketPath(),
  lastErrorAt: null,
  lastErrorMessage: null,
  logFilePath: log.filePath(),
};

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function recordError(err: unknown): void {
  const msg = errMessage(err);
  health.lastErrorAt = new Date().toISOString();
  health.lastErrorMessage = msg;
  const stack = err instanceof Error ? err.stack : undefined;
  log.error(msg, stack ? { stack } : undefined);
}

export function recordDaemonReachable(reachable: boolean): void {
  health.daemonReachable = reachable;
}
```

The old `recordConnection`/`recordDisconnect`/`recordPort` functions are removed — those concerns are now daemon-side. The `Health` interface name becomes `ClientHealth` for clarity.

- [ ] **Step 2: Update `server.ts`**

Two changes: the import surface from `health.ts` shrinks, and the `browser-control-status` tool's handler is rewritten to query the daemon for its half of the status.

Replace these lines in `server.ts`:

```typescript
import { health, recordError } from "./health";
```

with:

```typescript
import { health, recordError, recordDaemonReachable } from "./health";
```

Then replace the entire `browser-control-status` tool registration block with:

```typescript
mcpServer.tool(
  "browser-control-status",
  "Get the health/status of the browser-control MCP server and its singleton daemon. Use this when other browser-control tools are failing, when you suspect the Firefox extension is disconnected, or when the user asks whether the browser integration is working. Returns the per-Claude client state plus the daemon's ws-connection state, port, last connection/disconnect/error timestamps, log file paths, and PID.",
  {},
  async () => {
    let daemon: object = { reachable: false };
    try {
      const fetched = await browserApi.status();
      if (fetched) {
        daemon = fetched;
        recordDaemonReachable(true);
      } else {
        recordDaemonReachable(false);
      }
    } catch (err) {
      recordError(err);
      recordDaemonReachable(false);
      daemon = { reachable: false, error: String(err) };
    }
    const combined = { client: health, daemon };
    return {
      content: [{ type: "text", text: JSON.stringify(combined, null, 2) }],
    };
  }
);
```

Finally, the version constant in `McpServer({ name, version })` and the startup `log.info` should both be bumped from `"1.6.0"` to `"1.7.0"`.

- [ ] **Step 3: Build**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm run build && npm test
```

Expected: clean build, all unit tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/health.ts mcp-server/server.ts
git commit -m "$(cat <<'EOF'
Update status tool + health module for daemon split

ClientHealth replaces the old Health record (per-Claude state only:
daemon reachability, last error, log path). The browser-control-status
tool now returns { client, daemon } where the daemon section is fetched
via the new IPC status frame; on daemon failures the daemon section
degrades to { reachable: false, error: ... } and the client section
still reports useful info.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Version bumps + manifest

**Files:**
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/manifest.json`

- [ ] **Step 1: Bump versions**

In `mcp-server/package.json` change `"version": "1.6.0"` to `"version": "1.7.0"`.

In `mcp-server/manifest.json` change the top-level `"version": "1.6.0"` to `"version": "1.7.0"`. No tool list changes (the new daemon is an implementation detail; `browser-control-status` is already listed).

- [ ] **Step 2: Verify build**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/package.json mcp-server/manifest.json
git commit -m "$(cat <<'EOF'
Bump mcp-server to 1.7.0 for the daemon split

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: End-to-end smoke

**Files:** none — verification.

The unit suite covers protocol-shape and router behavior but not the full daemon lifecycle. These manual checks exercise it end-to-end.

For all of these, kill any lingering daemons + smoke-test placeholders first:

```bash
pkill -f 'browser-control-mcp/mcp-server/dist/daemon.js' || true
pkill -f "listen(8089" || true
rm -f ~/.browser-control-mcp/sock
```

- [ ] **Smoke 1: Single client spawns daemon, gets a working request**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
rm -f /tmp/bcm-client.log /tmp/bcm-daemon.log
EXTENSION_SECRET=smoke \
  LOG_FILE=/tmp/bcm-client.log \
  node dist/server.js &
CLIENT=$!
sleep 1
# The daemon should have been spawned by the client; check.
pgrep -fl 'dist/daemon.js'
ls -la ~/.browser-control-mcp/sock
kill $CLIENT
wait 2>/dev/null
```

Expected: `pgrep` lists a daemon process. The socket exists with mode `srwx------`. `/tmp/bcm-client.log` shows `spawned daemon` and connection success.

- [ ] **Smoke 2: Two clients share one daemon**

With the daemon from Smoke 1 still running:

```bash
EXTENSION_SECRET=smoke LOG_FILE=/tmp/bcm-c2.log node dist/server.js &
C2=$!
EXTENSION_SECRET=smoke LOG_FILE=/tmp/bcm-c3.log node dist/server.js &
C3=$!
sleep 1
pgrep -fl 'dist/daemon.js' | wc -l   # should be exactly 1
kill $C2 $C3
```

Expected: exactly one daemon process serves both clients. Each client log shows successful hello-ack, no spawn attempts (the daemon already existed).

- [ ] **Smoke 3: Bad secret is rejected**

```bash
EXTENSION_SECRET=wrong LOG_FILE=/tmp/bcm-bad.log timeout 5 node dist/server.js
echo "exit=$?"
grep -i auth /tmp/bcm-bad.log
```

Expected: client exits non-zero. Log contains a fatal error frame about auth.

- [ ] **Smoke 4: Daemon survives client churn**

Note the daemon PID:
```bash
DAEMON=$(pgrep -f 'dist/daemon.js' | head -1)
```

Start and kill 5 clients in quick succession:
```bash
for i in 1 2 3 4 5; do
  EXTENSION_SECRET=smoke LOG_FILE=/tmp/bcm-churn-$i.log node dist/server.js &
  CHURN=$!
  sleep 0.3
  kill $CHURN
  wait 2>/dev/null
done
ps -p $DAEMON -o pid,stat,command
```

Expected: same daemon PID is still alive at the end.

- [ ] **Smoke 5: Daemon respawn after kill**

```bash
kill $DAEMON
sleep 1
ls ~/.browser-control-mcp/sock  # should not exist
EXTENSION_SECRET=smoke LOG_FILE=/tmp/bcm-respawn.log node dist/server.js &
sleep 1
pgrep -fl 'dist/daemon.js'
kill %1
```

Expected: a new daemon is spawned, with a different PID.

- [ ] **Smoke 6: Browser-side end-to-end (requires Firefox extension installed and configured)**

Re-pack the DXT (`npm run pack-dxt`), reinstall it in Claude Desktop, then in a chat ask:

> Use the browser-control-status tool.

Expected: returns JSON with `client.daemonReachable: true` and a `daemon` block containing `wsConnected` (true if Firefox is running with the extension, false otherwise), the daemon PID, and the daemon's log file path. Tail `~/.browser-control-mcp/logs/daemon.log` — recent JSONL entries should reflect each tool call.

---

## Self-Review

- **Spec coverage**: Architecture (Tasks 4–6, 7, 8); IPC transport + socket path (Tasks 1, 2); Protocol incl. hello/HMAC/ack (Task 1 + Task 5 + Task 7); Daemon lifecycle / spawn race / stale-socket cleanup (Task 5 cleanup + Task 6 + Task 8 spawn hook); WS bridge + retry (Task 4); Request multiplexing (Task 3 + Task 6); Status tool (Task 9); Logging — daemon vs client log paths via existing `LOG_FILE` env (Task 6 sets `log.info`, the launcher of the daemon is expected to pass `LOG_FILE=...daemon.log`); Auth + socket perms (Tasks 1, 5); Backwards compat / version bump (Task 10); Manual smoke (Task 11). All covered.

- **Daemon log path note**: the daemon currently inherits `LOG_FILE` from the spawning client. The spec calls for `~/.browser-control-mcp/logs/daemon.log` specifically. To achieve that, the `spawnDaemon` hook in `browser-api.ts` should override `LOG_FILE` for the child. Fixing inline:

  In Task 8's `spawnDaemon`, replace `env: process.env` with:

  ```ts
  env: { ...process.env, LOG_FILE: path.join(require("node:os").homedir(), ".browser-control-mcp", "logs", "daemon.log") },
  ```

  Adding `os` to the imports in `browser-api.ts`:

  ```ts
  import * as os from "node:os";
  ```

  and using `os.homedir()` rather than the `require()` form inline. This is a minor edit; treat it as part of Task 8.

- **Placeholder scan**: None — every step has the actual code or command.

- **Type consistency**: `DaemonStatus` (defined in Task 1) is referenced consistently in Tasks 5, 6, 7, 9. `RequestFrame`/`ResponseFrame`/`HelloFrame`/`HelloAckFrame`/`ErrorFrame`/`StatusResponseFrame` likewise. `DaemonClient.request(message: ServerMessage)` returns `ExtensionMessage`; consumers in Task 8 cast to specific variants. `RequestRouter.register` returns `string` (the daemonCid); used as such in Task 6.

- **Test coverage of new code**: `request-router` has direct unit tests (Task 3). `ipc-server` has 4 tests via in-process sockets (Task 5). `daemon-client` has 3 tests using a stub daemon (Task 7). `ws-bridge` is exercised by the manual smoke (Task 11) — automated test would require a stub WebSocket client and adds little since the WS handling is lifted verbatim from previously-shipped code. `daemon.ts` is exercised end-to-end by Smoke 1+2.
