# mcp-server Resilience & Observability — Design

**Date:** 2026-05-13
**Status:** Draft
**Scope:** `mcp-server/` (Node.js MCP server only)

## Problem

The mcp-server "keeps dying" with little visibility into why. Current code has several brittle spots:

- `process.exit(1)` on any init error, including transient ones like port-in-use (`server.ts:237-246`)
- No file logging — `console.error` goes to stderr and is consumed (and effectively hidden) by the MCP host
- `EXTENSION_RESPONSE_TIMEOUT_MS = 1000` rejects slow extension responses (`browser-api.ts:15`)
- No global `uncaughtException` / `unhandledRejection` handlers — any stray rejection in a tool path can take down the process
- `process.stdin.on("close")` exits immediately with no logging
- No health/status surface — when something is wrong, neither the LLM nor the user can see *what*

## Goals

1. **Observability** — every error, exit, and reconnection is captured to a persistent, rotating log file the user can read after the fact.
2. **Resilience** — transient failures (port-in-use, slow extension responses, stray rejections in tool paths) no longer kill the process.
3. **Diagnosability via MCP** — a new tool returns current server health so the user can ask Claude "what's wrong?" and get a useful answer without leaving the chat.

## Non-Goals

- External supervisor / wrapper script (the MCP host already respawns; revisit only if that turns out not to be true).
- Reworking the WebSocket protocol or the request/response correlation model.
- Changes to the Firefox extension.

## Architecture

Three additions to `mcp-server/`:

1. **`logger.ts`** — small file logger with rotation. Single exported object: `log.{error,warn,info,debug}(msg, meta?)`. No new dependencies.
2. **`health.ts`** — module-scoped mutable record of server health (`wsConnected`, `port`, `lastConnectionAt`, `lastErrorAt`, `lastErrorMessage`, `startedAt`, `logFilePath`). Updated from `browser-api.ts` and `server.ts`; read by the status tool.
3. **`browser-control-status` MCP tool** — registered in `server.ts`, returns the health record plus the resolved log file path.

Existing files updated:

- `server.ts` — global error handlers, replace `console.error`/`process.exit` paths with logger calls, register the status tool, gate exit on `stdin` close behind cleanup-with-logging.
- `browser-api.ts` — replace `console.error` with logger, update health record on connection/error events, retry init on transient failures, raise default response timeout to 5000ms.

## Components

### 1. Logger (`mcp-server/logger.ts`)

A minimal file-backed logger. No external dependency — `fs` only.

**Interface:**

```ts
export type LogLevel = "error" | "warn" | "info" | "debug";
export const log: {
  error(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  debug(msg: string, meta?: object): void;
  filePath(): string;
};
```

**Format:** one JSON object per line: `{"ts":"2026-05-13T20:14:00.123Z","level":"error","msg":"...","...meta":...}`. JSONL is grep-friendly and trivial to read back later.

**Configuration (env vars, all optional):**

- `LOG_LEVEL` — `error|warn|info|debug`, default `info`
- `LOG_FILE` — absolute path, default `~/.browser-control-mcp/logs/server.log`
- `LOG_MAX_BYTES` — default `5_000_000` (5MB)
- `LOG_MAX_FILES` — default `5`

**Rotation:** on each write, if the current file exceeds `LOG_MAX_BYTES`, rename `server.log` → `server.log.1`, shift `.1` → `.2`, etc., dropping anything past `LOG_MAX_FILES`. Synchronous rotation is fine — rotation is rare, and the server is low-volume.

**Failure mode:** if the log directory can't be created or the file can't be opened, the logger silently falls back to `console.error` only. We must never let logging break the server.

### 2. Health record (`mcp-server/health.ts`)

```ts
export interface Health {
  startedAt: string;          // ISO timestamp
  wsConnected: boolean;
  port: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
}
export const health: Health;
export function recordError(err: unknown): void;       // also logs
export function recordConnection(): void;
export function recordDisconnect(): void;
```

The health record is process-scoped state — fine as a module-level singleton. `recordError` both updates the record and writes a log entry, so callers don't have to do both.

### 3. Status tool

Registered in `server.ts` alongside the existing tools:

```ts
mcpServer.tool(
  "browser-control-status",
  "Get the health/status of the browser-control MCP server (use when tools are failing or you suspect the extension is disconnected)",
  {},
  async () => {
    return {
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
    };
  }
);
```

The description deliberately tells the LLM *when* to call it — so a user saying "is the browser thing working?" results in Claude calling status without prompting.

### 4. Resilient init in `browser-api.ts`

Split the existing `init()` into:

- `init()` — validates config, throws fatal errors *only* (missing `EXTENSION_SECRET`). These should still exit, because the user has to fix config.
- `start()` — starts the WebSocket server with retry on transient errors (`EADDRINUSE`, listener errors). Exponential backoff: `1s, 2s, 4s, 8s, 16s, 30s` capped, max 5 attempts. After max attempts, log fatal and rethrow.

