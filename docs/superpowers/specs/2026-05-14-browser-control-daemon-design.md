# Browser-Control Daemon — Design

**Date:** 2026-05-14
**Status:** Draft
**Scope:** `mcp-server/`, new `daemon/` (or sibling component within mcp-server)
**Builds on:** `2026-05-13-mcp-server-resilience-design.md`

## Problem

The mcp-server binds port 8089 to host a WebSocket server for the Firefox extension. MCP servers are spawned per-client (one process per Claude instance, by stdio MCP design). The result: only one Claude window can use browser-control at a time — every other instance hits `EADDRINUSE` and (after the recent retry/log work) gives up gracefully but is functionally dead.

We want every Claude instance (Desktop windows, Claude Code sessions, etc.) to be able to drive the browser concurrently without manual coordination.

## Goals

1. **Multiple Claude instances share one Firefox connection.** Any number of `mcp-server` processes can run; tool calls from all of them route to the single Firefox extension.
2. **No new manual setup.** A user already running the extension + DXT install gets the multi-instance behavior automatically after upgrade.
3. **Same Firefox extension.** Zero protocol changes on the extension side. The shared secret and the existing WebSocket message shapes (`common/`) stay as-is.
4. **Diagnosable.** Daemon writes its own log file. The `browser-control-status` tool from the prior work reports whether the daemon is reachable, plus daemon-side state.

## Non-Goals

- Multiple Firefox profiles or multiple browsers connecting to the same daemon. (One extension, one connection.)
- Cross-machine usage — daemon is always local-only.
- Hot reload / zero-downtime daemon upgrade. A daemon version mismatch causes the new mcp-server to kill+respawn the daemon; in-flight requests on other clients get a clean error.
- Migration to a different MCP transport (still stdio per client).

## Architecture

Split the current single process into two:

```
┌──────────┐  stdio  ┌────────────┐  IPC   ┌─────────────────┐  ws   ┌──────────┐
│ Claude A │ ──────► │ mcp-server │ ─────► │                 │       │          │
└──────────┘         └────────────┘        │                 │       │          │
                                            │                 │       │          │
┌──────────┐  stdio  ┌────────────┐  IPC   │ browser-control │ ◄───► │ Firefox  │
│ Claude B │ ──────► │ mcp-server │ ─────► │ -daemon         │ :8089 │ extension│
└──────────┘         └────────────┘        │                 │       │          │
                                            │                 │       │          │
┌──────────┐  stdio  ┌────────────┐  IPC   │  (singleton)    │       │          │
│ Claude C │ ──────► │ mcp-server │ ─────► │                 │       │          │
└──────────┘         └────────────┘        └─────────────────┘       └──────────┘
```

- **`mcp-server`** stays a thin per-client stdio MCP server. It no longer touches port 8089. Instead it opens an IPC connection to the daemon and forwards each tool call as a request.
- **`browser-control-daemon`** is a new long-running singleton. It owns port 8089, holds the Firefox WebSocket, and multiplexes requests from N mcp-server clients to/from the extension.
- **Firefox extension** is unchanged. It still connects to `ws://localhost:8089` with HMAC-signed messages.

## Components

### 1. IPC transport: local socket via `net`

Node's `net.createServer({ path })` / `net.createConnection({ path })` abstracts Unix domain sockets on POSIX and named pipes on Windows. We use one API and let Node pick the right primitive.

**Socket path:**
- POSIX (macOS/Linux): `~/.browser-control-mcp/sock`
- Windows: `\\.\pipe\browser-control-mcp`
- Env override: `BROWSER_CONTROL_SOCKET=/some/path` (useful for tests and containers)

**Wire format:** newline-delimited JSON (NDJSON). One JSON object per line. Each frame is small and easy to debug with `cat`/`tee`.

**Permissions (POSIX):** daemon `chmod`s the socket to `0600` after binding so only the same UID can connect. Windows: ACL on the named pipe restricts to the current user.

### 2. Protocol

Three message types over the socket. Each side knows which direction each type travels.

