# mcp-server Resilience & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mcp-server stop dying silently — capture every error to a rotating log file, survive transient failures and stray rejections, and expose a `browser-control-status` MCP tool so the user can diagnose problems from chat.

**Architecture:** Two new modules (`logger.ts`, `health.ts`) plus a new MCP tool. `server.ts` and `browser-api.ts` are modified to route errors through the logger, update the health record, retry transient init failures, and install global error handlers instead of letting the process die. No new runtime dependencies.

**Tech Stack:** Node.js ≥22, TypeScript (strict, CommonJS, ES2022), `@modelcontextprotocol/sdk`, `ws`. Tests use Node's built-in `node:test` runner (zero new dev deps). esbuild not involved — mcp-server uses `tsc`.

**Spec:** `docs/superpowers/specs/2026-05-13-mcp-server-resilience-design.md`

---

## File Map

**New:**
- `mcp-server/logger.ts` — JSONL file logger with size-based rotation, env-configurable
- `mcp-server/health.ts` — module-scoped health record + `record*` helpers
- `mcp-server/logger.test.ts` — Node `node:test` suite for the logger

**Modified:**
- `mcp-server/server.ts` — global error handlers, route errors to logger, register status tool, log on stdin close
- `mcp-server/browser-api.ts` — route errors to logger, update health record on connect/disconnect/error, retry transient WS bind failures, raise default response timeout
- `mcp-server/package.json` — bump version to `1.6.0`, add `test` script
- `mcp-server/manifest.json` — bump version to `1.6.0`, add `browser-control-status` tool entry

---

## Task 1: Logger module — write the failing test first

**Files:**
- Test: `mcp-server/logger.test.ts`

- [ ] **Step 1: Add the `test` script to `mcp-server/package.json`**

Open `mcp-server/package.json` and add a `test` entry under `scripts`. After this edit the `scripts` block should look like:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/server.js",
  "test": "tsc --noEmit && node --test --import tsx logger.test.ts",
  "pack-dxt": "npx @anthropic-ai/dxt pack"
}
```

Then add `tsx` as a devDependency so we can run TypeScript tests directly without building. Run:

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npm install --save-dev tsx
```

Expected: `tsx` is added to `devDependencies`. (`tsx` is a thin TS runner; we already have `typescript` for the `--noEmit` typecheck step.)

- [ ] **Step 2: Write the failing test file**

Create `mcp-server/logger.test.ts`:

```typescript
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bcm-logger-"));
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

test("writes JSONL lines at or above the configured level", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "warn";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");

  log.debug("should be filtered");
  log.info("should be filtered too");
  log.warn("a warning", { code: 42 });
  log.error("an error");

  const lines = readLines(logFile);
  assert.equal(lines.length, 2);

  const warn = JSON.parse(lines[0]);
  assert.equal(warn.level, "warn");
  assert.equal(warn.msg, "a warning");
  assert.equal(warn.code, 42);
  assert.match(warn.ts, /^\d{4}-\d{2}-\d{2}T/);

  const err = JSON.parse(lines[1]);
  assert.equal(err.level, "error");
  assert.equal(err.msg, "an error");
});

test("rotates when the log file exceeds LOG_MAX_BYTES", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "info";
  process.env.LOG_MAX_BYTES = "500";
  process.env.LOG_MAX_FILES = "3";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");

  for (let i = 0; i < 50; i++) {
    log.info("filler line padding padding padding padding padding", { i });
  }

  assert.ok(fs.existsSync(logFile), "current log file exists");
  assert.ok(fs.existsSync(logFile + ".1"), "rotated .1 exists");
  const sz = fs.statSync(logFile).size;
  assert.ok(sz <= 1500, `current file should be small after rotation, was ${sz}`);
});

test("falls back to console.error if log file path is unwritable", () => {
  process.env.LOG_FILE = "/this/path/does/not/exist/and/cannot/be/created/server.log";
  process.env.LOG_LEVEL = "info";
  delete require.cache[require.resolve("./logger")];

  const origErr = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => { captured.push(args); };
  try {
    const { log } = require("./logger");
    log.error("boom");
  } finally {
    console.error = origErr;
  }
  assert.ok(captured.length >= 1, "console.error called as fallback");
});

test("filePath() returns the resolved log file path", () => {
  const dir = freshTmpDir();
  const logFile = path.join(dir, "server.log");
  process.env.LOG_FILE = logFile;
  process.env.LOG_LEVEL = "info";
  delete require.cache[require.resolve("./logger")];
  const { log } = require("./logger");
  assert.equal(log.filePath(), logFile);
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run:

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npm test
```

