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
        () => {
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
