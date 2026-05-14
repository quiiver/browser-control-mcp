import * as net from "node:net";
import * as crypto from "node:crypto";
import type {
  HelloFrame,
  IpcDaemonToClient,
  RequestFrame,
} from "@browser-control-mcp/common";
import type { ServerMessage, ExtensionMessage, DaemonStatus } from "@browser-control-mcp/common";
import { PROTOCOL_VERSION, computeHelloAuth } from "./daemon-handshake";
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
        sock.removeListener("data", listener);
        clearTimeout(timer);
        // Push the chunk back through the regular handler.
        this.onData(chunk);
        // Resolve optimistically. If hello was rejected, the daemon will
        // have written an error frame and closed the socket — pending
        // calls will reject via onSocketClose.
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
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(frame.error));
          this.pending.delete(id);
        }
      }
      return;
    }
    // hello-ack and status-response are handled by specific waiters; ignore here.
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

  async status(): Promise<DaemonStatus | null> {
    if (!this.socket || this.socket.destroyed) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      const listener = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const nl = text.indexOf("\n");
        if (nl < 0) return;
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