Expected: FAIL — `Cannot find module './logger'` (the module doesn't exist yet).

---

## Task 2: Logger module — implementation

**Files:**
- Create: `mcp-server/logger.ts`

- [ ] **Step 1: Implement `logger.ts`**

Create `mcp-server/logger.ts` with the full implementation:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLogFile(): string {
  if (process.env.LOG_FILE) return process.env.LOG_FILE;
  return path.join(os.homedir(), ".browser-control-mcp", "logs", "server.log");
}

function resolveLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (v === "error" || v === "warn" || v === "info" || v === "debug") return v;
  return "info";
}

function resolveInt(envName: string, fallback: number): number {
  const v = process.env[envName];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOG_FILE = resolveLogFile();
const LOG_LEVEL = resolveLevel();
const LOG_MAX_BYTES = resolveInt("LOG_MAX_BYTES", 5_000_000);
const LOG_MAX_FILES = resolveInt("LOG_MAX_FILES", 5);

let fileUsable = true;
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch (err) {
  fileUsable = false;
  console.error("logger: could not create log dir, falling back to console", err);
}

function rotateIfNeeded() {
  if (!fileUsable) return;
  let size = 0;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return;
  }
  if (size < LOG_MAX_BYTES) return;

  for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
    const src = `${LOG_FILE}.${i}`;
    const dst = `${LOG_FILE}.${i + 1}`;
    if (fs.existsSync(src)) {
      try {
        if (i + 1 > LOG_MAX_FILES) fs.unlinkSync(src);
        else fs.renameSync(src, dst);
      } catch {
        // ignore — best-effort rotation
      }
    }
  }
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // ignore
  }
}