**`hello`** (mcp-server → daemon, first message after connect):
```json
{
  "type": "hello",
  "protocolVersion": 1,
  "clientPid": 12345,
  "clientVersion": "1.7.0",
  "nonce": "<random hex, 16 bytes>",
  "auth": "<hmac-sha256(EXTENSION_SECRET, JSON.stringify({protocolVersion, clientPid, clientVersion, nonce}))>"
}
```

The HMAC covers the full structured payload (including the client-generated `nonce`) so the signature can't be replayed against tampered fields. Daemon recomputes the HMAC against its own `EXTENSION_SECRET`; mismatch → daemon sends an error frame and closes the connection. This guarantees all mcp-server clients agree on the same secret as the daemon (which is the secret the extension uses).

**`hello-ack`** (daemon → mcp-server, response to hello):
```json
{
  "type": "hello-ack",
  "protocolVersion": 1,
  "daemonPid": 30558,
  "daemonVersion": "1.7.0"
}
```

If the daemon's `protocolVersion` differs from the client's, the client logs fatal and exits 1 (config/version mismatch — user must reinstall or restart everything).

**`request`** (mcp-server → daemon, after handshake):
```json
{
  "type": "request",
  "clientCorrelationId": "abc123",
  "message": { "cmd": "get-tab-list" }
}
```

The `message` is the existing `ServerMessage` shape from `common/`. The daemon generates its own `daemonCorrelationId` for the extension, tracks `daemonCid → { clientSocket, clientCorrelationId }`, signs with the secret, and forwards to Firefox.

**`response`** (daemon → mcp-server):
```json
{
  "type": "response",
  "clientCorrelationId": "abc123",
  "ok": true,
  "payload": { "resource": "tabs", "tabs": [ ... ] }
}
```
or
```json
{
  "type": "response",
  "clientCorrelationId": "abc123",
  "ok": false,
  "error": "Timed out waiting for response"
}
```

On the failure path, the daemon's error is whatever the extension sent (forwarded as `ExtensionError`) or a daemon-generated error (timeout, lost WebSocket, etc.).

**`event`** (daemon → mcp-server, optional, used for status push — defer unless we need it):
```json
{ "type": "event", "kind": "ws-disconnected" }
```
Not in the v1 scope; mcp-server polls daemon health via a request instead. Listed here as an extension point.

### 3. Daemon lifecycle

**Startup:**
1. `mcp-server` boots and tries `net.createConnection(socketPath)`.
2. If it connects within 50 ms: send `hello`, await ack, ready.
3. If it fails (`ENOENT` on POSIX, equivalent on Windows): spawn the daemon as a detached child, then retry the connection with backoff (50 ms, 100 ms, 200 ms, 500 ms, 1s, 2s — total ~4 seconds) until it succeeds or gives up.

**Daemon spawn:**
```js
spawn(process.execPath, [daemonScriptPath], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env },  // daemon inherits EXTENSION_SECRET / EXTENSION_PORT / LOG_*
}).unref();
```

The detached daemon survives the spawning mcp-server exiting.

**Spawn race:** If two mcp-servers spawn daemons simultaneously, both daemons try to bind the same socket. The loser hits `EADDRINUSE` (POSIX) or `EACCES`/equivalent (Windows), logs, and exits. The losing mcp-server's retry-connect loop then finds the winning daemon and connects normally.

**Stale socket cleanup (POSIX):** A socket file left over from a crashed daemon causes `EADDRINUSE` when a fresh daemon tries to bind. Before binding, the daemon attempts `net.connect()` to the socket path itself; if connect succeeds, another daemon is alive, abort. If connect fails (`ECONNREFUSED` on a leftover file), the file is stale — unlink and bind. This pattern is standard for UDS daemons.

**Shutdown:**
- On `SIGTERM` / `SIGINT`: close Firefox WebSocket, close all client sockets, unlink socket file, exit 0.
- On `stdin` close: ignored (daemon is detached; it has no stdin).
- On uncaught exception / unhandled rejection: log via `recordError`, do **not** exit (same policy as the resilience work).
- Never auto-exits on idle — staying alive is cheap and avoids respawn churn when Claude windows open and close.

### 4. Daemon internals