WebSocket connection lifecycle gets explicit handlers:

```ts
this.wsServer.on("connection", (connection) => {
  recordConnection();
  this.ws = connection;
  connection.on("close", () => {
    recordDisconnect();
    if (this.ws === connection) this.ws = null;
  });
  connection.on("error", (err) => recordError(err));
  // ... existing message handler
});
this.wsServer.on("error", (err) => recordError(err));
```

**Timeout:** `EXTENSION_RESPONSE_TIMEOUT_MS` becomes `parseInt(process.env.EXTENSION_RESPONSE_TIMEOUT_MS) || 5000` (default raised from 1000 → 5000).

### 5. Global error handlers in `server.ts`

At top of `server.ts`, before tool registration:

```ts
process.on("uncaughtException", (err) => {
  recordError(err);
  // do not exit — let the host kill us if stdio breaks
});
process.on("unhandledRejection", (reason) => {
  recordError(reason);
});
```

Rationale: by the time a stray rejection bubbles up, the MCP request that triggered it has already been responded to (the SDK catches handler errors). Letting the process limp on is safer than killing it.

`process.stdin.on("close")` keeps `process.exit(0)` (this is the normal shutdown path when the host closes the pipe), but logs first:

```ts
process.stdin.on("close", () => {
  log.info("stdin closed; shutting down");
  browserApi.close();
  mcpServer.close();
  process.exit(0);
});
```

The original `browserApi.init().catch(... process.exit(1))` becomes:

```ts
browserApi.init()
  .then(() => browserApi.start())
  .catch((err) => {
    recordError(err);
    log.error("fatal init failure, exiting", { err: String(err) });
    process.exit(1);
  });
```

We still exit on truly fatal init failures (missing secret, port-in-use after all retries), but `recordError` ensures the log captures *why* first.

## Data Flow

```
[MCP host] --stdio--> [server.ts] --calls--> [browser-api.ts] --WS--> [extension]
                          |                         |
                          v                         v
                     [logger.ts] <----writes----- [health.ts]
                          |
                          v
                  ~/.browser-control-mcp/logs/server.log
```

The `browser-control-status` tool reads `health.ts` and returns its contents to the MCP host.

## Error Handling

| Failure                                | Before                | After                                              |
|----------------------------------------|-----------------------|----------------------------------------------------|
| Port in use                            | `exit(1)`             | Retry 5×, then `exit(1)` with logged reason        |
| `EXTENSION_SECRET` missing             | `exit(1)`, no log     | `exit(1)`, logged                                  |
| WebSocket connection drops             | Silent; `ws = null`-ish | Logged + recorded in health; server stays up    |
| Extension responds slowly (>1s)        | Tool returns timeout error | Default 5s; still surfaces timeout errors to LLM |
| Uncaught exception                     | Process dies          | Logged, process survives                           |
| Unhandled promise rejection            | Process dies (Node ≥15) | Logged, process survives                         |
| `stdin` close                          | Silent `exit(0)`      | Logged, then `exit(0)`                             |
| Log file can't be written              | n/a                   | Falls back to `console.error`; server unaffected   |

## Testing

The repo currently has Jest set up for the extension only (`firefox-extension/`), not for `mcp-server/`. Rather than stand up a full Jest config for the server, the design adds a small focused test for the logger (the only piece with non-trivial logic) and validates the rest by manual smoke test.

**Automated:**
- `mcp-server/logger.test.ts` using Node's built-in `node:test` runner (no new dev dependency): writes N log lines past `LOG_MAX_BYTES`, asserts rotation happened, parses output as JSONL, asserts level filtering.

**Manual smoke tests** (documented in the implementation plan):
1. Start server with no `EXTENSION_SECRET` → log file shows fatal entry; process exits 1.
2. Start server with port already in use → log shows retry attempts, then fatal.
3. Connect extension, then quit Firefox → log shows disconnect; server stays running; `browser-control-status` reflects `wsConnected: false`.
4. Reconnect Firefox → log shows reconnect; status flips back.
5. Call `browser-control-status` while everything is healthy → returns a sane health record.

## Backwards Compatibility

- All new env vars are optional with sensible defaults — existing DXT installs keep working.
- No changes to the WebSocket protocol or message shapes (`common/`).
- New status tool is additive; existing tools are unchanged.
- Manifest version bumps to `1.6.0`; tool list gains `browser-control-status`.

## Open Questions

None — all defaults locked from prior conversation:
- Log location: `~/.browser-control-mcp/logs/server.log`, 5MB × 5 files
- No new logger dependency
- Init retry: 5 attempts, 1s → 30s exponential
- Response timeout: 5000ms default, env-configurable
- Status tool returns the full health record