function write(level: LogLevel, msg: string, meta?: object) {
  if (LEVEL_RANK[level] > LEVEL_RANK[LOG_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  const line = JSON.stringify(entry) + "\n";

  if (!fileUsable) {
    console.error(line.trimEnd());
    return;
  }
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    fileUsable = false;
    console.error("logger: write failed, falling back to console", err);
    console.error(line.trimEnd());
  }
}

export const log = {
  error: (msg: string, meta?: object) => write("error", msg, meta),
  warn: (msg: string, meta?: object) => write("warn", msg, meta),
  info: (msg: string, meta?: object) => write("info", msg, meta),
  debug: (msg: string, meta?: object) => write("debug", msg, meta),
  filePath: () => LOG_FILE,
};
```

- [ ] **Step 2: Run tests, verify they pass**

Run:

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npm test
```

Expected: PASS on all four tests. If the `tsc --noEmit` step fails, fix the type error before proceeding.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/logger.ts mcp-server/logger.test.ts mcp-server/package.json mcp-server/package-lock.json
git commit -m "$(cat <<'EOF'
Add JSONL file logger with size-based rotation

New logger module writes structured JSON lines to a rotating file
(default ~/.browser-control-mcp/logs/server.log), configurable via
LOG_FILE/LOG_LEVEL/LOG_MAX_BYTES/LOG_MAX_FILES env vars. Falls back
to console.error if the log path is unwritable so logging can never
break the server. Tests use Node's built-in test runner via tsx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Health record module

**Files:**
- Create: `mcp-server/health.ts`

- [ ] **Step 1: Implement `health.ts`**

Create `mcp-server/health.ts`:

```typescript
import { log } from "./logger";

export interface Health {
  startedAt: string;
  wsConnected: boolean;
  port: number | null;
  lastConnectionAt: string | null;
  lastDisconnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  logFilePath: string;
}

export const health: Health = {
  startedAt: new Date().toISOString(),
  wsConnected: false,
  port: null,
  lastConnectionAt: null,
  lastDisconnectAt: null,
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

export function recordConnection(port: number): void {
  health.wsConnected = true;
  health.port = port;
  health.lastConnectionAt = new Date().toISOString();
  log.info("websocket connection established", { port });
}

export function recordDisconnect(): void {
  health.wsConnected = false;
  health.lastDisconnectAt = new Date().toISOString();
  log.info("websocket connection closed");
}

export function recordPort(port: number): void {
  health.port = port;
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/health.ts
git commit -m "$(cat <<'EOF'
Add health record module for mcp-server diagnostics

Process-scoped mutable record of server health (ws connected, port,
last connection/disconnect/error timestamps, log path). recordError
both updates the record and writes a log entry so callers don't have
to do both. Consumed by browser-api wiring and the upcoming
browser-control-status MCP tool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `browser-api.ts` to logger + health, add init retry, raise timeout

**Files:**
- Modify: `mcp-server/browser-api.ts`

- [ ] **Step 1: Replace the file contents**

This is a substantial rewrite — easier to overwrite the file than to chain Edits. Replace `mcp-server/browser-api.ts` with:

```typescript
import WebSocket from "ws";
import type {
  ExtensionMessage,
  BrowserTab,
  BrowserHistoryItem,
  ServerMessage,
  TabContentExtensionMessage,
  ServerMessageRequest,
  ExtensionError,
} from "@browser-control-mcp/common";
import * as crypto from "crypto";
import { log } from "./logger";
import { recordConnection, recordDisconnect, recordError, recordPort } from "./health";

const WS_DEFAULT_PORT = 8089;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
const MAX_BIND_ATTEMPTS = 5;
const BIND_BACKOFFS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function responseTimeoutMs(): number {
  const v = process.env.EXTENSION_RESPONSE_TIMEOUT_MS;
  if (!v) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESPONSE_TIMEOUT_MS;
}

interface ExtensionRequestResolver<T extends ExtensionMessage["resource"]> {
  resource: T;
  resolve: (value: Extract<ExtensionMessage, { resource: T }>) => void;
  reject: (reason?: string) => void;
}

export class BrowserAPI {
  private ws: WebSocket | null = null;
  private wsServer: WebSocket.Server | null = null;
  private sharedSecret: string | null = null;
  private port: number = WS_DEFAULT_PORT;

  private extensionRequestMap: Map<
    string,
    ExtensionRequestResolver<ExtensionMessage["resource"]>
  > = new Map();

  async init() {
    const { secret, port } = readConfig();
    if (!secret) {
      throw new Error(
        "EXTENSION_SECRET env var missing. See the extension's options page."
      );
    }
    this.sharedSecret = secret;
    this.port = port;
    recordPort(port);
  }

  async start() {
    const host = process.env.CONTAINERIZED ? "0.0.0.0" : "localhost";

    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      try {
        await this.bind(host, this.port);
        log.info("websocket server listening", { host, port: this.port });
        return;
      } catch (err) {
        recordError(err);
        const isTransient = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
        const isLast = attempt === MAX_BIND_ATTEMPTS - 1;
        if (!isTransient || isLast) {
          log.error("websocket bind failed permanently", {
            attempt: attempt + 1,
            err: String(err),
          });
          throw err;
        }
        const backoff = BIND_BACKOFFS_MS[Math.min(attempt, BIND_BACKOFFS_MS.length - 1)];
        log.warn("websocket bind failed, retrying", {
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
      recordConnection(port);

      connection.on("close", () => {
        if (this.ws === connection) this.ws = null;
        recordDisconnect();
      });
      connection.on("error", (err) => recordError(err));

      connection.on("message", (message) => {
        try {
          const decoded = JSON.parse(message.toString());
          if (isErrorMessage(decoded)) {
            this.handleExtensionError(decoded);
            return;
          }
          const signature = this.createSignature(JSON.stringify(decoded.payload));
          if (signature !== decoded.signature) {
            log.warn("invalid message signature from extension");
            return;
          }
          this.handleDecodedExtensionMessage(decoded.payload);
        } catch (err) {
          recordError(err);
        }
      });
    });
    server.on("error", (err) => recordError(err));
  }

  close() {
    this.wsServer?.close();
  }

  getSelectedPort() {
    return this.wsServer?.options.port;
  }

  async openTab(url: string): Promise<number | undefined> {
    const correlationId = this.sendMessageToExtension({
      cmd: "open-tab",
      url,
    });
    const message = await this.waitForResponse(correlationId, "opened-tab-id");
    return message.tabId;
  }

  async closeTabs(tabIds: number[]) {
    const correlationId = this.sendMessageToExtension({
      cmd: "close-tabs",
      tabIds,
    });
    await this.waitForResponse(correlationId, "tabs-closed");
  }

  async getTabList(): Promise<BrowserTab[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-tab-list",
    });
    const message = await this.waitForResponse(correlationId, "tabs");
    return message.tabs;
  }

  async getBrowserRecentHistory(
    searchQuery?: string
  ): Promise<BrowserHistoryItem[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-browser-recent-history",
      searchQuery,
    });
    const message = await this.waitForResponse(correlationId, "history");
    return message.historyItems;
  }

  async getTabContent(
    tabId: number,
    offset: number
  ): Promise<TabContentExtensionMessage> {
    const correlationId = this.sendMessageToExtension({
      cmd: "get-tab-content",
      tabId,
      offset,
    });
    return await this.waitForResponse(correlationId, "tab-content");
  }

  async reorderTabs(tabOrder: number[]): Promise<number[]> {
    const correlationId = this.sendMessageToExtension({
      cmd: "reorder-tabs",
      tabOrder,
    });
    const message = await this.waitForResponse(correlationId, "tabs-reordered");
    return message.tabOrder;
  }

  async findHighlight(tabId: number, queryPhrase: string): Promise<number> {
    const correlationId = this.sendMessageToExtension({
      cmd: "find-highlight",
      tabId,
      queryPhrase,
    });
    const message = await this.waitForResponse(
      correlationId,
      "find-highlight-result"
    );
    return message.noOfResults;
  }

  async groupTabs(
    tabIds: number[],
    isCollapsed: boolean,
    groupColor: string,
    groupTitle: string
  ): Promise<number> {
    const correlationId = this.sendMessageToExtension({
      cmd: "group-tabs",
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle,
    });
    const message = await this.waitForResponse(correlationId, "new-tab-group");
    return message.groupId;
  }

  private createSignature(payload: string): string {
    if (!this.sharedSecret) {
      throw new Error("Shared secret not initialized");
    }
    const hmac = crypto.createHmac("sha256", this.sharedSecret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  private sendMessageToExtension(message: ServerMessage): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    const correlationId = Math.random().toString(36).substring(2);
    const req: ServerMessageRequest = { ...message, correlationId };
    const payload = JSON.stringify(req);
    const signature = this.createSignature(payload);
    const signedMessage = {
      payload: req,
      signature: signature,
    };

    this.ws.send(JSON.stringify(signedMessage));

    return correlationId;
  }

  private handleDecodedExtensionMessage(decoded: ExtensionMessage) {
    const { correlationId } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      log.warn("received extension message with unknown correlationId", { correlationId });
      return;
    }
    if (entry.resource !== decoded.resource) {
      log.warn("resource mismatch on extension reply", {
        expected: entry.resource,
        got: decoded.resource,
      });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    entry.resolve(decoded);
  }

  private handleExtensionError(decoded: ExtensionError) {
    const { correlationId, errorMessage } = decoded;
    const entry = this.extensionRequestMap.get(correlationId);
    if (!entry) {
      log.warn("received extension error with unknown correlationId", { correlationId });
      return;
    }
    this.extensionRequestMap.delete(correlationId);
    entry.reject(errorMessage);
  }

  private async waitForResponse<T extends ExtensionMessage["resource"]>(
    correlationId: string,
    resource: T
  ): Promise<Extract<ExtensionMessage, { resource: T }>> {
    return new Promise<Extract<ExtensionMessage, { resource: T }>>(
      (resolve, reject) => {
        this.extensionRequestMap.set(correlationId, {
          resolve: resolve as (value: ExtensionMessage) => void,
          resource,
          reject,
        });
        setTimeout(() => {
          this.extensionRequestMap.delete(correlationId);
          reject("Timed out waiting for response");
        }, responseTimeoutMs());
      }
    );
  }
}