The daemon is essentially the WebSocket+request-tracking half of the current `BrowserAPI` class, lifted out of the per-client process.

```
daemon/
  daemon.ts         — bootstrap: bind socket, attach handlers, start WS server
  ipc-server.ts     — accepts mcp-server clients, handles hello/request/response
  ws-bridge.ts      — owns the Firefox WebSocket (mostly verbatim from browser-api.ts)
  request-router.ts — Map<daemonCid, {client, clientCid}> with timeout cleanup
  daemon-logger.ts  — re-exports ./logger configured with LOG_FILE=daemon.log
```

The `ws-bridge` retains the existing retry-on-EADDRINUSE backoff for port 8089 (so daemon startup is resilient to a stray placeholder process) and the existing message-signature validation.

### 5. mcp-server changes

`browser-api.ts` is gutted. It no longer binds a port. New implementation:

```ts
class BrowserAPI {
  private client: DaemonClient;
  async init() { await this.client.connect(); }
  async openTab(url: string) {
    return this.client.request({ cmd: "open-tab", url }).then(r => r.tabId);
  }
  // ... one delegate per existing method
}
```

`DaemonClient`:
- `connect()`: attempts socket connect, spawns daemon on `ENOENT`, retries with backoff.
- `request(msg)`: assigns `clientCorrelationId`, sends NDJSON, returns a Promise resolved when the response frame arrives.
- Tracks pending requests in a `Map<clientCorrelationId, { resolve, reject, timer }>`.
- Reconnects automatically if the daemon socket drops (with the same exponential backoff used elsewhere).
- Timeout per request still applies (`EXTENSION_RESPONSE_TIMEOUT_MS`, default 5000ms); on timeout the daemon may still produce a response which is then dropped (logged as "stale response, no waiter").

### 6. Status tool

The `browser-control-status` MCP tool from the previous work expands. It now returns two sections:

```json
{
  "client": {
    "startedAt": "...",
    "daemonReachable": true,
    "daemonSocketPath": "/Users/wstuckey/.browser-control-mcp/sock",
    "lastErrorAt": null,
    "logFilePath": "..."
  },
  "daemon": {
    "startedAt": "...",
    "pid": 30558,
    "wsConnected": true,
    "wsPort": 8089,
    "lastConnectionAt": "...",
    "lastDisconnectAt": null,
    "lastErrorAt": null,
    "logFilePath": "..."
  }
}
```

The daemon section is fetched via a new IPC frame `{ type: "status" }` → `{ type: "status-response", daemon: { ... } }`. This stays out of the `ServerMessage` enum (which is for extension-bound commands only). If the daemon is unreachable, the `daemon` section is replaced with `{ "reachable": false, "lastErrorAt": "...", "lastErrorMessage": "..." }` from the client's perspective.

### 7. Logging

- mcp-server writes to `~/.browser-control-mcp/logs/server.log` (unchanged).
- Daemon writes to `~/.browser-control-mcp/logs/daemon.log`. Same rotation, same JSONL format, configurable via `DAEMON_LOG_FILE`.
- Each daemon log line includes a `pid` field so multiple instances of debugging stay disambiguated (only one daemon runs at a time, but logs persist across daemon restarts).

## Data Flow

Tool call from Claude:

```
1. Claude calls tool                    → mcp-server (stdio)
2. mcp-server.openTab(url)              → DaemonClient.request({cmd: "open-tab", url})
3. DaemonClient writes NDJSON           → daemon socket
4. Daemon receives, assigns daemonCid,  → Firefox WebSocket
   maps daemonCid → {client, clientCid},
   signs payload, sends
5. Firefox responds with daemonCid      → daemon
6. Daemon looks up client+clientCid,    → client socket (NDJSON response)
   unmaps, forwards
7. DaemonClient resolves the Promise    → mcp-server.openTab returns
8. mcp-server formats MCP response      → Claude
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| Daemon socket doesn't exist at boot | mcp-server spawns daemon, retries connect with backoff |
| Daemon spawn race (two mcp-servers boot together) | Loser daemon hits bind error and exits; both mcp-servers connect to winner |
| Stale socket file on disk (POSIX) | Daemon probes via connect; on ECONNREFUSED, unlinks and retries bind |
| Daemon process dies while mcp-server is connected | mcp-server's socket emits `end`/`error`; pending requests reject with "daemon disconnected"; DaemonClient reconnects (which may respawn) |
| Auth handshake fails (`hello` HMAC mismatch) | Daemon closes the connection with an error frame; mcp-server logs fatal and exits 1 (config error) |
| Protocol version mismatch | Daemon closes with `protocol-version-mismatch`; mcp-server logs fatal and exits 1 |
| Firefox extension disconnects | Daemon stays up; pending requests time out with "Timed out waiting for response"; daemon records the disconnect; reconnect when extension comes back |
| Port 8089 held by something else when daemon starts | Daemon's existing retry/backoff (from resilience work); if all 5 attempts fail, daemon logs fatal and exits, then mcp-server's reconnect loop spawns a fresh daemon, which also fails — propagates "browser unreachable" up to the LLM |

## Concurrency

- All requests/responses are correlation-id keyed; ordering between concurrent clients is irrelevant.
- The daemon serializes WebSocket writes via the underlying `ws` library; we don't add explicit locking.
- Two clients calling the same extension command (e.g. `get-tab-list`) at the same instant get independent responses with their own correlationIds.

## Backwards Compatibility

- **Existing DXT install will continue to work after upgrade.** The mcp-server entry point (`dist/server.js`) becomes the thin client. The daemon script is bundled alongside (`dist/daemon.js`).
- **No new user-facing env vars are required.** `EXTENSION_SECRET` is still required and inherited by the spawned daemon.
- **Drop the old single-process mode.** Once this lands, there is no "legacy" mode. Rationale: keeping both adds complexity for no real benefit; the single-Claude case still works (one client, one daemon — daemon is just a thin extra hop).
- **Manifest** bumps to `1.7.0`. Tool list unchanged. The daemon binary is bundled in the same DXT.

## Security

- Socket file mode 0600 (POSIX) — only the same UID can connect.
- HMAC handshake using `EXTENSION_SECRET` — defense-in-depth; also guarantees all clients agree on the same secret the daemon registered with the extension.
- The daemon never accepts connections from non-localhost sources. The WebSocket server still binds `localhost` (or `0.0.0.0` if `CONTAINERIZED=1`, preserving the existing escape hatch).
- Daemon's IPC socket is never exposed beyond the local filesystem.

## Testing

Automated:
- `daemon/request-router.test.ts` — Node's built-in `node:test`: enqueue N requests, simulate responses arriving out of order, assert each Promise resolves with the right payload.
- `daemon/ipc-protocol.test.ts` — round-trip a hello + request + response through an in-process socket pair; assert auth rejection on bad HMAC.
- `mcp-server/daemon-client.test.ts` — start a stub daemon over a temporary socket; verify connect → request → response round-trip, plus reconnect on socket close.

Manual smoke:
1. Open Claude Desktop, run a `get-list-of-open-tabs` call → succeeds, daemon log shows the request.
2. Open a second Claude window (Claude Code in a terminal) running on the same machine; call the same tool simultaneously from both → both succeed, neither reports `EADDRINUSE`, daemon log shows two distinct `clientPid` values.
3. Quit Firefox → both clients' status tools show `wsConnected: false`; daemon stays up. Restart Firefox → next status call shows `wsConnected: true` again.
4. Kill the daemon process (`kill <pid>`) → next tool call from either client triggers a respawn; tool succeeds after ~1s.
5. Restart machine → fresh state; first Claude to launch spawns daemon; second uses it.

## Open Questions

None — defaults locked:
- IPC: NDJSON over Node `net` (UDS on POSIX, named pipe on Windows)
- Socket path: `~/.browser-control-mcp/sock` (or platform equivalent), env-overridable
- Daemon lifecycle: spawned on demand, stays alive after last client disconnect, no idle timeout
- Auth: HMAC-SHA256 handshake with `EXTENSION_SECRET`, plus 0600 socket file mode
- No legacy single-process mode after this lands