function readConfig() {
  return {
    secret: process.env.EXTENSION_SECRET,
    port: process.env.EXTENSION_PORT
      ? parseInt(process.env.EXTENSION_PORT, 10)
      : WS_DEFAULT_PORT,
  };
}

export function isErrorMessage(message: any): message is ExtensionError {
  return (
    message.errorMessage !== undefined && message.correlationId !== undefined
  );
}
```

Key changes vs the original:
- `init()` no longer binds — it only validates config and stores port/secret.
- New `start()` does the actual WebSocket bind with retry on `EADDRINUSE`.
- `bind()` is a helper that wraps the WebSocket.Server in a promise that resolves on `listening` and rejects on `error` (so we can catch bind failures instead of crashing).
- `attachServerHandlers()` wires connection-level `close`/`error` handlers and routes everything through `recordError` / `recordConnection` / `recordDisconnect`.
- Message parsing is wrapped in try/catch so bad payloads don't crash the process.
- `handleDecodedExtensionMessage` / `handleExtensionError` no longer assume the map entry exists (the original code did `.get(...)!` which would NPE on stale correlationIds).
- Response timeout is read from env each time (default 5000ms instead of 1000ms).
- `isPortInUse` precheck is gone — the new `start()` retry loop subsumes it. (`util.ts` can stay; we may still want it later.)

- [ ] **Step 2: Typecheck**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/browser-api.ts
git commit -m "$(cat <<'EOF'
Route browser-api errors through logger + retry transient WS binds

Splits init() into init()+start(): init validates config (still fatal
on missing EXTENSION_SECRET), start() binds the WebSocket server with
exponential backoff on EADDRINUSE (5 attempts, 1s-30s). Wires
connection lifecycle (connect/close/error) through health.ts so the
status tool can see what's going on. Message parsing is now wrapped
in try/catch and stale correlationIds no longer NPE. Default
response timeout raised 1000ms -> 5000ms (env-configurable).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update `server.ts` — global handlers, status tool, logger wiring

**Files:**
- Modify: `mcp-server/server.ts`

- [ ] **Step 1: Replace `server.ts`**

Replace `mcp-server/server.ts` with the version below. The tool definitions are unchanged from the original — only the surrounding bootstrap and the new `browser-control-status` tool are different.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserAPI } from "./browser-api";
import { log } from "./logger";
import { health, recordError } from "./health";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

process.on("uncaughtException", (err) => {
  recordError(err);
});
process.on("unhandledRejection", (reason) => {
  recordError(reason);
});

log.info("mcp-server starting", { version: "1.6.0", pid: process.pid });

const mcpServer = new McpServer({
  name: "BrowserControl",
  version: "1.6.0",
});

mcpServer.tool(
  "open-browser-tab",
  "Open a new tab in the user's browser (useful when the user asks to open a website)",
  { url: z.string() },
  async ({ url }) => {
    const openedTabId = await browserApi.openTab(url);
    if (openedTabId !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${url} opened in tab id ${openedTabId}`,
          },
        ],
      };
    } else {
      return {
        content: [{ type: "text", text: "Failed to open tab", isError: true }],
      };
    }
  }
);

mcpServer.tool(
  "close-browser-tabs",
  "Close tabs in the user's browser by tab IDs",
  { tabIds: z.array(z.number()) },
  async ({ tabIds }) => {
    await browserApi.closeTabs(tabIds);
    return {
      content: [{ type: "text", text: "Closed tabs" }],
    };
  }
);

mcpServer.tool(
  "get-list-of-open-tabs",
  "Get the list of open tabs in the user's browser. Use offset and limit parameters for pagination when there are many tabs.",
  {
    offset: z.number().int().min(0).default(0).describe("Starting index for pagination (0-based, must be >= 0)"),
    limit: z.number().default(100).describe("Maximum number of tabs to return (default: 100, max: 500)"),
  },
  async ({ offset, limit }) => {
    const effectiveLimit = Math.min(Math.max(1, limit), 500);

    const openTabs = await browserApi.getTabList();
    const totalTabs = openTabs.length;

    const paginatedTabs = openTabs.slice(offset, offset + effectiveLimit);
    const hasMore = offset + effectiveLimit < totalTabs;

    const paginationInfo = {
      type: "text" as const,
      text: `Showing tabs ${offset + 1}-${offset + paginatedTabs.length} of ${totalTabs} total tabs${hasMore ? ` (use offset=${offset + effectiveLimit} to see more)` : ''}`,
    };

    const tabContent = paginatedTabs.map((tab) => {
      let lastAccessed = "unknown";
      if (tab.lastAccessed) {
        lastAccessed = dayjs(tab.lastAccessed).fromNow();
      }
      return {
        type: "text" as const,
        text: `tab id=${tab.id}, tab url=${tab.url}, tab title=${tab.title}, last accessed=${lastAccessed}`,
      };
    });

    return {
      content: [paginationInfo, ...tabContent],
    };
  }
);

mcpServer.tool(
  "get-recent-browser-history",
  "Get the list of recent browser history (to get all, don't use searchQuery)",
  { searchQuery: z.string().optional() },
  async ({ searchQuery }) => {
    const browserHistory = await browserApi.getBrowserRecentHistory(
      searchQuery
    );
    if (browserHistory.length > 0) {
      return {
        content: browserHistory.map((item) => {
          let lastVisited = "unknown";
          if (item.lastVisitTime) {
            lastVisited = dayjs(item.lastVisitTime).fromNow();
          }
          return {
            type: "text",
            text: `url=${item.url}, title="${item.title}", lastVisitTime=${lastVisited}`,
          };
        }),
      };
    } else {
      const hint = searchQuery ? "Try without a searchQuery" : "";
      return { content: [{ type: "text", text: `No history found. ${hint}` }] };
    }
  }
);

mcpServer.tool(
  "get-tab-web-content",
  `
    Get the full text content of the webpage and the list of links in the webpage, by tab ID. 
    Use "offset" only for larger documents when the first call was truncated and if you require more content in order to assist the user.
  `,
  { tabId: z.number(), offset: z.number().default(0) },
  async ({ tabId, offset }) => {
    const content = await browserApi.getTabContent(tabId, offset);
    let links: { type: "text"; text: string }[] = [];
    if (offset === 0) {
      links = content.links.map((link: { text: string; url: string }) => {
        return {
          type: "text",
          text: `Link text: ${link.text}, Link URL: ${link.url}`,
        };
      });
    }

    let text = content.fullText;
    let hint: { type: "text"; text: string }[] = [];
    if (content.isTruncated || offset > 0) {
      const rangeString = `${offset}-${offset + text.length}`;
      hint = [
        {
          type: "text",
          text:
            `The following text content is truncated due to size (includes character range ${rangeString} out of ${content.totalLength}). ` +
            "If you want to read characters beyond this range, please use the 'get-tab-web-content' tool with an offset. ",
        },
      ];
    }

    return {
      content: [...hint, { type: "text", text }, ...links],
    };
  }
);

mcpServer.tool(
  "reorder-browser-tabs",
  "Change the order of open browser tabs",
  { tabOrder: z.array(z.number()) },
  async ({ tabOrder }) => {
    const newOrder = await browserApi.reorderTabs(tabOrder);
    return {
      content: [
        { type: "text", text: `Tabs reordered: ${newOrder.join(", ")}` },
      ],
    };
  }
);

mcpServer.tool(
  "find-highlight-in-browser-tab",
  "Find and highlight text in a browser tab (use a query phrase that exists in the web content)",
  { tabId: z.number(), queryPhrase: z.string() },
  async ({ tabId, queryPhrase }) => {
    const noOfResults = await browserApi.findHighlight(tabId, queryPhrase);
    return {
      content: [
        {
          type: "text",
          text: `Number of results found and highlighted in the tab: ${noOfResults}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "group-browser-tabs",
  "Organize opened browser tabs in a new tab group",
  {
    tabIds: z.array(z.number()),
    isCollapsed: z.boolean().default(false),
    groupColor: z
      .enum([
        "grey",
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ])
      .default("grey"),
    groupTitle: z.string().default("New Group"),
  },
  async ({ tabIds, isCollapsed, groupColor, groupTitle }) => {
    const groupId = await browserApi.groupTabs(
      tabIds,
      isCollapsed,
      groupColor,
      groupTitle
    );
    return {
      content: [
        {
          type: "text",
          text: `Created tab group "${groupTitle}" with ${tabIds.length} tabs (group ID: ${groupId})`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "browser-control-status",
  "Get the health/status of the browser-control MCP server. Use this when other browser-control tools are failing, when you suspect the Firefox extension is disconnected, or when the user asks whether the browser integration is working. Returns ws connection state, port, last connection/disconnect/error timestamps, and the log file path.",
  {},
  async () => {
    return {
      content: [{ type: "text", text: JSON.stringify(health, null, 2) }],
    };
  }
);

const browserApi = new BrowserAPI();
browserApi
  .init()
  .then(() => browserApi.start())
  .catch((err) => {
    recordError(err);
    log.error("fatal init failure, exiting", { err: String(err) });
    process.exit(1);
  });

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((err) => {
  recordError(err);
  log.error("mcp transport connect failed, exiting", { err: String(err) });
  process.exit(1);
});

process.stdin.on("close", () => {
  log.info("stdin closed; shutting down");
  browserApi.close();
  mcpServer.close();
  process.exit(0);
});
```

- [ ] **Step 2: Typecheck and build**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npx tsc --noEmit
npm run build
```

Expected: both succeed with no errors. `dist/server.js` is produced.

- [ ] **Step 3: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/server.ts
git commit -m "$(cat <<'EOF'
Wire mcp-server bootstrap to logger, health, and resilient init

- Install uncaughtException/unhandledRejection handlers that log
  instead of letting the process die.
- Route init/connect failures through recordError so the log file
  captures why before any exit.
- Add browser-control-status MCP tool returning the health record so
  the user can ask Claude "is the browser thing working?" in chat.
- Log on stdin close before exiting (was silent before).
- Split bootstrap into init() -> start() so EADDRINUSE retries work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manifest and version bumps

**Files:**
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/manifest.json`

- [ ] **Step 1: Bump `package.json` version**

Edit `mcp-server/package.json` and change `"version": "1.5.1"` to `"version": "1.6.0"`.

- [ ] **Step 2: Bump `manifest.json` version and add status tool**

In `mcp-server/manifest.json`:

1. Change `"version": "1.5.1"` to `"version": "1.6.0"` (top level).
2. Add this entry to the `tools` array (append at the end):

```json
{
  "name": "browser-control-status",
  "description": "Get the health/status of the browser-control MCP server"
}
```

- [ ] **Step 3: Rebuild and pack-dxt smoke check**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
npm run build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
cd /Users/wstuckey/dev/browser-control-mcp
git add mcp-server/package.json mcp-server/manifest.json
git commit -m "$(cat <<'EOF'
Bump mcp-server to 1.6.0 and register browser-control-status tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual smoke tests

**Files:** none — verification only.

These are run-by-hand checks. Capture results in a scratch note; do not commit logs.

- [ ] **Smoke 1: Missing secret → logs fatal, exits 1**

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
unset EXTENSION_SECRET
LOG_FILE=/tmp/bcm-smoke.log node dist/server.js
echo "exit=$?"
cat /tmp/bcm-smoke.log
```

Expected: process exits with status 1. `/tmp/bcm-smoke.log` contains a `"level":"error"` line whose `msg` mentions `EXTENSION_SECRET env var missing`.

- [ ] **Smoke 2: Port in use → retries logged, then fatal**

In one terminal:

```bash
python3 -m http.server 8089
```

In another:

```bash
cd /Users/wstuckey/dev/browser-control-mcp/mcp-server
EXTENSION_SECRET=test LOG_FILE=/tmp/bcm-smoke2.log node dist/server.js
echo "exit=$?"
cat /tmp/bcm-smoke2.log
```

Expected: process logs ≥4 `"websocket bind failed, retrying"` warn lines before a final error and `exit=1`. Then stop the python server.

- [ ] **Smoke 3: Status tool reports disconnected state at startup**

Reinstall the DXT (`npm run pack-dxt` then re-add to Claude Desktop, or update the local mcp config to point at `dist/server.js` directly). Restart Claude Desktop. In a chat, ask:

> Use the browser-control-status tool to report the server health.

Expected: returns JSON with `wsConnected: false` (assuming Firefox extension not yet connected), a valid `logFilePath`, and `port: 8089`.

- [ ] **Smoke 4: Connect Firefox → status flips to connected**

Open Firefox with the extension installed and the matching secret. Re-ask:

> Use the browser-control-status tool.

Expected: `wsConnected: true`, `lastConnectionAt` is recent.

- [ ] **Smoke 5: Disconnect → status flips back, server survives**

Quit Firefox. Re-ask the status tool.

Expected: `wsConnected: false`, `lastDisconnectAt` is recent, server process is still alive (otherwise the tool call itself would have failed).

- [ ] **Smoke 6: Log file location is what the spec promised**

```bash
ls -la ~/.browser-control-mcp/logs/server.log
tail -20 ~/.browser-control-mcp/logs/server.log
```

Expected: file exists, tail shows recent JSONL entries from the smoke runs above.

---

## Self-Review Notes

- All 8 sections of the spec map to tasks: logger → Tasks 1-2; health record → Task 3; resilient init + connection lifecycle + timeout → Task 4; global handlers + status tool + stdin logging + exit-with-log → Task 5; manifest/version → Task 6; testing (auto + manual) → Tasks 1-2 + Task 7.
- Types referenced across tasks are consistent: `Health` interface defined in Task 3, consumed by Task 5; `recordError`/`recordConnection`/`recordDisconnect`/`recordPort` defined in Task 3, used in Task 4 and Task 5.
- No `TODO`/`TBD`/placeholder text. Every code step contains the actual code.
- The original `util.ts` (`isPortInUse`) becomes unused after Task 4; left in place since deleting it is unrelated cleanup.
